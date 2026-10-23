// Accounts that have not signed in (or used a session) for the configured number of days are
// disabled (Administration → Instanz). A disabled account loses its
// sessions and API tokens stop working; an admin can enable it again, and
// the next sign-in through the identity provider needs that.
import { all, run } from "./db";
import { instanceSettings } from "./instance-settings";

export function disableInactiveAccounts(now = Date.now()) {
  const days = instanceSettings().inactiveDays;
  if (!days) return [];
  const cutoff = now - days * 86400_000;
  // Long sessions (stay signed in, the apps) rarely sign in anew: their use
  // counts as activity too, in the browser and through the apps' widgets.
  const stale = all<{ id: string }>(
    `SELECT id FROM users u WHERE disabled=0 AND demo_until IS NULL
       AND COALESCE(last_login_at, CAST(strftime('%s', created_at) AS INTEGER) * 1000) < ?
       AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.last_seen>=?)
       AND NOT EXISTS (SELECT 1 FROM mobile_devices d WHERE d.user_id=u.id AND d.last_seen_at>=?)`,
    cutoff,
    cutoff,
    cutoff,
  );
  for (const u of stale) {
    run("UPDATE users SET disabled=1 WHERE id=?", u.id);
    run("DELETE FROM sessions WHERE user_id=?", u.id);
    run("INSERT INTO audit(id,actor_id,action,resource_id,detail) VALUES(lower(hex(randomblob(16))),NULL,'user.inactive',?,?)", u.id, `${days} Tage ohne Anmeldung`);
  }
  return stale.map((u) => u.id);
}

const runtime = globalThis as unknown as { flowplanInactiveTimer?: ReturnType<typeof setInterval> };
export function startInactiveWorker() {
  if (runtime.flowplanInactiveTimer) return;
  runtime.flowplanInactiveTimer = setInterval(() => {
    try {
      disableInactiveAccounts();
    } catch (error) {
      console.error("Prüfung inaktiver Konten fehlgeschlagen", error);
    }
  }, 6 * 3600_000);
  runtime.flowplanInactiveTimer.unref?.();
}
