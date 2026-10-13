// Limits per person: storage for the files they upload or copy (across all
// workspaces), how many workspaces they may own, and the size of a single
// upload. Each can be set per account; otherwise the instance default applies
// (0 or empty = unlimited). Admins are not limited.
import { z } from "zod";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { instanceSettings } from "./instance-settings";
import type { Identity } from "./types";

export const userLimitsSchema = z.object({
  storageMb: z.number().int().min(0).max(10_000_000).nullable().optional(),
  workspaces: z.number().int().min(0).max(10_000).nullable().optional(),
  uploadMb: z.number().int().min(1).max(1024).nullable().optional(),
});
export type UserLimits = z.infer<typeof userLimitsSchema>;

export function storedUserLimits(userId: string): UserLimits {
  const raw = one<{ limits: string | null }>("SELECT limits FROM users WHERE id=?", userId)?.limits;
  try {
    const parsed = userLimitsSchema.safeParse(JSON.parse(raw || "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
// What applies to a person: own value, else the default. 0 = unlimited.
export function effectiveUserLimits(userId: string) {
  const own = storedUserLimits(userId);
  const settings = instanceSettings();
  return {
    storageMb: own.storageMb ?? settings.defaultUserStorageMb ?? 0,
    workspaces: own.workspaces ?? settings.defaultUserWorkspaces ?? 0,
    uploadMb: own.uploadMb ?? settings.maxUploadMb,
  };
}
export function setUserLimits(userId: string, input: unknown) {
  const limits = userLimitsSchema.parse(input);
  const clean = Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== null && v !== undefined));
  if (!run("UPDATE users SET limits=? WHERE id=?", Object.keys(clean).length ? JSON.stringify(clean) : null, userId).changes)
    throw new HttpError(404, "Benutzer nicht gefunden.");
  return { limits: clean, effective: effectiveUserLimits(userId) };
}

export const userBytes = (userId: string) => Number(one<{ n: number | null }>("SELECT SUM(size) n FROM files WHERE created_by=?", userId)?.n || 0);
export const ownedWorkspaces = (userId: string) => Number(one<{ n: number }>("SELECT count(*) n FROM members WHERE user_id=? AND role='owner'", userId)?.n || 0);
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
const limited = (user: Pick<Identity, "id" | "isAdmin">) => !user.isAdmin;

// Largest single upload for this person, in MB.
export function maxUploadMbFor(user: Pick<Identity, "id" | "isAdmin">) {
  return limited(user) ? effectiveUserLimits(user.id).uploadMb : instanceSettings().maxUploadMb;
}
// Throws before a write that would exceed the person's storage.
export function enforceUserStorage(user: Pick<Identity, "id" | "isAdmin">, addBytes: number) {
  if (!limited(user)) return;
  const { storageMb } = effectiveUserLimits(user.id);
  if (!storageMb) return;
  const used = userBytes(user.id);
  if (used + addBytes > storageMb * 1024 * 1024) throw new HttpError(413, `Dein Speicher ist voll (${mb(used)} von ${storageMb} MB belegt).`);
}
// For commands that copy files: measured before, checked after, inside the
// transaction – only growth beyond the limit is refused.
export function userStorageCheckpoint(user: Pick<Identity, "id" | "isAdmin">) {
  if (!limited(user)) return () => {};
  const before = userBytes(user.id);
  return () => {
    const { storageMb } = effectiveUserLimits(user.id);
    if (!storageMb) return;
    const after = userBytes(user.id);
    if (after > before && after > storageMb * 1024 * 1024)
      throw new HttpError(413, `Dein Speicher reicht dafür nicht (${mb(before)} von ${storageMb} MB belegt, benötigt zusätzlich ${mb(after - before)}).`);
  };
}
export function assertMayCreateWorkspace(user: Pick<Identity, "id" | "isAdmin">) {
  if (!limited(user)) return;
  const { workspaces } = effectiveUserLimits(user.id);
  if (workspaces && ownedWorkspaces(user.id) >= workspaces)
    throw new HttpError(403, `Du kannst höchstens ${workspaces} eigene Arbeitsbereiche anlegen.`);
}
// For the administration: usage and limits of every account.
export function usersUsage() {
  const bytes = new Map(all<{ id: string; n: number }>("SELECT created_by id, SUM(size) n FROM files WHERE created_by IS NOT NULL GROUP BY created_by").map((r) => [r.id, Number(r.n)]));
  const owned = new Map(all<{ id: string; n: number }>("SELECT user_id id, count(*) n FROM members WHERE role='owner' GROUP BY user_id").map((r) => [r.id, Number(r.n)]));
  return all<{ id: string }>("SELECT id FROM users WHERE demo_until IS NULL").map(({ id }) => ({
    id,
    bytes: bytes.get(id) || 0,
    workspaces: owned.get(id) || 0,
    limits: storedUserLimits(id),
    effective: effectiveUserLimits(id),
  }));
}
