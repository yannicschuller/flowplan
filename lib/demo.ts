// Public demo from the start page: a throwaway account with its own
// workspace and example content. It ends after 45 minutes without activity
// (at most three hours) or with "Demo beenden"; then account, workspace and
// files are deleted. Demo accounts cannot publish, share, invite or create
// further workspaces, and new demos are limited per address and in total.
import { createHash, randomUUID } from "node:crypto";
import { all, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { createWorkspace } from "./seed";
import { instanceSettings } from "./instance-settings";
import { purgeWorkspace } from "./workspace-lifecycle";

export const DEMO_IDLE_MS = 45 * 60_000;
export const DEMO_MAX_MS = 3 * 3600_000;
const MAX_ACTIVE = 40;
const MAX_PER_ADDRESS_PER_HOUR = 5;
const DEMO_QUOTA_MB = 25;

// Actions a demo account may not use: everything that reaches people
// outside the demo or the instance.
const BLOCKED = new Set([
  "workspace.create",
  "share.create",
  "page.publish",
  "publication.copy",
  "member.invite",
  "member.role",
  "member.guest",
  "group.member",
]);
export function demoAllows(action: string, input: Record<string, unknown>) {
  if (BLOCKED.has(action) || action.startsWith("admin.")) return false;
  // Forms can be built, not opened to the public.
  if (action === "form.update" && input.config && typeof input.config === "object") {
    const config = input.config as Record<string, unknown>;
    if (config.enabled === true || config.anonymous === true) return false;
  }
  if (action === "form.update" && (input.enabled === true || input.anonymous === true))
    return false;
  return true;
}

let cleanupTimer: ReturnType<typeof setInterval> | undefined;
function scheduleCleanup() {
  const g = globalThis as unknown as { flowplanDemoCleanup?: boolean };
  if (g.flowplanDemoCleanup) return;
  g.flowplanDemoCleanup = true;
  cleanupTimer = setInterval(() => {
    try {
      cleanupDemos();
    } catch (error) {
      console.error("Demo-Aufräumen fehlgeschlagen", error);
    }
  }, 5 * 60_000);
  cleanupTimer.unref?.();
}

export function demoEnabled() {
  return instanceSettings().publicDemo;
}

export function startDemo(address: string) {
  if (!demoEnabled()) throw new HttpError(403, "Die Demo ist auf dieser Instanz ausgeschaltet.");
  scheduleCleanup();
  cleanupDemos();
  const now = Date.now();
  const key = createHash("sha256").update(`demo:${address}`).digest("hex");
  run("DELETE FROM demo_starts WHERE at<?", now - 3600_000);
  const recent = Number(one<{ n: number }>("SELECT COUNT(*) n FROM demo_starts WHERE address=?", key)?.n || 0);
  if (recent >= MAX_PER_ADDRESS_PER_HOUR)
    throw new HttpError(429, "Zu viele Demos von dieser Adresse. Bitte später erneut versuchen.");
  const active = Number(
    one<{ n: number }>("SELECT COUNT(*) n FROM users WHERE demo_until IS NOT NULL")?.n || 0,
  );
  if (active >= MAX_ACTIVE)
    throw new HttpError(503, "Gerade laufen zu viele Demos. Bitte in ein paar Minuten erneut versuchen.");
  run("INSERT INTO demo_starts(address,at) VALUES(?,?)", key, now);
  const uid = randomUUID();
  run(
    "INSERT INTO users(id,subject,name,email,demo_until) VALUES(?,?,?,?,?)",
    uid,
    `demo:${uid}`,
    "Demo-Gast",
    "",
    now + DEMO_MAX_MS,
  );
  const workspace = createWorkspace(uid, "Demo-Arbeitsbereich", true);
  run("UPDATE workspaces SET quota_mb=? WHERE id=?", DEMO_QUOTA_MB, workspace);
  return uid;
}

// Session length of a demo: idle timeout, never beyond its end.
export function demoSessionExpiry(demoUntil: number) {
  return Math.min(Date.now() + DEMO_IDLE_MS, demoUntil);
}

// Removes one demo account with everything it created.
export function endDemo(userId: string) {
  const user = one<{ demo_until: number | null }>("SELECT demo_until FROM users WHERE id=?", userId);
  if (!user?.demo_until) return false;
  transaction(() => {
    for (const w of all<{ id: string }>(
      "SELECT workspace_id id FROM members WHERE user_id=? AND role='owner'",
      userId,
    ))
      purgeWorkspace(w.id);
    for (const table of ["notifications", "favorites", "row_favorites", "push_subscriptions", "saved_searches", "notification_prefs"])
      try {
        run(`DELETE FROM ${table} WHERE user_id=?`, userId);
      } catch {}
    run("DELETE FROM sessions WHERE user_id=?", userId);
    run("DELETE FROM members WHERE user_id=?", userId);
    try {
      run("DELETE FROM users WHERE id=?", userId);
    } catch {
      // Still referenced somewhere: lock it for good instead.
      run("UPDATE users SET disabled=1,demo_until=NULL,name='Demo (beendet)' WHERE id=?", userId);
    }
  });
  return true;
}

// Demos past their end, or without an active session, are deleted.
export function cleanupDemos() {
  const now = Date.now();
  const stale = all<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.demo_until IS NOT NULL AND (
       u.demo_until<? OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.expires>?))`,
    now,
    now,
  );
  for (const u of stale) endDemo(u.id);
  return stale.length;
}
