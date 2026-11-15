// The person's settings level (#294, lib/settings-level.ts), kept in
// users.settings_level (NULL: none of their own – the instance's default,
// settingsLevelDefault). The person changes it at the top of Settings
// (profile.settingsLevel); administrators set it per person or back to the
// instance's default (admin.settingsLevel, Administration → Benutzer).
import { z } from "zod";
import { HttpError } from "./auth";
import { one, run } from "./db";
import { instanceSettings } from "./instance-settings";
import { isSettingsLevel, settingsLevelSchema, type SettingsLevel, type SettingsLevelBoot } from "./settings-level";
import type { Identity } from "./types";

// The level that applies: the own one, without one the instance's default.
async function effectiveLevel(stored: string | null | undefined): Promise<SettingsLevel> {
  return isSettingsLevel(stored) ? stored : (await instanceSettings()).settingsLevelDefault;
}

export async function userSettingsLevel(userId: string): Promise<SettingsLevelBoot> {
  const stored = (await one<{ settings_level: string | null }>("SELECT settings_level FROM users WHERE id=?", userId))?.settings_level;
  return { level: await effectiveLevel(stored), own: isSettingsLevel(stored) };
}

// profile.settingsLevel: the person's own level (one of the three).
export async function setUserSettingsLevel(user: Identity, input: unknown) {
  const level = settingsLevelSchema.parse(input);
  await run("UPDATE users SET settings_level=? WHERE id=?", level, user.id);
  return { settingsLevel: { level, own: true } satisfies SettingsLevelBoot };
}

// admin.settingsLevel: an administrator sets a person's level, null for the
// instance's default (no own value). Where the person's own choice lives,
// so they see it and can change it again.
export const adminSettingsLevelSchema = z.object({ userId: z.uuid(), level: settingsLevelSchema.nullable() });
export async function adminSetSettingsLevel(input: unknown) {
  const b = adminSettingsLevelSchema.parse(input);
  if (!(await run("UPDATE users SET settings_level=? WHERE id=? AND demo_until IS NULL", b.level, b.userId)).changes)
    throw new HttpError(404, "Benutzer nicht gefunden.");
  return { level: b.level, effective: await effectiveLevel(b.level) };
}
