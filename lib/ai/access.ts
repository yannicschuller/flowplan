// What the AI may read: the one place that decides whether content goes
// into a prompt. Every AI feature checks with aiMayRead / aiFilter /
// requireAiRead before it puts a page, a record or a search result into a
// prompt – also for the text a person selected in the editor.
//
// A page (and every record of a database page) is readable for the AI when
//   1. the person may read it (page permissions, record access),
//   2. it is not in the trash (nor any page above it, nor its space),
//   3. it is not inside a journal protected with a PIN – even while unlocked,
//      nor in an end-to-end encrypted space (lib/e2ee-server.ts),
//   4. no manager marked it, a page above it or its space "Für KI gesperrt"
//      (ai_blocks) – this beats every personal rule,
//   5. the person's own rules allow it: the closest rule wins
//      (page → parent pages → space → workspace), an exclusion beats an
//      inclusion on the same level; without a rule, scope "all" allows and
//      scope "selected" excludes.
// For Apple's on-device model in the apps (lib/ai/device.ts) the same
// rules apply but 3. only in part: end-to-end encrypted spaces are open to
// it – the decrypted text never leaves the device.
import { z } from "zod";
import { HttpError } from "../auth";
import { all, audit, one, run } from "../db";
import { memberRole, pageRole, requirePage, spaceRole } from "../permissions";
import { canSharePage } from "../page-share";
import { rowRoleResolver } from "../row-access";
import { canManageSpace } from "../workspace-lifecycle";
import type { Identity, Page, Space } from "../types";
import { assertSettingsCaller, userAiSettings } from "./settings";
import { filterAsync, mapAsync } from "../each-async";

export type AiTarget = { pageId: string; rowId?: string | null };
type PageLite = { id: string; workspace_id: string; space_id: string; parent_id: string | null; deleted_at: string | null; kind: string };

export const AI_BLOCKED_MESSAGE = "Diese Seite ist für die KI gesperrt.";

