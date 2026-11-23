// Limits per person: storage for the files they upload or copy (across all
// workspaces), how many workspaces they may own, and the size of a single
// upload. Each can be set per account and per group (a workspace group or a
// directory group, lib/group-keys.ts); otherwise the instance default
// applies (0 or empty = unlimited). Admins are not limited.
//
// Precedence per limit, like the AI quotas (lib/ai/quota.ts): the account's
// own value, else the most generous value of the person's groups (0 =
// unlimited wins; a group without a value for this limit does not count),
// else the instance's default. The groups of a person: their workspace
// groups in every workspace and their directory groups
// (lib/person-groups.ts).
//
// Add-ons (storage only): a group's storage can be marked "additional"
// (`storageMode: "add"` in group_limits.limits, e.g. the billing service's
// "Flowplan +50 GB"). Such values do not compete for "most generous"; they
// are added on top of the base – the most generous normal group value,
// else the default. Several add-ons sum up. An unlimited base (0) stays
// unlimited. With an own value the administrator set an explicit number
// for that person: add-ons are not added. Workspaces and uploads have no
// add-on mode. Rows without `storageMode` (0.11.1) are normal limits; no
// migration – the mode lives in the existing JSON.
import { z } from "zod";
import { all, audit, lockFor, one, run } from "./db";
import { HttpError } from "./auth";
import { instanceSettings, type InstanceSettings } from "./instance-settings";
import type { Identity } from "./types";
import { mapAsync } from "./each-async";
import { allGroupKeys, groupChoices, personGroupKeys, validGroupKey } from "./person-groups";
import { MAX_DIRECTORY_NAME } from "./group-keys";
import { MAX_UPLOAD_MB } from "./upload-limit";

export const userLimitsSchema = z.object({
  storageMb: z.number().int().min(0).max(10_000_000).nullable().optional(),
  workspaces: z.number().int().min(0).max(10_000).nullable().optional(),
  uploadMb: z.number().int().min(1).max(MAX_UPLOAD_MB).nullable().optional(),
});
export type UserLimits = z.infer<typeof userLimitsSchema>;
// A group's limits: the same fields, plus whether its storage is a limit
// (default) or an add-on on top of the person's base.
export const STORAGE_MODES = ["limit", "add"] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];
export const groupLimitsSchema = userLimitsSchema.extend({ storageMode: z.enum(STORAGE_MODES).nullable().optional() });
export type GroupLimits = z.infer<typeof groupLimitsSchema>;

