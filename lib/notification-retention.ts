// Notifications do not pile up forever: the inbox shows a person's newest
// 100, push and e-mail are done within days. Run by the retention worker
// (lib/version-history.ts) every six hours:
//   - read notifications go after 90 days,
//   - unread ones after a year,
//   - and beyond a person's newest 1,000 the rest go at once.
// Their push and chat app deliveries go with them (ON DELETE CASCADE).
import { run, transaction, daysAgoText } from "./db";

export const NOTIFICATION_RETENTION = { readDays: 90, unreadDays: 365, perPerson: 1000 };

export async function pruneNotifications(limits = NOTIFICATION_RETENTION) {
  return await transaction(async () => {
    let removed = 0;
    removed += Number(
      (await run(
        "DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at<?",
        daysAgoText(limits.readDays),
      )).changes,
    );
    removed += Number((await run("DELETE FROM notifications WHERE created_at<?", daysAgoText(limits.unreadDays))).changes);
    removed += Number(
      (await run(
        `DELETE FROM notifications WHERE id IN (
           SELECT id FROM (
             SELECT id,ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC,seq DESC) n FROM notifications
           ) ranked WHERE n>?)`,
        limits.perPerson,
      )).changes,
    );
    return removed;
  });
}