// Everything needed to judge many pages of one person at once.
class AccessContext {
  private pages = new Map<string, PageLite | null>();
  private workspaces = new Map<string, { spaces: Map<string, { deleted: boolean; encrypted: boolean }>; pinned: Set<string> }>();
  private rules: Map<string, "include" | "exclude">;
  // Every block by its target, whatever workspace the row names: a block
  // follows a page that moves to another workspace.
  private blocks = allAiBlocks();
  private scope: "all" | "selected";
  private roles = new Map<string, boolean>();
  constructor(
    private user: Identity,
    // On-device AI: end-to-end encrypted spaces are readable.
    private device = false,
  ) {
    this.rules = new Map(
      all<{ target_id: string; mode: "include" | "exclude" }>("SELECT target_id,mode FROM ai_access_rules WHERE user_id=?", user.id).map((r) => [r.target_id, r.mode]),
    );
    this.scope = userAiSettings(user.id).scope;
  }
  private async workspace(id: string) {
    let entry = this.workspaces.get(id);
    if (entry) return entry;
    for (const p of await all<PageLite>("SELECT id,workspace_id,space_id,parent_id,deleted_at,kind FROM pages WHERE workspace_id=?", id)) this.pages.set(p.id, p);
    entry = {
      spaces: new Map(
        (await all<{ id: string; deleted_at: string | null; encrypted: number }>("SELECT id,deleted_at,encrypted FROM spaces WHERE workspace_id=?", id)).map((s) => [
          s.id,
          { deleted: !!s.deleted_at, encrypted: !!s.encrypted },
        ]),
      ),
      pinned: new Set(
        (await all<{ page_id: string }>("SELECT s.page_id FROM journal_settings s JOIN pages p ON p.id=s.page_id WHERE p.workspace_id=? AND s.lock_hash IS NOT NULL", id)).map((r) => r.page_id),
      ),
    };
    this.workspaces.set(id, entry);
    return entry;
  }
  async page(id: string): Promise<PageLite | null> {
    if (!this.pages.has(id)) {
      const p = await one<PageLite>("SELECT id,workspace_id,space_id,parent_id,deleted_at,kind FROM pages WHERE id=?", id) || null;
      if (p) await this.workspace(p.workspace_id);
      if (!this.pages.has(id)) this.pages.set(id, p);
    }
    return this.pages.get(id) || null;
  }
  private async visible(page: PageLite) {
    let known = this.roles.get(page.id);
    if (known === undefined) {
      const full = await one<Page>("SELECT * FROM pages WHERE id=?", page.id);
      known = !!full && !!(await pageRole(this.user, full));
      this.roles.set(page.id, known);
    }
    return known;
  }
  markVisible(ids: Iterable<string>) {
    for (const id of ids) this.roles.set(id, true);
  }
  // Why a page is not readable for the AI, or null when it is.
  async pageVerdict(id: string): Promise<"missing" | "hidden" | "trash" | "pin" | "blocked" | "excluded" | null> {
    const page = await this.page(id);
    if (!page) return "missing";
    const ws = await this.workspace(page.workspace_id);
    const space = ws.spaces.get(page.space_id);
    if (page.deleted_at || !space || space.deleted) return "trash";
    if (!(await this.visible(page))) return "hidden";
    // End-to-end encrypted: the server has no plaintext to give the AI.
    if (space.encrypted && !this.device) return "blocked";
    if (this.blocks.has(page.space_id)) return "blocked";
    // The page and everything above it.
    const chain: PageLite[] = [];
    const seen = new Set<string>();
    for (let current: PageLite | null = page; current; current = current.parent_id ? (await this.page(current.parent_id)) : null) {
      if (seen.has(current.id) || chain.length > 256) return "hidden";
      seen.add(current.id);
      chain.push(current);
    }
    for (const p of chain) {
      if (p.deleted_at) return "trash";
      if (ws.pinned.has(p.id)) return "pin";
      if (this.blocks.has(p.id)) return "blocked";
    }
    for (const level of [...chain.map((p) => p.id), page.space_id, page.workspace_id]) {
      const rule = this.rules.get(level);
      if (rule) return rule === "exclude" ? "excluded" : null;
    }
    return this.scope === "all" ? null : "excluded";
  }
  // Records: the database page must be readable, and the record visible.
  async rowsReadable(pageId: string, rowIds: string[]): Promise<Set<string>> {
    if ((await this.pageVerdict(pageId)) !== null) return new Set();
    const page = await one<Page>("SELECT * FROM pages WHERE id=?", pageId);
    if (!page || page.kind !== "database") return new Set();
    const resolve = await rowRoleResolver(this.user, page);
    const ok = new Set<string>();
    for (let i = 0; i < rowIds.length; i += 500) {
      const chunk = rowIds.slice(i, i + 500);
      for (const row of await all<{ id: string; access: string; created_by: string | null }>(
        `SELECT id,access,created_by FROM rows WHERE page_id=? AND id IN (${chunk.map(() => "?").join(",")})`,
        pageId,
        ...chunk,
      ))
        if (resolve(row as never)) ok.add(row.id);
    }
    return ok;
  }
}

// Whether the AI may read this page (or this record of it) for this person.
export async function aiMayRead(user: Identity, pageId: string, rowId?: string | null): Promise<boolean> {
  return (await aiFilter(user, [{ pageId, rowId }])).length === 1;
}

// The items the AI may read, in their order (many pages and records at once).
export async function aiFilter<T extends AiTarget>(user: Identity, items: T[]): Promise<T[]> {
  if (!items.length) return [];
  const context = new AccessContext(user);
  const rowsByPage = new Map<string, string[]>();
  for (const item of items) if (item.rowId) rowsByPage.set(item.pageId, [...(rowsByPage.get(item.pageId) || []), item.rowId]);
  const readableRows = new Map<string, Set<string>>();
  for (const [pageId, rowIds] of rowsByPage) readableRows.set(pageId, await context.rowsReadable(pageId, [...new Set(rowIds)]));
  const pageOk = new Map<string, boolean>();
  return await filterAsync(items, async (item) => {
    if (item.rowId) return !!readableRows.get(item.pageId)?.has(item.rowId);
    if (!pageOk.has(item.pageId)) pageOk.set(item.pageId, (await context.pageVerdict(item.pageId)) === null);
    return pageOk.get(item.pageId)!;
  });
}

