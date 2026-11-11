// Limits per person: storage for the files they upload or copy (across all
// workspaces), how many workspaces they may own, and the size of a single
// upload. Each can be set per account; otherwise the instance default applies
// (0 or empty = unlimited). Admins are not limited.
import { z } from "zod";
import { all, lockFor, one, run } from "./db";
import { HttpError } from "./auth";
import { instanceSettings } from "./instance-settings";
import type { Identity } from "./types";
import { mapAsync } from "./each-async";

export const userLimitsSchema = z.object({
  storageMb: z.number().int().min(0).max(10_000_000).nullable().optional(),
  workspaces: z.number().int().min(0).max(10_000).nullable().optional(),
  uploadMb: z.number().int().min(1).max(1024).nullable().optional(),
});
export type UserLimits = z.infer<typeof userLimitsSchema>;

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
  };
}
export async function setUserLimits(userId: string, input: unknown) {
  const limits = userLimitsSchema.parse(input);
  const clean = Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== null && v !== undefined));
  if (!(await run("UPDATE users SET limits=? WHERE id=?", Object.keys(clean).length ? JSON.stringify(clean) : null, userId)).changes)
    throw new HttpError(404, "Benutzer nicht gefunden.");
  return { limits: clean, effective: await effectiveUserLimits(userId) };
}

export const userBytes = async (userId: string) =>
  Number((await one<{ n: number | null }>("SELECT SUM(size) n FROM files WHERE created_by=?", userId))?.n || 0) +
  // Own stickers and paper templates of notebooks (lib/notebook-library.ts).
  Number((await one<{ n: number | null }>("SELECT SUM(COALESCE(length(data),0)) n FROM notebook_stickers WHERE user_id=?", userId))?.n || 0) +
  Number((await one<{ n: number | null }>("SELECT SUM(length(data)) n FROM notebook_templates WHERE created_by=?", userId))?.n || 0) +
  // Faces uploaded for a workspace's look (lib/workspace-fonts.ts).
  Number((await one<{ n: number | null }>("SELECT SUM(length(data)) n FROM workspace_fonts WHERE created_by=?", userId))?.n || 0);
export const ownedWorkspaces = async (userId: string) => Number((await one<{ n: number }>("SELECT count(*) n FROM members WHERE user_id=? AND role='owner'", userId))?.n || 0);
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
const limited = (user: Pick<Identity, "id" | "isAdmin">) => !user.isAdmin;

// Largest single upload for this person, in MB.
export async function maxUploadMbFor(user: Pick<Identity, "id" | "isAdmin">) {
  return limited(user) ? (await effectiveUserLimits(user.id)).uploadMb : (await instanceSettings()).maxUploadMb;
}
// Throws before a write that would exceed the person's storage. Inside a
// transaction, the person's writes take turns until the commit (like
// enforceQuota, lib/instance-ops.ts): parallel uploads cannot both pass the
// check against the same "used". Always after enforceQuota (one lock order).
const lockStorage = (userId: string) => lockFor(`user-storage:${userId}`);
export async function enforceUserStorage(user: Pick<Identity, "id" | "isAdmin">, addBytes: number) {
  if (!limited(user)) return;
  const { storageMb } = await effectiveUserLimits(user.id);
  if (!storageMb) return;
  await lockStorage(user.id);
  const used = await userBytes(user.id);
  if (used + addBytes > storageMb * 1024 * 1024) throw new HttpError(413, `Dein Speicher ist voll (${mb(used)} von ${storageMb} MB belegt).`);
}
// For commands that copy files: measured before, checked after, inside the
// transaction – only growth beyond the limit is refused.
export async function userStorageCheckpoint(user: Pick<Identity, "id" | "isAdmin">) {
  if (!limited(user)) return async () => {};
  const before = await userBytes(user.id);
  return async () => {
    const { storageMb } = await effectiveUserLimits(user.id);
    if (!storageMb) return;
    const after = await userBytes(user.id);
    if (after > before && after > storageMb * 1024 * 1024)
      throw new HttpError(413, `Dein Speicher reicht dafür nicht (${mb(before)} von ${storageMb} MB belegt, benötigt zusätzlich ${mb(after - before)}).`);
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
    throw new HttpError(403, `Du kannst höchstens ${workspaces} eigene Arbeitsbereiche anlegen.`);
}
// For the administration: usage and limits of every account.
export async function usersUsage() {
  const bytes = new Map((await all<{ id: string; n: number }>("SELECT created_by id, SUM(size) n FROM files WHERE created_by IS NOT NULL GROUP BY created_by")).map((r) => [r.id, Number(r.n)]));
  const owned = new Map((await all<{ id: string; n: number }>("SELECT user_id id, count(*) n FROM members WHERE role='owner' GROUP BY user_id")).map((r) => [r.id, Number(r.n)]));
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
    memberOf: memberOf.get(id) || [],
    limits: await storedUserLimits(id),
    effective: await effectiveUserLimits(id),
  }));
}
