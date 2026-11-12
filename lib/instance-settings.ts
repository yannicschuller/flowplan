import { z } from "zod";
import { all, run } from "./db";
import { HttpError } from "./auth";
import { updateNotesLevelSchema } from "./update-notes-pref";

// Instance-wide settings admins change in the interface. Environment
// variables stay the defaults; stored values take precedence.
export const instanceSettingsSchema = z.object({
  name: z.string().trim().max(60),
  announcement: z.string().trim().max(500),
  defaultQuotaMb: z.number().int().min(0).max(10_000_000).nullable(),
  retentionDays: z.number().int().min(0).max(36500).nullable(),
  // Days in the trash before pages, spaces, records and templates are
  // deleted for good (0 = never; lib/trash.ts).
  trashDays: z.number().int().min(0).max(3650).default(30),
  maxUploadMb: z.number().int().min(1).max(1024),
  allowWorkspaceCreation: z.boolean(),
  // Anyone may create an account with e-mail and password (the first
  // account of an instance always may; invited addresses always may).
  allowSignup: z.boolean().default(false),
  // "Demo ausprobieren" on the start page: throwaway accounts for visitors.
  publicDemo: z.boolean().default(false),
  // Daily database copy (S3 bucket or backups/ in the data folder).
  backupSchedule: z.boolean().default(true),
  backupKeep: z.number().int().min(1).max(365).default(7),
  // Hourly instead of daily: for encrypted copies in place of Litestream.
  backupInterval: z.enum(["daily", "hourly"]).default("daily"),
  // Accounts without sign-in for this many days are disabled (null = never).
  inactiveDays: z.number().int().min(30).max(3650).nullable().default(null),
  // Accounts without any use for this many days are deleted, after an
  // e-mail 14 and 3 days before (null = never; lib/inactive-accounts.ts).
  deleteInactiveDays: z.number().int().min(60).max(3650).nullable().default(null),
  // Defaults for every account without its own limits (0 = unlimited).
  defaultUserStorageMb: z.number().int().min(0).max(10_000_000).nullable().default(null),
  defaultUserWorkspaces: z.number().int().min(0).max(10_000).nullable().default(null),
  // Two-factor sign-in for accounts with e-mail and password: not required,
  // required for administrators, or for everyone (lib/two-factor-policy.ts).
  twoFactor: z.enum(["off", "admins", "all"]).default("off"),
  // Block extensions from any HTTPS address, not only the origins listed in
  // PLUGIN_ALLOWED_ORIGINS (lib/plugins.ts).
  pluginsAnyOrigin: z.boolean().default(false),
  // Owners may serve publications under their own domain (lib/custom-domains.ts).
  customDomains: z.boolean().default(false),
  // Publishing to and importing from the Flowplan Marketplace (lib/marketplace-config.ts);
  // FLOWPLAN_MARKETPLACE_URL=off switches it off regardless.
  marketplace: z.boolean().default(true),
  // How long sessions last (lib/session-policy.ts). null follows the
  // environment (SESSION_HOURS, SESSION_REMEMBER, SESSION_IDLE_HOURS,
  // SESSION_APP_REMEMBER, SESSION_APP_DAYS) and its defaults.
  // Hours after signing in for a session without "Stay signed in".
  sessionHours: z.number().int().min(1).max(24).nullable().default(null),
  // Browsers offer "Stay signed in".
  sessionRemember: z.boolean().nullable().default(null),
  // Days without use until a remembered browser session ends.
  rememberDays: z.number().int().min(1).max(365).nullable().default(null),
  // The desktop and mobile apps stay signed in ("remember"), or their
  // sessions end like a browser's without "Stay signed in" ("off").
  appSessions: z.enum(["remember", "off"]).nullable().default(null),
  // Days without use until an app's session ends.
  appDays: z.number().int().min(1).max(365).nullable().default(null),
  // "Neuigkeiten nach Updates" that new accounts start with (#223,
  // lib/update-notes-pref.ts); existing accounts keep theirs.
  updateNotesDefault: updateNotesLevelSchema.default("all"),
});
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;
const defaults: InstanceSettings = {
  name: "",
  announcement: "",
  defaultQuotaMb: null,
  retentionDays: null,
  trashDays: 30,
  maxUploadMb: 10,
  allowWorkspaceCreation: true,
  allowSignup: false,
  publicDemo: false,
  backupSchedule: true,
  backupKeep: 7,
  backupInterval: "daily",
  inactiveDays: null,
  deleteInactiveDays: null,
  defaultUserStorageMb: null,
  defaultUserWorkspaces: null,
  twoFactor: "off",
  pluginsAnyOrigin: false,
  customDomains: false,
  marketplace: true,
  sessionHours: null,
  sessionRemember: null,
  rememberDays: null,
  appSessions: null,
  appDays: null,
  updateNotesDefault: "all",
};
// Read on every use: route handlers and pages run as separate module
// instances, so an in-memory cache would go stale.
export async function instanceSettings(): Promise<InstanceSettings> {
  let stored: Record<string, unknown> = {};
  try {
    stored = Object.fromEntries(
      (await all<{ key: string; value: string }>(
        "SELECT key,value FROM instance_settings",
      )).map((row) => [row.key, JSON.parse(row.value)]),
    );
  } catch {}
  const parsed = instanceSettingsSchema.safeParse({ ...defaults, ...stored });
  return parsed.success ? parsed.data : defaults;
}
export async function saveInstanceSettings(input: unknown) {
  // Fields a form does not send keep their stored value.
  const next = instanceSettingsSchema.parse({
    ...(await instanceSettings()),
    ...(input && typeof input === "object" ? input : {}),
  });
  // Deleting comes after blocking, never before it.
  if (next.deleteInactiveDays && next.inactiveDays && next.deleteInactiveDays <= next.inactiveDays)
    throw new HttpError(400, "Löschen muss später kommen als Sperren: mehr Tage als bei „Inaktive Konten sperren“.");
  for (const [key, value] of Object.entries(next))
    await run(
      "INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  return await instanceSettings();
}