// Page ids the AI may read.
export async function aiReadablePages(user: Identity, pageIds: string[]): Promise<Set<string>> {
  return new Set((await aiFilter(user, pageIds.map((pageId) => ({ pageId })))).map((i) => i.pageId));
}

// For features: refuse before anything of the page reaches a prompt.
export async function requireAiRead(user: Identity, pageId: string, rowId?: string | null) {
  if (!(await aiMayRead(user, pageId, rowId))) throw new HttpError(403, AI_BLOCKED_MESSAGE);
}

// Pages of a workspace the person sees but the AI may not read (bootstrap:
// the interface shows "KI hat keinen Zugriff" and disables AI buttons).
export async function aiExcludedPages(user: Identity, visiblePages: { id: string }[]): Promise<string[]> {
  if (!visiblePages.length) return [];
  const context = new AccessContext(user);
  context.markVisible(visiblePages.map((p) => p.id));
  return (await filterAsync(visiblePages, async (p) => (await context.pageVerdict(p.id)) !== null)).map((p) => p.id);
}

// The same for the on-device model: only what is closed to it as well
// (encrypted spaces are not). Checks only the given pages again – those the
// server's AI may not read (device ⊆ server).
export async function aiDeviceExcludedPages(user: Identity, serverExcluded: string[]): Promise<string[]> {
  if (!serverExcluded.length) return [];
  const context = new AccessContext(user, true);
  context.markVisible(serverExcluded);
  return await filterAsync(serverExcluded, async (id) => (await context.pageVerdict(id)) !== null);
}

// Why the AI cannot read a page – for a hint in the interface.
export async function aiPageAccess(user: Identity, pageId: string, rowId?: string | null) {
  await requirePage(user, pageId);
  const verdict = await new AccessContext(user).pageVerdict(pageId);
  if (verdict) return { readable: false, reason: verdict };
  if (rowId && !(await aiMayRead(user, pageId, rowId))) return { readable: false, reason: "hidden" as const };
  return { readable: true, reason: null };
}

// ---- The person's rules ----

const MAX_RULES = 500;
const ruleInput = z.object({ targetId: z.string().min(1).max(100), mode: z.enum(["include", "exclude"]).nullable() });
export async function setAiRule(user: Identity, raw: unknown) {
  assertSettingsCaller(user);
  const b = ruleInput.parse(raw);
  if (b.mode === null) {
    await run("DELETE FROM ai_access_rules WHERE user_id=? AND target_id=?", user.id, b.targetId);
    return { rules: await aiRules(user) };
  }
  let kind: "workspace" | "space" | "page", workspaceId: string;
  const space = await one<Space>("SELECT * FROM spaces WHERE id=?", b.targetId);
  if (await one("SELECT 1 FROM workspaces WHERE id=?", b.targetId)) {
    if (!(await memberRole(user, b.targetId))) throw new HttpError(403, "Keine Berechtigung für diesen Arbeitsbereich.");
    kind = "workspace";
    workspaceId = b.targetId;
  } else if (space) {
    // Only spaces the person can open; others (private ones) do not exist
    // for them – not even by name in the answer.
    if (space.deleted_at || !(await spaceRole(user, space))) throw new HttpError(404, "Bereich nicht gefunden.");
    kind = "space";
    workspaceId = space.workspace_id;
  } else {
    const page = await requirePage(user, b.targetId);
    kind = "page";
    workspaceId = page.workspace_id;
  }
  const count = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM ai_access_rules WHERE user_id=?", user.id))?.n || 0);
  if (count >= MAX_RULES && !(await one("SELECT 1 FROM ai_access_rules WHERE user_id=? AND target_id=?", user.id, b.targetId)))
    throw new HttpError(400, "Höchstens 500 Regeln für den KI-Zugriff.");
  await run(
    "INSERT INTO ai_access_rules(user_id,target_id,kind,workspace_id,mode) VALUES(?,?,?,?,?) ON CONFLICT(user_id,target_id) DO UPDATE SET mode=excluded.mode",
    user.id,
    b.targetId,
    kind,
    workspaceId,
    b.mode,
  );
  return { rules: await aiRules(user) };
}

