// Limits per person: storage for their files (across all workspaces), how
// many workspaces they may own, the size of a single upload, and AI (on or
// off, AI tokens per calendar month). Each can be set per account;
// otherwise the instance default applies (0 or empty = unlimited). Admins
// are not limited.
//
// Whose storage a file counts against (instance setting storageAccounting,
// env FLOWPLAN_STORAGE_ACCOUNTING):
//   "uploader" (default): the person who uploaded or copied it, wherever it
//     is stored; the workspace limit counts workspaces with the owner role.
//   "owner" (for hosted offerings): the person who created the workspace it
//     is stored in (workspaces.created_by), no matter who uploads; the
//     workspace limit counts the workspaces they created. Handing the last
//     owner role on moves created_by (handOverWorkspaceCreator).
import { z } from "zod";
import { all, lockFor, one, run } from "./db";
import { adminGroup, HttpError } from "./auth";
import { instanceSettings } from "./instance-settings";
import type { Identity } from "./types";
import { mapAsync } from "./each-async";
import { LimitError } from "./upgrade-link";

export const userLimitsSchema = z.object({
  storageMb: z.number().int().min(0).max(10_000_000).nullable().optional(),
  workspaces: z.number().int().min(0).max(10_000).nullable().optional(),
  uploadMb: z.number().int().min(1).max(1024).nullable().optional(),
  ai: z.boolean().nullable().optional(),
  aiTokensPerMonth: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
});
export type UserLimits = z.infer<typeof userLimitsSchema>;
export type StorageAccounting = "uploader" | "owner";

// The stored setting, else the environment, else "uploader".
export async function storageAccounting(): Promise<StorageAccounting> {
  const stored = (await instanceSettings()).storageAccounting;
  if (stored) return stored;
  return process.env.FLOWPLAN_STORAGE_ACCOUNTING?.trim().toLowerCase() === "owner" ? "owner" : "uploader";
}
export const envStorageAccounting = (): StorageAccounting =>
  process.env.FLOWPLAN_STORAGE_ACCOUNTING?.trim().toLowerCase() === "owner" ? "owner" : "uploader";

