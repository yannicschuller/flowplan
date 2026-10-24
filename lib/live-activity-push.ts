// Live Activities (iOS) updated by push through the relay (PROTOCOL.md §3,
// type "liveactivity"): the focus session and the running timer, whose
// state the instance changes itself (lib/live-activity-queue.ts marks the
// change; lib/push.ts calls flushLiveActivities with its queue).
//
// The content state is rendered by iOS and cannot be encrypted, so it passes
// the relay and Apple in plain text. By default it holds only times and the
// phase – the title, database and link the app shows stay in the activity's
// attributes on the phone. Only with MOBILE_PUSH_CONTENT=on does it carry the
// title too.
//
//   focus  update { phase: "focus" | "break", startedAt, endsAt }       (ms)
//          end    { phase: "idle", startedAt: null, endsAt: null }
//   timer  update { start }                                             (ms)
//          end    { start: null }
//   with MOBILE_PUSH_CONTENT=on also { title, url } (focus) or
//   { title, database, url } (timer).
import { all, one, run } from "./db";
import { deviceIdentity, openLiveToken, type LiveActivityKind } from "./mobile-devices";
import { focusState, runningTimer } from "./mobile-widgets";
import { pushContent, sendBatched, type RelayMessage, type RelayResult, type RelaySender } from "./push-relay";
import type { Identity } from "./types";

const MAX_ATTEMPTS = 5;
const backoff = (attempts: number) => Math.min(600_000, 30_000 * 2 ** attempts);
const seconds = (ms: number) => Math.floor(ms / 1000);

type Built = { message: Omit<RelayMessage, "to">; end: boolean };

export function liveActivityMessage(kind: LiveActivityKind, user: Identity, now = Date.now()): Built {
  const content = pushContent("live");
  const end = (contentState: Record<string, unknown>): Built => ({
    end: true,
    message: {
      type: "liveactivity",
      category: null,
      collapseId: null,
      badge: null,
      priority: "high",
      ttl: 3600,
      liveActivity: { event: "end", contentState, staleDate: null, dismissalDate: seconds(now) },
    },
  });
  const update = (contentState: Record<string, unknown>, staleAt: number | null): Built => ({
    end: false,
    message: {
      type: "liveactivity",
      category: null,
      collapseId: null,
      badge: null,
      priority: "high",
      ttl: staleAt ? Math.max(60, Math.min(2_419_200, seconds(staleAt - now))) : 3600,
      liveActivity: { event: "update", contentState, staleDate: staleAt ? Math.ceil(staleAt / 1000) : null, dismissalDate: null },
    },
  });
  if (kind === "focus") {
    const state = focusState(user, now);
    if (state.phase === "idle") return end({ phase: "idle", startedAt: null, endsAt: null });
    const startedAt = state.phase === "focus" ? state.startedAt : state.focusEndsAt;
    const endsAt = state.phase === "focus" ? state.focusEndsAt : state.breakEndsAt;
    return update(
      { phase: state.phase, startedAt, endsAt, ...(content ? { title: state.task?.title ?? "", url: state.task?.url ?? null } : {}) },
      endsAt,
    );
  }
  const timer = runningTimer(user);
  if (!timer) return end({ start: null });
  return update({ start: timer.start, ...(content ? { title: timer.title, database: timer.database, url: timer.url } : {}) }, null);
}

function retry(deviceId: string, kind: string, at: number, attempts: number) {
  if (attempts >= MAX_ATTEMPTS) return;
  run("INSERT OR IGNORE INTO push_live_queue(device_id,kind,available_at,attempts) VALUES(?,?,?,?)", deviceId, kind, Math.floor(at), attempts);
}
const forget = (deviceId: string, kind: string) => run("DELETE FROM mobile_live_activities WHERE device_id=? AND kind=?", deviceId, kind);

export async function flushLiveActivities(send: RelaySender, now = Date.now()) {
  const due = all<{ device_id: string; kind: LiveActivityKind; attempts: number }>(
    "SELECT device_id,kind,MAX(attempts) attempts FROM push_live_queue WHERE available_at<=? GROUP BY device_id,kind ORDER BY MIN(available_at) LIMIT 100",
    now,
  );
  const batch: { device_id: string; kind: LiveActivityKind; attempts: number; end: boolean; message: RelayMessage }[] = [];
  for (const item of due) {
    // Claimed by removing what is due; later entries (a phase end) stay.
    if (!run("DELETE FROM push_live_queue WHERE device_id=? AND kind=? AND available_at<=?", item.device_id, item.kind, now).changes) continue;
    const stored = one<{ relay_token: string }>("SELECT relay_token FROM mobile_live_activities WHERE device_id=? AND kind=?", item.device_id, item.kind);
    if (!stored) continue;
    const user = deviceIdentity(item.device_id);
    if (!user) continue;
    let to: string;
    try {
      to = openLiveToken(item.device_id, item.kind, stored.relay_token);
    } catch {
      forget(item.device_id, item.kind);
      continue;
    }
    const built = liveActivityMessage(item.kind, user, now);
    batch.push({ ...item, end: built.end, message: { to, ...built.message } });
  }
  if (!batch.length) return;
  const results = await sendBatched(
    batch.map((b) => b.message),
    send,
  );
  batch.forEach((item, i) => outcome(item, results[i]));
}

function outcome(item: { device_id: string; kind: LiveActivityKind; attempts: number; end: boolean }, result: RelayResult) {
  switch (result.status) {
    case "ok":
      // An ended activity takes no more pushes; a new one brings a new token.
      if (item.end) forget(item.device_id, item.kind);
      return;
    case "gone":
      forget(item.device_id, item.kind);
      return;
    case "forbidden":
    case "invalid":
      console.warn(`push relay: removed a Live Activity registration (${result.status})`);
      forget(item.device_id, item.kind);
      return;
    case "rate_limited":
      retry(item.device_id, item.kind, Date.now() + (result.retryAfter ?? 60) * 1000, item.attempts);
      return;
    default:
      retry(item.device_id, item.kind, Date.now() + backoff(item.attempts), item.attempts + 1);
  }
}
