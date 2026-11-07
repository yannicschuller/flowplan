// Notifications do not pile up forever: the inbox shows a person's newest
// 100, push and e-mail are done within days. Run by the retention worker
// (lib/version-history.ts) every six hours:
//   - read notifications go after 90 days,
//   - unread ones after a year,
//   - and beyond a person's newest 1,000 the rest go at once.
// Their push and chat app deliveries go with them (ON DELETE CASCADE).
import { run, transaction } from "./db";

export const NOTIFICATION_RETENTION = { readDays: 90, unreadDays: 365, perPerson: 1000 };

export function pruneNotifications(limits = NOTIFICATION_RETENTION) {
  return transaction(() => {
    let removed = 0;
    removed += Number(
      run(
        "DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at<datetime('now',?)",
        `-${limits.readDays} days`,
      ).changes,
    );
    removed += Number(run("DELETE FROM notifications WHERE created_at<datetime('now',?)", `-${limits.unreadDays} days`).changes);
    removed += Number(
      run(
        `DELETE FROM notifications WHERE rowid IN (
           SELECT rowid FROM (
             SELECT rowid,ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC,rowid DESC) n FROM notifications
           ) WHERE n>?)`,
        limits.perPerson,
      ).changes,
    );
    return removed;
  });
}
