// Accounts that have not signed in for the configured number of days are
// disabled (Administration → Instanz). A disabled account loses its
// sessions and API tokens stop working; an admin can enable it again, and
// the next sign-in through the identity provider needs that.
import { all, run } from "./db";
import { instanceSettings } from "./instance-settings";

export function disableInactiveAccounts(now = Date.now()) {
  const days = instanceSettings().inactiveDays;
  if (!days) return [];
  const cutoff = now - days * 86400_000;
  const stale = all<{ id: string }>(
    `SELECT id FROM users WHERE disabled=0 AND demo_until IS NULL
       AND COALESCE(last_login_at, CAST(strftime('%s', created_at) AS INTEGER) * 1000) < ?`,
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