export async function storedUserLimits(userId: string): Promise<UserLimits> {
  const raw = (await one<{ limits: string | null }>("SELECT limits FROM users WHERE id=?", userId))?.limits;
  try {
    const parsed = userLimitsSchema.safeParse(JSON.parse(raw || "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
export const USER_LIMIT_FIELDS = ["storageMb", "workspaces", "uploadMb"] as const;
export type UserLimitField = (typeof USER_LIMIT_FIELDS)[number];
export type EffectiveLimits = Record<UserLimitField, number>;
// Where a value comes from: the account, a group (its key) or the default.
// For storage also the add-on groups added on top (`addons`, only when
// there are any; `base` is then the value before them) and, with an own
// value, the add-ons that were not added (`ignoredAddons`).
export type LimitAddon = { group: string; mb: number };
export type LimitSource = { from: "user" | "group" | "default"; group: string | null; base?: number; addons?: LimitAddon[]; ignoredAddons?: LimitAddon[] };
export type GroupLimitRule = { target: string; limits: GroupLimits };

const clean = <T extends object>(limits: T) => Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== null && v !== undefined)) as T;
const parseLimits = (raw: string | null | undefined): UserLimits => {
  try {
    const parsed = userLimitsSchema.safeParse(JSON.parse(raw || "{}"));
    return parsed.success ? clean(parsed.data) : {};
  } catch {
    return {};
  }
};
// A group's row; "limit" is the default and not stored.
const parseGroupLimits = (raw: string | null | undefined): GroupLimits => {
  try {
    const parsed = groupLimitsSchema.safeParse(JSON.parse(raw || "{}"));
    if (!parsed.success) return parseLimits(raw);
    const out = clean(parsed.data);
    if (out.storageMode !== "add") delete out.storageMode;
    return out;
  } catch {
    return {};
  }
};
const isAddon = (l: GroupLimits) => l.storageMode === "add" && typeof l.storageMb === "number" && l.storageMb > 0;
export async function groupLimitRules(): Promise<GroupLimitRule[]> {
  try {
    return (await all<{ target: string; limits: string }>("SELECT target,limits FROM group_limits ORDER BY target")).map((r) => ({ target: r.target, limits: parseGroupLimits(r.limits) }));
  } catch {
    return [];
  }
}
// More is more generous; 0 (storage, workspaces) is unlimited.
const generous = (a: number, b: number) => (a === 0 || b === 0 ? 0 : Math.max(a, b));
// Pure: what applies, with where each value comes from.
export function resolveUserLimits(own: UserLimits, rules: GroupLimitRule[], groups: string[], settings: Pick<InstanceSettings, "defaultUserStorageMb" | "defaultUserWorkspaces" | "maxUploadMb">) {
  const fallback: EffectiveLimits = { storageMb: settings.defaultUserStorageMb ?? 0, workspaces: settings.defaultUserWorkspaces ?? 0, uploadMb: settings.maxUploadMb };
  // In a fixed order: among equal values the first key decides.
  const mine = rules.filter((r) => groups.includes(r.target)).sort((a, b) => a.target.localeCompare(b.target));
  const addons: LimitAddon[] = mine.filter((r) => isAddon(r.limits)).map((r) => ({ group: r.target, mb: r.limits.storageMb! }));
  const values = {} as EffectiveLimits;
  const sources = {} as Record<UserLimitField, LimitSource>;
  for (const field of USER_LIMIT_FIELDS) {
    const value = own[field];
    if (typeof value === "number") {
      values[field] = value;
      sources[field] = { from: "user", group: null };
      // An explicit value for the person: add-ons are not added.
      if (field === "storageMb" && addons.length) sources[field].ignoredAddons = addons;
      continue;
    }
    let best: { value: number; group: string } | null = null;
    for (const r of mine) {
      // Add-on storage (and an add-on without a value) is no limit.
      if (field === "storageMb" && r.limits.storageMode === "add") continue;
      const v = r.limits[field];
      if (typeof v !== "number") continue;
      if (!best || (generous(best.value, v) === v && v !== best.value)) best = { value: v, group: r.target };
    }
    values[field] = best ? best.value : fallback[field];
    sources[field] = best ? { from: "group", group: best.group } : { from: "default", group: null };
    // Add-ons on top of a limited base; unlimited stays unlimited.
    if (field === "storageMb" && addons.length && values[field] !== 0) {
      sources[field] = { ...sources[field], base: values[field], addons };
      values[field] += addons.reduce((sum, a) => sum + a.mb, 0);
    }
  }
  return { values, sources };
}
export async function userLimitDetails(userId: string) {
  const own = await storedUserLimits(userId);
  const settings = await instanceSettings();
  const rules = await groupLimitRules();
  return resolveUserLimits(own, rules, rules.length ? await personGroupKeys(userId) : [], settings);
}
// What applies to a person: own value, else their groups', else the
// default. 0 = unlimited.
export async function effectiveUserLimits(userId: string): Promise<EffectiveLimits> {
  return (await userLimitDetails(userId)).values;
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
  const settings = await instanceSettings();
  const rules = await groupLimitRules();
  const groupsOf = rules.length ? await allGroupKeys() : new Map<string, string[]>();
  return await mapAsync(await all<{ id: string; limits: string | null }>("SELECT id,limits FROM users WHERE demo_until IS NULL AND subject NOT LIKE 'deleted:%'"), async ({ id, limits }) => {
    const own = parseLimits(limits);
    const resolved = resolveUserLimits(own, rules, groupsOf.get(id) || [], settings);
    return {
      id,
      bytes: bytes.get(id) || 0,
      workspaces: owned.get(id) || 0,
      memberOf: memberOf.get(id) || [],
      limits: own,
      effective: resolved.values,
      sources: resolved.sources,
    };
  });
}

/* ---------- Limits per group (Administration → Grenzen & Aufbewahrung) ---------- */

const groupTarget = z.string().min(1).max(MAX_DIRECTORY_NAME + 10);
const groupLimitInput = z.object({ target: groupTarget, limits: groupLimitsSchema.nullable() });
// admin.groupLimits: the limits of one group; null removes the row ({}: a
// row without values yet – the group's members get what they would anyway).
export async function setGroupLimits(actorId: string, raw: unknown) {
  const b = groupLimitInput.parse(raw);
  // 0 means unlimited for a limit; as an add-on it would mean nothing.
  if (b.limits?.storageMode === "add" && b.limits.storageMb === 0) throw new HttpError(400, "Ein Add-on braucht mindestens 1 MB.");
  // "limit" is the default: stored rows only carry storageMode "add".
  const clean: GroupLimits = Object.fromEntries(Object.entries(b.limits || {}).filter(([k, v]) => v !== null && v !== undefined && !(k === "storageMode" && v !== "add")));
  if (b.limits === null) await run("DELETE FROM group_limits WHERE target=?", b.target);
  else {
    if (!(await validGroupKey(b.target))) throw new HttpError(404, "Gruppe nicht gefunden.");
    await run(
      "INSERT INTO group_limits(target,limits,updated_at) VALUES(?,?,?) ON CONFLICT(target) DO UPDATE SET limits=excluded.limits,updated_at=excluded.updated_at",
      b.target,
      JSON.stringify(clean),
      Date.now(),
    );
  }
  await audit(actorId, "admin.groupLimits", b.target, b.limits === null ? "removed" : JSON.stringify(clean));
  return await groupLimitsView();
}
// The rules and the groups to choose from (names for both).
export async function groupLimitsView() {
  const rules = await groupLimitRules();
  return { rules, groups: await groupChoices(rules.map((r) => r.target)) };
}
export type GroupLimitsView = Awaited<ReturnType<typeof groupLimitsView>>;
// The names of a person's groups that set one of their limits.
export async function limitGroupNames(keys: string[]) {
  const out: Record<string, string> = {};
  for (const key of new Set(keys)) {
    if (key.startsWith("dir:")) out[key] = key.slice(4);
    else {
      const g = await one<{ name: string }>("SELECT name FROM groups WHERE id=?", key);
      if (g) out[key] = g.name;
    }
  }
  return out;
}
