import { z } from "zod";
import { all, run } from "./db";

// Instance-wide settings admins change in the interface. Environment
// variables stay the defaults; stored values take precedence.
export const instanceSettingsSchema = z.object({
  name: z.string().trim().max(60),
  announcement: z.string().trim().max(500),
  defaultQuotaMb: z.number().int().min(0).max(10_000_000).nullable(),
  retentionDays: z.number().int().min(0).max(36500).nullable(),
  maxUploadMb: z.number().int().min(1).max(1024),
  allowWorkspaceCreation: z.boolean(),
  // "Demo ausprobieren" on the start page: throwaway accounts for visitors.
  publicDemo: z.boolean().default(false),
});
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;
const defaults: InstanceSettings = {
  name: "",
  announcement: "",
  defaultQuotaMb: null,
  retentionDays: null,
  maxUploadMb: 10,
  allowWorkspaceCreation: true,
  publicDemo: false,
};
// Read on every use: route handlers and pages run as separate module
// instances, so an in-memory cache would go stale.
export function instanceSettings(): InstanceSettings {
  let stored: Record<string, unknown> = {};
  try {
    stored = Object.fromEntries(
      all<{ key: string; value: string }>(
        "SELECT key,value FROM instance_settings",
      ).map((row) => [row.key, JSON.parse(row.value)]),
    );
  } catch {}
  const parsed = instanceSettingsSchema.safeParse({ ...defaults, ...stored });
  return parsed.success ? parsed.data : defaults;
}
export function saveInstanceSettings(input: unknown) {
  const next = instanceSettingsSchema.parse(input);
  for (const [key, value] of Object.entries(next))
    run(
      "INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  return instanceSettings();
}
