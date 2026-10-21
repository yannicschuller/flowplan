// What the AI may read: the one place that decides whether content goes
// into a prompt. Every AI feature checks with aiMayRead / aiFilter /
// requireAiRead before it puts a page, a record or a search result into a
// prompt – also for the text a person selected in the editor.
//
// A page (and every record of a database page) is readable for the AI when
//   1. the person may read it (page permissions, record access),
//   2. it is not in the trash (nor any page above it, nor its space),
//   3. it is not inside a journal protected with a PIN – even while unlocked,
//   4. no manager marked it, a page above it or its space "Für KI gesperrt"
//      (ai_blocks) – this beats every personal rule,
//   5. the person's own rules allow it: the closest rule wins
//      (page → parent pages → space → workspace), an exclusion beats an
//      inclusion on the same level; without a rule, scope "all" allows and
//      scope "selected" excludes.
import { z } from "zod";
import { HttpError } from "../auth";
import { all, audit, one, run } from "../db";
import { memberRole, pageRole, requirePage } from "../permissions";
import { canSharePage } from "../page-share";
import { rowRoleResolver } from "../row-access";
import { canManageSpace } from "../workspace-lifecycle";
import type { Identity, Page, Space } from "../types";
import { assertSettingsCaller, userAiSettings } from "./settings";

export type AiTarget = { pageId: string; rowId?: string | null };
type PageLite = { id: string; workspace_id: string; space_id: string; parent_id: string | null; deleted_at: string | null; kind: string };

export const AI_BLOCKED_MESSAGE = "Diese Seite ist für die KI gesperrt.";