// The person's rules with names, for the settings – a name only where the
// person can still open the target (left a private space: no name).
async function ruleTitle(user: Identity, kind: "workspace" | "space" | "page", targetId: string) {
  if (kind === "workspace") {
    if (!(await memberRole(user, targetId))) return "";
    return (await one<{ name: string }>("SELECT name FROM workspaces WHERE id=?", targetId))?.name || "";
  }
  if (kind === "space") {
    const space = await one<Space>("SELECT * FROM spaces WHERE id=?", targetId);
    return space && await spaceRole(user, space) ? space.name : "";
  }
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", targetId);
  return page && await pageRole(user, page) ? page.title : "";
}
export async function aiRules(user: Identity, workspaceId?: string) {
  return await mapAsync(await all<{ target_id: string; kind: "workspace" | "space" | "page"; workspace_id: string; mode: "include" | "exclude" }>(
    `SELECT target_id,kind,workspace_id,mode FROM ai_access_rules WHERE user_id=?${workspaceId ? " AND workspace_id=?" : ""} ORDER BY kind,target_id`,
    ...(workspaceId ? [user.id, workspaceId] : [user.id]),
  ), async (r) => ({
    targetId: r.target_id,
    kind: r.kind,
    workspaceId: r.workspace_id,
    mode: r.mode,
    title: await ruleTitle(user, r.kind, r.target_id),
  }));
}

// ---- "Für KI gesperrt" (managers of a page or space, for everyone) ----

const blockInput = z.object({ targetId: z.uuid(), kind: z.enum(["page", "space"]), blocked: z.boolean() });
async function managedTarget(user: Identity, targetId: string, kind: "page" | "space") {
  if (kind === "space") {
    const space = await one<Space>("SELECT * FROM spaces WHERE id=?", targetId);
    if (!space || !(await memberRole(user, space.workspace_id))) throw new HttpError(404, "Bereich nicht gefunden.");
    return { workspaceId: space.workspace_id, spaceId: space.id, canManage: !user.apiScope && await canManageSpace(user, space), page: null as Page | null };
  }
  const page = await requirePage(user, targetId);
  return { workspaceId: page.workspace_id, spaceId: page.space_id, canManage: await canSharePage(user, page), page };
}
export async function setAiBlock(user: Identity, raw: unknown) {
  assertSettingsCaller(user);
  const b = blockInput.parse(raw);
  const target = await managedTarget(user, b.targetId, b.kind);
  if (!target.canManage)
    throw new HttpError(403, "Nur Eigentümer des Arbeitsbereichs oder des Bereichs dürfen das ändern.");
  if (b.blocked)
    await run(
      "INSERT INTO ai_blocks(target_id,kind,workspace_id,created_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT(target_id) DO NOTHING",
      b.targetId,
      b.kind,
      target.workspaceId,
      user.id,
      Date.now(),
    );
  else await run("DELETE FROM ai_blocks WHERE target_id=?", b.targetId);
  await audit(user.id, b.blocked ? "ai.block" : "ai.unblock", b.targetId, b.kind);
  return await aiBlockInfo(user, b.targetId, b.kind);
}
// The targets of every block (a small table; by target, not by workspace).
const allAiBlocks = async () => new Set((await all<{ target_id: string }>("SELECT target_id FROM ai_blocks")).map((r) => r.target_id));
// Whether a page or space is closed to the AI, and by what.
export async function aiBlockInfo(user: Identity, targetId: string, kind: "page" | "space") {
  const target = await managedTarget(user, targetId, kind);
  const blocks = await allAiBlocks();
  let inherited: "space" | "page" | null = null;
  if (kind === "page") {
    if (blocks.has(target.spaceId)) inherited = "space";
    else {
      const seen = new Set<string>();
      for (let p = target.page; p?.parent_id && !seen.has(p.id); p = await one<Page>("SELECT * FROM pages WHERE id=?", p.parent_id) || null) {
        seen.add(p.id);
        if (blocks.has(p.parent_id)) {
          inherited = "page";
          break;
        }
      }
    }
  }
  return { blocked: blocks.has(targetId), inherited, canManage: target.canManage };
}
