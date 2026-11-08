// The database settings a version of a database keeps beside its
// properties, views and records: those that name options (the done rule,
// workflow, automations and the issue sync's status mapping). Restoring
// the version puts them back, so they match the restored options again –
// after a renamed or merged option (#173), as after any other change.
// Sprints, time tracking, the Git connection and the rest of the issue
// sync stay as they are.
import { one, run } from "./db";
import { databaseSettings, stampAutomation } from "./database-settings";
import { settingsSchema, type DatabaseSettings } from "./database-settings-schema";
import { issueSyncConfigSchema } from "./issue-sync";
import type { Identity } from "./types";

const KEPT = ["done", "workflow", "automations"] as const;
type Kept = Pick<DatabaseSettings, (typeof KEPT)[number]>;

export async function versionSettings(pageId: string) {
  const current = await databaseSettings(pageId);
  const settings: Kept = {};
  for (const key of KEPT) if (current[key] !== undefined) Object.assign(settings, { [key]: current[key] });
  const sync = await one<{ config: string }>("SELECT config FROM issue_sync_maps WHERE page_id=?", pageId);
  let status: unknown = null;
  try {
    status = sync ? (JSON.parse(sync.config).status ?? null) : null;
  } catch {}
  // Without a sync, nothing is kept for it (and a restore leaves it alone).
  return { settings, ...(sync ? { issueSyncStatus: status } : {}) };
}

// Versions from before (without `settings`) and imported ones leave the
// settings as they are. A rule that comes back changed acts for the person
// restoring it, as if they had saved it (lib/database-settings.ts).
export async function restoreVersionSettings(user: Identity, pageId: string, data: { settings?: unknown; issueSyncStatus?: unknown }) {
  if (data.settings && typeof data.settings === "object") {
    const current = await databaseSettings(pageId);
    const next: Record<string, unknown> = { ...current };
    for (const key of KEPT) {
      const value = (data.settings as Record<string, unknown>)[key];
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    const parsed = settingsSchema.safeParse(next);
    if (parsed.success) {
      const previous = new Map((current.automations || []).map((a) => [a.id, a]));
      for (const a of parsed.data.automations || []) stampAutomation(user, a, previous.get(a.id));
      await run("UPDATE databases SET settings=? WHERE page_id=?", JSON.stringify(parsed.data), pageId);
    }
  }
  if (data.issueSyncStatus === undefined) return;
  const sync = await one<{ config: string }>("SELECT config FROM issue_sync_maps WHERE page_id=?", pageId);
  if (!sync) return;
  const status = issueSyncConfigSchema.shape.status.safeParse(data.issueSyncStatus);
  let config: { status?: { field: string } | null };
  try {
    config = JSON.parse(sync.config);
  } catch {
    return;
  }
  // Only the mapping of the same property: a sync set up on another
  // property since then keeps its own.
  if (!status.success || !status.data || !config.status || config.status.field !== status.data.field) return;
  await run("UPDATE issue_sync_maps SET config=? WHERE page_id=?", JSON.stringify({ ...config, status: status.data }), pageId);
}