export async function storedUserLimits(userId: string): Promise<UserLimits> {
  const raw = (await one<{ limits: string | null }>("SELECT limits FROM users WHERE id=?", userId))?.limits;
  try {
    const parsed = userLimitsSchema.safeParse(JSON.parse(raw || "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
// What applies to a person: own value, else the default. 0 = unlimited.
export async function effectiveUserLimits(userId: string) {
  const own = await storedUserLimits(userId);
  const settings = await instanceSettings();
  return {
    storageMb: own.storageMb ?? settings.defaultUserStorageMb ?? 0,
    workspaces: own.workspaces ?? settings.defaultUserWorkspaces ?? 0,
    uploadMb: own.uploadMb ?? settings.maxUploadMb,
    ai: own.ai ?? settings.defaultUserAi ?? true,
    aiTokensPerMonth: own.aiTokensPerMonth ?? settings.defaultUserAiTokensPerMonth ?? 0,
  };
}
export async function setUserLimits(userId: string, input: unknown) {
  const limits = userLimitsSchema.parse(input);
  const clean = Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== null && v !== undefined));
  if (!(await run("UPDATE users SET limits=? WHERE id=?", Object.keys(clean).length ? JSON.stringify(clean) : null, userId)).changes)
    throw new HttpError(404, "Benutzer nicht gefunden.");
  return { limits: clean, effective: await effectiveUserLimits(userId) };
}

// ---- Storage ----

// Everything the person uploaded or copied (storageAccounting "uploader").
export const userBytes = async (userId: string) =>
  Number((await one<{ n: number | null }>("SELECT SUM(size) n FROM files WHERE created_by=?", userId))?.n || 0) +
  // Own stickers and paper templates of notebooks (lib/notebook-library.ts).
  Number((await one<{ n: number | null }>("SELECT SUM(COALESCE(length(data),0)) n FROM notebook_stickers WHERE user_id=?", userId))?.n || 0) +
  Number((await one<{ n: number | null }>("SELECT SUM(length(data)) n FROM notebook_templates WHERE created_by=?", userId))?.n || 0) +
  // Faces uploaded for a workspace's look (lib/workspace-fonts.ts).
  Number((await one<{ n: number | null }>("SELECT SUM(length(data)) n FROM workspace_fonts WHERE created_by=?", userId))?.n || 0);
// The same things, stored in the workspaces the person created – whoever
// uploaded them (storageAccounting "owner").
export const ownerBytes = async (userId: string) =>
  Number((await one<{ n: number | null }>("SELECT SUM(f.size) n FROM files f JOIN pages p ON p.id=f.page_id JOIN workspaces w ON w.id=p.workspace_id WHERE w.created_by=?", userId))?.n || 0) +
  Number((await one<{ n: number | null }>("SELECT SUM(COALESCE(length(s.data),0)) n FROM notebook_stickers s JOIN workspaces w ON w.id=s.workspace_id WHERE w.created_by=?", userId))?.n || 0) +
  Number((await one<{ n: number | null }>("SELECT SUM(length(t.data)) n FROM notebook_templates t JOIN workspaces w ON w.id=t.workspace_id WHERE w.created_by=?", userId))?.n || 0) +
  Number((await one<{ n: number | null }>("SELECT SUM(length(f.data)) n FROM workspace_fonts f JOIN workspaces w ON w.id=f.workspace_id WHERE w.created_by=?", userId))?.n || 0);
// What counts against the person's storage limit in the current mode.
export async function accountedBytes(userId: string) {
  return (await storageAccounting()) === "owner" ? await ownerBytes(userId) : await userBytes(userId);
}
// Workspaces the person owns: with the owner role ("uploader"), or created
// by them ("owner").
export async function ownedWorkspaces(userId: string) {
  if ((await storageAccounting()) === "owner")
    return Number((await one<{ n: number }>("SELECT count(*) n FROM workspaces WHERE created_by=?", userId))?.n || 0);
  return Number((await one<{ n: number }>("SELECT count(*) n FROM members WHERE user_id=? AND role='owner'", userId))?.n || 0);
}
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
const limited = (user: Pick<Identity, "id" | "isAdmin">) => !user.isAdmin;

// Whether an account that is not the one asking has administration rights:
// a local or LDAP admin, or signed in with the admin group right now
// (SSO groups only exist in sessions).
async function accountIsAdmin(userId: string) {
  if (await one("SELECT 1 FROM local_accounts WHERE user_id=? AND is_admin=1", userId)) return true;
  if (await one("SELECT 1 FROM ldap_accounts WHERE user_id=? AND is_admin=1", userId)) return true;
  const group = adminGroup();
  return (await all<{ groups_json: string }>("SELECT groups_json FROM sessions WHERE user_id=? AND expires>?", userId, Date.now())).some((s) => {
    try {
      return (JSON.parse(s.groups_json) as string[]).includes(group);
    } catch {
      return false;
    }
  });
}
// The account a write into this workspace counts against ("owner" mode):
// its creator, unless that is an admin or nobody (then: not limited).
async function accountOf(workspaceId: string) {
  const w = await one<{ created_by: string | null; name: string | null }>(
    "SELECT w.created_by,u.name FROM workspaces w LEFT JOIN users u ON u.id=w.created_by WHERE w.id=?",
    workspaceId,
  );
  if (!w?.created_by || (await accountIsAdmin(w.created_by))) return null;
  return { id: w.created_by, name: w.name || "" };
}

// Largest single upload for this person, in MB.
export async function maxUploadMbFor(user: Pick<Identity, "id" | "isAdmin">) {
  return limited(user) ? (await effectiveUserLimits(user.id)).uploadMb : (await instanceSettings()).maxUploadMb;
}
// Throws before a write into `workspaceId` that would exceed the storage it
// counts against (the uploader's, or the workspace creator's in "owner"
// mode). Inside a transaction, writes against one person's storage take
// turns until the commit (like enforceQuota, lib/instance-ops.ts): parallel
// uploads cannot both pass the check against the same "used". Always after
// enforceQuota (one lock order).
const lockStorage = (userId: string) => lockFor(`user-storage:${userId}`);
export async function enforceUserStorage(user: Pick<Identity, "id" | "isAdmin">, addBytes: number, workspaceId: string | null) {
  if (!limited(user)) return;
  if (workspaceId && (await storageAccounting()) === "owner") {
    const account = await accountOf(workspaceId);
    if (!account) return;
    const { storageMb } = await effectiveUserLimits(account.id);
    if (!storageMb) return;
    await lockStorage(account.id);
    const used = await ownerBytes(account.id);
    if (used + addBytes <= storageMb * 1024 * 1024) return;
    if (account.id === user.id) throw new LimitError(413, `Dein Speicher ist voll (${mb(used)} von ${storageMb} MB belegt).`);
    throw new HttpError(413, `Der Speicher von „${account.name}“ (Eigentümer dieses Arbeitsbereichs) ist voll.`);
  }
  const { storageMb } = await effectiveUserLimits(user.id);
  if (!storageMb) return;
  await lockStorage(user.id);
  const used = await userBytes(user.id);
  if (used + addBytes > storageMb * 1024 * 1024) throw new LimitError(413, `Dein Speicher ist voll (${mb(used)} von ${storageMb} MB belegt).`);
}
// The bytes still free for a write into this workspace (null: unlimited) –
// for recordings that check before they start (lib/notebook-audio.ts).
export async function storageRoom(user: Pick<Identity, "id" | "isAdmin">, workspaceId: string): Promise<number | null> {
  if (!limited(user)) return null;
  const owner = (await storageAccounting()) === "owner";
  const account = owner ? await accountOf(workspaceId) : { id: user.id };
  if (!account) return null;
  const { storageMb } = await effectiveUserLimits(account.id);
  if (!storageMb) return null;
  return storageMb * 1024 * 1024 - (owner ? await ownerBytes(account.id) : await userBytes(account.id));
}
// What the person created, per workspace ("owner" mode checkpoints).
async function bytesByWorkspace(userId: string) {
  const out = new Map<string, number>();
  const add = (rows: { w: string; n: number | null }[]) => {
    for (const r of rows) out.set(r.w, (out.get(r.w) || 0) + Number(r.n || 0));
  };
  add(await all("SELECT p.workspace_id w,SUM(f.size) n FROM files f JOIN pages p ON p.id=f.page_id WHERE f.created_by=? GROUP BY p.workspace_id", userId));
  add(await all("SELECT workspace_id w,SUM(COALESCE(length(data),0)) n FROM notebook_stickers WHERE user_id=? GROUP BY workspace_id", userId));
  add(await all("SELECT workspace_id w,SUM(length(data)) n FROM notebook_templates WHERE created_by=? GROUP BY workspace_id", userId));
  add(await all("SELECT workspace_id w,SUM(length(data)) n FROM workspace_fonts WHERE created_by=? GROUP BY workspace_id", userId));
  return out;
}
// For commands that copy files: measured before, checked after, inside the
// transaction – only growth beyond the limit is refused. In "owner" mode the
// growth is found per workspace and checked against each creator's storage.
export async function userStorageCheckpoint(user: Pick<Identity, "id" | "isAdmin">) {
  if (!limited(user)) return async () => {};
  if ((await storageAccounting()) === "owner") {
    const before = await bytesByWorkspace(user.id);
    return async () => {
      const after = await bytesByWorkspace(user.id);
      const grown = [...after].filter(([w, n]) => n > (before.get(w) || 0)).map(([w]) => w);
      const checked = new Set<string>();
      for (const w of grown) {
        const account = await accountOf(w);
        if (!account || checked.has(account.id)) continue;
        checked.add(account.id);
        const { storageMb } = await effectiveUserLimits(account.id);
        if (!storageMb) continue;
        const used = await ownerBytes(account.id);
        if (used <= storageMb * 1024 * 1024) continue;
        if (account.id === user.id) throw new LimitError(413, `Dein Speicher reicht dafür nicht (${storageMb} MB, belegt wären ${mb(used)}).`);
        throw new HttpError(413, `Der Speicher von „${account.name}“ (Eigentümer des Arbeitsbereichs) reicht dafür nicht.`);
      }
    };
  }
  const before = await userBytes(user.id);
  return async () => {
    const { storageMb } = await effectiveUserLimits(user.id);
    if (!storageMb) return;
    const after = await userBytes(user.id);
    if (after > before && after > storageMb * 1024 * 1024)
      throw new LimitError(413, `Dein Speicher reicht dafür nicht (${mb(before)} von ${storageMb} MB belegt, benötigt zusätzlich ${mb(after - before)}).`);
  };
}
// Inside the command's transaction: creations by one person take turns
// until the commit (PostgreSQL), so parallel ones cannot all pass the count.
export async function assertMayCreateWorkspace(user: Pick<Identity, "id" | "isAdmin">) {
  if (!limited(user)) return;
  const { workspaces } = await effectiveUserLimits(user.id);
  if (!workspaces) return;
  await lockFor(`user-workspaces:${user.id}`);
  if ((await ownedWorkspaces(user.id)) >= workspaces)
    throw new LimitError(403, `Du kannst höchstens ${workspaces} eigene Arbeitsbereiche anlegen.`);
}
// "owner" mode: when the creator of a workspace is no longer one of its
// owners (left, removed, demoted, account deleted), the workspace – and its
// storage – passes to an owner: `preferred` when that is one, else the
// longest-standing active owner. Nothing happens in "uploader" mode.
export async function handOverWorkspaceCreator(workspaceId: string, preferred?: string | null) {
  if ((await storageAccounting()) !== "owner") return;
  const creator = (await one<{ created_by: string | null }>("SELECT created_by FROM workspaces WHERE id=?", workspaceId))?.created_by;
  const isOwner = async (userId: string) => !!(await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=? AND role='owner'", workspaceId, userId));
  if (creator && (await isOwner(creator))) return;
  const next =
    preferred && (await isOwner(preferred))
      ? preferred
      : (await one<{ user_id: string }>(
          "SELECT m.user_id FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.role='owner' ORDER BY u.disabled,u.created_at,u.id LIMIT 1",
          workspaceId,
        ))?.user_id;
  if (next && next !== creator) await run("UPDATE workspaces SET created_by=? WHERE id=?", next, workspaceId);
}

// ---- AI ----

// The calendar month (UTC) of the AI token counter.
export const aiMonth = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
export async function aiTokensThisMonth(userId: string, now = Date.now()) {
  return Number((await one<{ tokens: number }>("SELECT tokens FROM ai_usage_monthly WHERE user_id=? AND month=?", userId, aiMonth(now)))?.tokens || 0);
}
export async function addAiTokens(userId: string, tokens: number, now = Date.now()) {
  if (!(tokens > 0)) return;
  await run(
    "INSERT INTO ai_usage_monthly(user_id,month,tokens) VALUES(?,?,?) ON CONFLICT(user_id,month) DO UPDATE SET tokens=ai_usage_monthly.tokens+excluded.tokens",
    userId,
    aiMonth(now),
    Math.round(tokens),
  );
}
// Whether the person may use AI at all (limits.ai), and whether the
// month's AI tokens through the instance's provider are used up.
export async function aiAllowedByLimits(user: Pick<Identity, "id" | "isAdmin">) {
  return !limited(user) || (await effectiveUserLimits(user.id)).ai;
}
export async function aiBudgetUsedUp(user: Pick<Identity, "id" | "isAdmin">, now = Date.now()) {
  if (!limited(user)) return false;
  const { aiTokensPerMonth } = await effectiveUserLimits(user.id);
  return !!aiTokensPerMonth && (await aiTokensThisMonth(user.id, now)) >= aiTokensPerMonth;
}
// Tokens are counted only where something reads them: a monthly budget for
// the person, or the admin API (lib/admin-api.ts) that reports them.
export async function aiTokensCounted(user: Pick<Identity, "id">) {
  if (process.env.FLOWPLAN_ADMIN_API_TOKEN?.trim()) return true;
  return !!(await effectiveUserLimits(user.id)).aiTokensPerMonth;
}

// For the administration: usage and limits of every account.
export async function usersUsage() {
  const owner = (await storageAccounting()) === "owner";
  const bytes = new Map<string, number>();
  const add = (rows: { id: string; n: number | null }[]) => {
    for (const r of rows) bytes.set(r.id, (bytes.get(r.id) || 0) + Number(r.n || 0));
  };
  if (owner) {
    add(await all("SELECT w.created_by id,SUM(f.size) n FROM files f JOIN pages p ON p.id=f.page_id JOIN workspaces w ON w.id=p.workspace_id WHERE w.created_by IS NOT NULL GROUP BY w.created_by"));
    add(await all("SELECT w.created_by id,SUM(COALESCE(length(s.data),0)) n FROM notebook_stickers s JOIN workspaces w ON w.id=s.workspace_id WHERE w.created_by IS NOT NULL GROUP BY w.created_by"));
    add(await all("SELECT w.created_by id,SUM(length(t.data)) n FROM notebook_templates t JOIN workspaces w ON w.id=t.workspace_id WHERE w.created_by IS NOT NULL GROUP BY w.created_by"));
    add(await all("SELECT w.created_by id,SUM(length(f.data)) n FROM workspace_fonts f JOIN workspaces w ON w.id=f.workspace_id WHERE w.created_by IS NOT NULL GROUP BY w.created_by"));
  } else add(await all("SELECT created_by id,SUM(size) n FROM files WHERE created_by IS NOT NULL GROUP BY created_by"));
  const owned = new Map(
    (owner
      ? await all<{ id: string; n: number }>("SELECT created_by id,count(*) n FROM workspaces WHERE created_by IS NOT NULL GROUP BY created_by")
      : await all<{ id: string; n: number }>("SELECT user_id id, count(*) n FROM members WHERE role='owner' GROUP BY user_id")
    ).map((r) => [r.id, Number(r.n)]),
  );
  const tokens = new Map((await all<{ id: string; n: number }>("SELECT user_id id,tokens n FROM ai_usage_monthly WHERE month=?", aiMonth())).map((r) => [r.id, Number(r.n)]));
  // Every workspace the person belongs to, in any role (the list shows the
  // count, the account's panel the names).
  const memberOf = new Map<string, string[]>();
  for (const r of await all<{ id: string; w: string }>("SELECT user_id id, workspace_id w FROM members ORDER BY user_id, workspace_id")) {
    const list = memberOf.get(r.id);
    if (list) list.push(r.w);
    else memberOf.set(r.id, [r.w]);
  }
  return await mapAsync(await all<{ id: string }>("SELECT id FROM users WHERE demo_until IS NULL AND subject NOT LIKE 'deleted:%'"), async ({ id }) => ({
    id,
    bytes: bytes.get(id) || 0,
    workspaces: owned.get(id) || 0,
    aiTokens: tokens.get(id) || 0,
    memberOf: memberOf.get(id) || [],
    limits: await storedUserLimits(id),
    effective: await effectiveUserLimits(id),
  }));
}