// Everything needed to judge many pages of one person at once.
class AccessContext {
  private pages = new Map<string, PageLite | null>();
  private workspaces = new Map<string, { spaces: Map<string, { deleted: boolean }>; pinned: Set<string> }>();
  private rules: Map<string, "include" | "exclude">;
  // Every block by its target, whatever workspace the row names: a block
  // follows a page that moves to another workspace.
  private blocks = allAiBlocks();
  private scope: "all" | "selected";
  private roles = new Map<string, boolean>();
  constructor(private user: Identity) {
    this.rules = new Map(
      all<{ target_id: string; mode: "include" | "exclude" }>("SELECT target_id,mode FROM ai_access_rules WHERE user_id=?", user.id).map((r) => [r.target_id, r.mode]),
    );
    this.scope = userAiSettings(user.id).scope;
  }
  private workspace(id: string) {
    let entry = this.workspaces.get(id);
    if (entry) return entry;
    for (const p of all<PageLite>("SELECT id,workspace_id,space_id,parent_id,deleted_at,kind FROM pages WHERE workspace_id=?", id)) this.pages.set(p.id, p);
    entry = {
      spaces: new Map(all<{ id: string; deleted_at: string | null }>("SELECT id,deleted_at FROM spaces WHERE workspace_id=?", id).map((s) => [s.id, { deleted: !!s.deleted_at }])),
      pinned: new Set(
        all<{ page_id: string }>("SELECT s.page_id FROM journal_settings s JOIN pages p ON p.id=s.page_id WHERE p.workspace_id=? AND s.lock_hash IS NOT NULL", id).map((r) => r.page_id),
      ),
    };
    this.workspaces.set(id, entry);
    return entry;
  }
  page(id: string): PageLite | null {
    if (!this.pages.has(id)) {
      const p = one<PageLite>("SELECT id,workspace_id,space_id,parent_id,deleted_at,kind FROM pages WHERE id=?", id) || null;
      if (p) this.workspace(p.workspace_id);
      if (!this.pages.has(id)) this.pages.set(id, p);
    }
    return this.pages.get(id) || null;
  }
  private visible(page: PageLite) {
    let known = this.roles.get(page.id);
    if (known === undefined) {
      const full = one<Page>("SELECT * FROM pages WHERE id=?", page.id);
      known = !!full && !!pageRole(this.user, full);
      this.roles.set(page.id, known);
    }
    return known;
  }
  markVisible(ids: Iterable<string>) {
    for (const id of ids) this.roles.set(id, true);
  }
  // Why a page is not readable for the AI, or null when it is.
  pageVerdict(id: string): "missing" | "hidden" | "trash" | "pin" | "blocked" | "excluded" | null {
    const page = this.page(id);
    if (!page) return "missing";
    const ws = this.workspace(page.workspace_id);
    const space = ws.spaces.get(page.space_id);
    if (page.deleted_at || !space || space.deleted) return "trash";
    if (!this.visible(page)) return "hidden";
    if (this.blocks.has(page.space_id)) return "blocked";
    // The page and everything above it.
    const chain: PageLite[] = [];
    const seen = new Set<string>();
    for (let current: PageLite | null = page; current; current = current.parent_id ? this.page(current.parent_id) : null) {
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
  rowsReadable(pageId: string, rowIds: string[]): Set<string> {
    if (this.pageVerdict(pageId) !== null) return new Set();
    const page = one<Page>("SELECT * FROM pages WHERE id=?", pageId);
    if (!page || page.kind !== "database") return new Set();
    const resolve = rowRoleResolver(this.user, page);
    const ok = new Set<string>();
    for (let i = 0; i < rowIds.length; i += 500) {
      const chunk = rowIds.slice(i, i + 500);
      for (const row of all<{ id: string; access: string; created_by: string | null }>(
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
export function aiMayRead(user: Identity, pageId: string, rowId?: string | null): boolean {
  return aiFilter(user, [{ pageId, rowId }]).length === 1;
}

// The items the AI may read, in their order (many pages and records at once).
export function aiFilter<T extends AiTarget>(user: Identity, items: T[]): T[] {
  if (!items.length) return [];
  const context = new AccessContext(user);
  const rowsByPage = new Map<string, string[]>();
  for (const item of items) if (item.rowId) rowsByPage.set(item.pageId, [...(rowsByPage.get(item.pageId) || []), item.rowId]);
  const readableRows = new Map<string, Set<string>>();
  for (const [pageId, rowIds] of rowsByPage) readableRows.set(pageId, context.rowsReadable(pageId, [...new Set(rowIds)]));
  const pageOk = new Map<string, boolean>();
  return items.filter((item) => {
    if (item.rowId) return !!readableRows.get(item.pageId)?.has(item.rowId);
    if (!pageOk.has(item.pageId)) pageOk.set(item.pageId, context.pageVerdict(item.pageId) === null);
    return pageOk.get(item.pageId)!;
  });
}

// Page ids the AI may read.
export function aiReadablePages(user: Identity, pageIds: string[]): Set<string> {
  return new Set(aiFilter(user, pageIds.map((pageId) => ({ pageId }))).map((i) => i.pageId));
}

// For features: refuse before anything of the page reaches a prompt.
export function requireAiRead(user: Identity, pageId: string, rowId?: string | null) {
  if (!aiMayRead(user, pageId, rowId)) throw new HttpError(403, AI_BLOCKED_MESSAGE);
}

// Pages of a workspace the person sees but the AI may not read (bootstrap:
// the interface shows "KI hat keinen Zugriff" and disables AI buttons).
export function aiExcludedPages(user: Identity, visiblePages: { id: string }[]): string[] {
  if (!visiblePages.length) return [];
  const context = new AccessContext(user);
  context.markVisible(visiblePages.map((p) => p.id));
  return visiblePages.filter((p) => context.pageVerdict(p.id) !== null).map((p) => p.id);
}

// Why the AI cannot read a page – for a hint in the interface.
export function aiPageAccess(user: Identity, pageId: string, rowId?: string | null) {
  requirePage(user, pageId);
  const verdict = new AccessContext(user).pageVerdict(pageId);
  if (verdict) return { readable: false, reason: verdict };
  if (rowId && !aiMayRead(user, pageId, rowId)) return { readable: false, reason: "hidden" as const };
  return { readable: true, reason: null };
}

// ---- The person's rules ----

const MAX_RULES = 500;
const ruleInput = z.object({ targetId: z.string().min(1).max(100), mode: z.enum(["include", "exclude"]).nullable() });
export function setAiRule(user: Identity, raw: unknown) {
  assertSettingsCaller(user);
  const b = ruleInput.parse(raw);
  if (b.mode === null) {
    run("DELETE FROM ai_access_rules WHERE user_id=? AND target_id=?", user.id, b.targetId);
    return { rules: aiRules(user) };
  }
  let kind: "workspace" | "space" | "page", workspaceId: string;
  const space = one<Space>("SELECT * FROM spaces WHERE id=?", b.targetId);
  if (one("SELECT 1 FROM workspaces WHERE id=?", b.targetId)) {
    if (!memberRole(user, b.targetId)) throw new HttpError(403, "Keine Berechtigung für diesen Arbeitsbereich.");
    kind = "workspace";
    workspaceId = b.targetId;
  } else if (space) {
    if (!memberRole(user, space.workspace_id) || space.deleted_at) throw new HttpError(403, "Keine Berechtigung für diesen Bereich.");
    kind = "space";
    workspaceId = space.workspace_id;
  } else {
    const page = requirePage(user, b.targetId);
    kind = "page";
    workspaceId = page.workspace_id;
  }
  const count = Number(one<{ n: number }>("SELECT COUNT(*) n FROM ai_access_rules WHERE user_id=?", user.id)?.n || 0);
  if (count >= MAX_RULES && !one("SELECT 1 FROM ai_access_rules WHERE user_id=? AND target_id=?", user.id, b.targetId))
    throw new HttpError(400, "Höchstens 500 Regeln für den KI-Zugriff.");
  run(
    "INSERT INTO ai_access_rules(user_id,target_id,kind,workspace_id,mode) VALUES(?,?,?,?,?) ON CONFLICT(user_id,target_id) DO UPDATE SET mode=excluded.mode",
    user.id,
    b.targetId,
    kind,
    workspaceId,
    b.mode,
  );
  return { rules: aiRules(user) };
}

// The person's rules with names, for the settings.
export function aiRules(user: Identity, workspaceId?: string) {
  return all<{ target_id: string; kind: "workspace" | "space" | "page"; workspace_id: string; mode: "include" | "exclude" }>(
    `SELECT target_id,kind,workspace_id,mode FROM ai_access_rules WHERE user_id=?${workspaceId ? " AND workspace_id=?" : ""} ORDER BY kind,target_id`,
    ...(workspaceId ? [user.id, workspaceId] : [user.id]),
  ).map((r) => ({
    targetId: r.target_id,
    kind: r.kind,
    workspaceId: r.workspace_id,
    mode: r.mode,
    title:
      r.kind === "workspace"
        ? one<{ name: string }>("SELECT name FROM workspaces WHERE id=?", r.target_id)?.name || ""
        : r.kind === "space"
          ? one<{ name: string }>("SELECT name FROM spaces WHERE id=?", r.target_id)?.name || ""
          : one<{ title: string }>("SELECT title FROM pages WHERE id=?", r.target_id)?.title || "",
  }));
}

// ---- "Für KI gesperrt" (managers of a page or space, for everyone) ----

const blockInput = z.object({ targetId: z.uuid(), kind: z.enum(["page", "space"]), blocked: z.boolean() });
function managedTarget(user: Identity, targetId: string, kind: "page" | "space") {
  if (kind === "space") {
    const space = one<Space>("SELECT * FROM spaces WHERE id=?", targetId);
    if (!space || !memberRole(user, space.workspace_id)) throw new HttpError(404, "Bereich nicht gefunden.");
    return { workspaceId: space.workspace_id, spaceId: space.id, canManage: !user.apiScope && canManageSpace(user, space), page: null as Page | null };
  }
  const page = requirePage(user, targetId);
  return { workspaceId: page.workspace_id, spaceId: page.space_id, canManage: canSharePage(user, page), page };
}
export function setAiBlock(user: Identity, raw: unknown) {
  assertSettingsCaller(user);
  const b = blockInput.parse(raw);
  const target = managedTarget(user, b.targetId, b.kind);
  if (!target.canManage)
    throw new HttpError(403, "Nur Eigentümer des Arbeitsbereichs oder des Bereichs dürfen das ändern.");
  if (b.blocked)
    run(
      "INSERT INTO ai_blocks(target_id,kind,workspace_id,created_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT(target_id) DO NOTHING",
      b.targetId,
      b.kind,
      target.workspaceId,
      user.id,
      Date.now(),
    );
  else run("DELETE FROM ai_blocks WHERE target_id=?", b.targetId);
  audit(user.id, b.blocked ? "ai.block" : "ai.unblock", b.targetId, b.kind);
  return aiBlockInfo(user, b.targetId, b.kind);
}
// The targets of every block (a small table; by target, not by workspace).
const allAiBlocks = () => new Set(all<{ target_id: string }>("SELECT target_id FROM ai_blocks").map((r) => r.target_id));
// Whether a page or space is closed to the AI, and by what.
export function aiBlockInfo(user: Identity, targetId: string, kind: "page" | "space") {
  const target = managedTarget(user, targetId, kind);
  const blocks = allAiBlocks();
  let inherited: "space" | "page" | null = null;
  if (kind === "page") {
    if (blocks.has(target.spaceId)) inherited = "space";
    else {
      const seen = new Set<string>();
      for (let p = target.page; p?.parent_id && !seen.has(p.id); p = one<Page>("SELECT * FROM pages WHERE id=?", p.parent_id) || null) {
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
