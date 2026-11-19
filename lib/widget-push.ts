// Widget pushes (iOS 26 WidgetKit push updates) through the relay, type
// "widgets": when something a person's widgets could show changes, the
// instance tells their phones to reload the widgets. The push carries no
// content – the widgets fetch their data themselves with the device token
// (POST /api/mobile/widgets/data) – so it reveals only that something
// changed, and when.
//
// Marking is cheap and happens in the database (schema 115, lib/db.ts):
// triggers on notifications, records, pages, document tasks, time entries,
// focus sessions, flashcard reviews and dashboards write one row per person
// ('u') or workspace ('w') into widget_push_dirty – never more than one per
// key, and only while some app has a widget push registration. No request
// waits for anything else.
//
// The push worker (lib/push.ts, every 30 seconds and after notifications)
// then, in each round:
// 1. takes the marks older than the debounce (WIDGET_PUSH_DEBOUNCE_MS: a
//    burst of changes becomes one), claimed by deleting them – in cluster
//    mode exactly one instance gets each – and marks the devices with a
//    widget registration of that person, or of the workspace's members, as
//    pending (mobile_widget_push.pending_since);
// 2. sends one push to each pending device whose last widget push is at
//    least WIDGET_PUSH_INTERVAL_MS ago (Apple budgets widget pushes), the
//    device claimed by one UPDATE (again exactly once across instances);
//    the others wait for their budget, still pending, so nothing is lost
//    and nothing is sent while nothing changed.
// Installations of inactive profiles (`push: false`) get widget pushes too:
// their widgets show that profile. Profiles of one phone on this instance
// share its widget token: one push (and one budget) for all of them.
import { all, one, run } from "./db";
import { deviceIdentity, openWidgetToken } from "./mobile-devices";
import { sendBatched, type RelayMessage, type RelayResult, type RelaySender } from "./push-relay";
import { forEachAsync } from "./each-async";

// Changes are collected this long before the devices are marked.
export const WIDGET_PUSH_DEBOUNCE_MS = 30_000;
// At most one widget push per device in this time.
export const WIDGET_PUSH_INTERVAL_MS = 5 * 60_000;
const BATCH = 200;

// The message for one device: no payload, normal priority (APNs priority 5
// at the relay); an hour later a reload no longer matters.
export const widgetMessage = (to: string): RelayMessage => ({
  to,
  type: "widgets",
  category: null,
  collapseId: null,
  badge: null,
  priority: "normal",
  ttl: 3600,
  liveActivity: null,
});

export async function widgetPushWaiting(now = Date.now()) {
  return (
    !!(await one("SELECT 1 FROM widget_push_dirty WHERE at<=? LIMIT 1", now - WIDGET_PUSH_DEBOUNCE_MS)) ||
    !!(await one("SELECT 1 FROM mobile_widget_push WHERE pending_since IS NOT NULL AND (sent_at IS NULL OR sent_at<=?) LIMIT 1", now - WIDGET_PUSH_INTERVAL_MS))
  );
}

// Step 1: the marks past the debounce become pending devices.
export async function expandWidgetMarks(now = Date.now()) {
  const marks = await all<{ scope: "u" | "w"; key: string; at: number }>(
    "SELECT scope,key,at FROM widget_push_dirty WHERE at<=? ORDER BY at LIMIT ?",
    now - WIDGET_PUSH_DEBOUNCE_MS,
    BATCH,
  );
  let devices = 0;
  for (const mark of marks) {
    // Claimed by removing it; a change after this marks anew.
    if (!(await run("DELETE FROM widget_push_dirty WHERE scope=? AND key=? AND at=?", mark.scope, mark.key, mark.at)).changes) continue;
    const owners =
      mark.scope === "u"
        ? "SELECT d.id FROM mobile_devices d WHERE d.user_id=?"
        : "SELECT d.id FROM mobile_devices d JOIN members m ON m.user_id=d.user_id WHERE m.workspace_id=?";
    devices += (await run(`UPDATE mobile_widget_push SET pending_since=? WHERE pending_since IS NULL AND device_id IN (${owners})`, now, mark.key)).changes;
  }
  return devices;
}

// A registration goes, with those of the phone's other profiles (same token).
const forget = async (tokenHash: string) => await run("DELETE FROM mobile_widget_push WHERE token_hash=?", tokenHash);

// Steps 1 and 2; `send` is the relay (tests pass their own). Returns how
// many pushes went out.
export async function flushWidgetPushes(send: RelaySender, now = Date.now()) {
  await expandWidgetMarks(now);
  const due = await all<{ device_id: string; relay_token: string; token_hash: string; pending_since: number }>(
    "SELECT device_id,relay_token,token_hash,pending_since FROM mobile_widget_push WHERE pending_since IS NOT NULL AND (sent_at IS NULL OR sent_at<=?) ORDER BY pending_since LIMIT ?",
    now - WIDGET_PUSH_INTERVAL_MS,
    BATCH,
  );
  const batch: { tokenHash: string; pendingSince: number; message: RelayMessage }[] = [];
  for (const item of due) {
    // Claimed: this instance sends it, and the budget starts now.
    if (
      !(await run(
        "UPDATE mobile_widget_push SET pending_since=NULL,sent_at=? WHERE device_id=? AND pending_since IS NOT NULL AND (sent_at IS NULL OR sent_at<=?)",
        now,
        item.device_id,
        now - WIDGET_PUSH_INTERVAL_MS,
      )).changes
    )
      continue;
    // The phone's other profiles share the token: this push reloads their
    // widgets too and counts for their budget.
    await run("UPDATE mobile_widget_push SET pending_since=NULL,sent_at=? WHERE token_hash=? AND device_id<>?", now, item.token_hash, item.device_id);
    // The session ended (its device entry goes with it): nothing to reload.
    if (!(await deviceIdentity(item.device_id))) continue;
    let to: string;
    try {
      to = openWidgetToken(item.device_id, item.relay_token);
    } catch {
      await run("DELETE FROM mobile_widget_push WHERE device_id=?", item.device_id);
      continue;
    }
    batch.push({ tokenHash: item.token_hash, pendingSince: Number(item.pending_since), message: widgetMessage(to) });
  }
  if (!batch.length) return 0;
  const results = await sendBatched(
    batch.map((b) => b.message),
    send,
  );
  await forEachAsync(batch, async (item, i) => await outcome(item, results[i]));
  return batch.length;
}

async function outcome(item: { tokenHash: string; pendingSince: number }, result: RelayResult) {
  switch (result.status) {
    case "ok":
      return;
    case "gone":
    case "forbidden":
    case "invalid":
      // The widget registration is no longer valid; the app registers anew.
      await forget(item.tokenHash);
      return;
    case "rate_limited":
      // Pending again, sent once the relay allows it.
      await run(
        "UPDATE mobile_widget_push SET pending_since=COALESCE(pending_since,?),sent_at=? WHERE token_hash=?",
        item.pendingSince,
        Date.now() + (result.retryAfter ?? 60) * 1000 - WIDGET_PUSH_INTERVAL_MS,
        item.tokenHash,
      );
      return;
    default:
      // Not delivered: still pending, tried again after the interval.
      await run("UPDATE mobile_widget_push SET pending_since=COALESCE(pending_since,?) WHERE token_hash=?", item.pendingSince, item.tokenHash);
  }
}
