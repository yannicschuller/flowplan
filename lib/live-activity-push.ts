// Live Activities (iOS) updated by push through the relay (PROTOCOL.md §3,
// type "liveactivity"): the focus session and the running timer, whose
// state the instance changes itself (lib/live-activity-queue.ts marks the
// change; lib/push.ts calls flushLiveActivities with its queue).
//
// The app draws its activities with expo-widgets, whose ActivityKit content
// state is { name: <the view>, props: <the view's props as a JSON string> }
// (expo-widgets ios/Widgets/WidgetLiveActivity.swift). A push replaces the
// whole state, so it carries every prop the view reads, exactly as the app
// sets them itself (flowplan-app src/activities.ts → focusActivity,
// src/summary.ts → timerProps): the texts in the app's language and time
// zone come from the app (liveActivityLabels, lib/mobile-devices.ts).
//
// The content state is rendered by iOS and cannot be encrypted, so it passes
// the relay and Apple in plain text. By default it holds only times, the
// phase and the app's own labels – the view's title is the label ("Focus",
// "Time tracking"), the link opens the app's start page. Only with
// MOBILE_PUSH_CONTENT=on does it carry the task's title, database and link.
//
//   FlowplanFocus  { phase, label, title, endsAt, startedAt, untilLabel, stopLabel, url }   (ms)
//   FlowplanTimer  { title, database, start, label, url }                                   (ms)
//
// Without the app's labels (older app versions) only the end of an activity
// is pushed – it disappears at once, so its texts do not matter.
import { all, one, run } from "./db";
import { deviceIdentity, liveLabelsSchema, openLiveToken, type LiveActivityKind, type LiveLabels } from "./mobile-devices";
import { focusState, runningTimer } from "./mobile-widgets";
import { pushContent, sendBatched, type RelayMessage, type RelayResult, type RelaySender } from "./push-relay";
import type { Identity } from "./types";

const MAX_ATTEMPTS = 5;
const backoff = (attempts: number) => Math.min(600_000, 30_000 * 2 ** attempts);
const seconds = (ms: number) => Math.floor(ms / 1000);
// The relay's limit for a content state is 2 KB (JSON).
const MAX_STATE_BYTES = 1900;

// The views of the app (createLiveActivity names in src/widgets/ios.tsx).
export const LIVE_ACTIVITY_VIEWS = { focus: "FlowplanFocus", timer: "FlowplanTimer" } as const;
// The app's links (src/navigation.ts → appLink).
export const appLink = (path: string) => `flowplan://open?path=${encodeURIComponent(path)}`;
const appPath = (url: unknown) => (typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !/[\\\s]/.test(url) ? url : "/");

export type FocusViewProps = { phase: "focus" | "break"; label: string; title: string; endsAt: number; startedAt: number; untilLabel: string; stopLabel: string; url: string };
export type TimerViewProps = { title: string; database: string; start: number; label: string; url: string };

// What the app's clock() shows (src/activities.ts), in the phone's time zone.
const clock = (ms: number, labels: LiveLabels) =>
  new Intl.DateTimeFormat(labels.locale, { hour: "2-digit", minute: "2-digit", timeZone: labels.timeZone }).format(new Date(ms));

// Texts for an end without the app's labels (shown for no time at all).
const NO_LABELS: LiveLabels = { locale: "en", timeZone: "UTC", focus: { focus: "Flowplan", break: "Flowplan", until: "{time}", stop: "End" }, timer: { label: "Flowplan" } };

export function parseLiveLabels(raw: string | null | undefined): LiveLabels | null {
  if (!raw) return null;
  try {
    const parsed = liveLabelsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// The content state, kept under the relay's limit by shortening the title.
export function contentState(kind: LiveActivityKind, props: FocusViewProps | TimerViewProps): Record<string, unknown> {
  let current = { ...props };
  for (;;) {
    const state = { name: LIVE_ACTIVITY_VIEWS[kind], props: JSON.stringify(current) };
    if (Buffer.byteLength(JSON.stringify(state), "utf8") <= MAX_STATE_BYTES || !current.title) return state;
    current = { ...current, title: [...current.title].slice(0, Math.max(0, [...current.title].length - 20)).join("") };
  }
}

export function focusProps(
  state: { phase: "focus" | "break"; startedAt: number; focusEndsAt: number; breakEndsAt: number; task: { title: string; url: string } | null },
  labels: LiveLabels,
  content: boolean,
): FocusViewProps {
  const inBreak = state.phase === "break";
  const endsAt = inBreak ? state.breakEndsAt : state.focusEndsAt;
  const label = inBreak ? labels.focus.break : labels.focus.focus;
  const task = content ? state.task : null;
  return {
    phase: state.phase,
    label,
    title: task?.title ? task.title.slice(0, 120) : label,
    endsAt,
    startedAt: inBreak ? state.focusEndsAt : state.startedAt,
    untilLabel: labels.focus.until.replace("{time}", clock(endsAt, labels)),
    stopLabel: labels.focus.stop,
    url: appLink(task ? appPath(task.url) : "/"),
  };
}

export function timerProps(timer: { start: number; title: string; database: string; url: string }, labels: LiveLabels, content: boolean): TimerViewProps {
  const label = labels.timer.label;
  if (!content) return { title: label, database: "", start: timer.start, label, url: appLink("/") };
  return {
    title: (timer.title || timer.database || label).slice(0, 120),
    database: timer.title ? timer.database.slice(0, 120) : "",
    start: timer.start,
    label,
    url: appLink(appPath(timer.url)),
  };
}

type Built = { message: Omit<RelayMessage, "to">; end: boolean };

// The push for this activity now; null when nothing may be sent (an update
// without the app's labels).
export function liveActivityMessage(kind: LiveActivityKind, user: Identity, labels: LiveLabels | null, now = Date.now()): Built | null {
  const content = pushContent("live");
  const end = (props: FocusViewProps | TimerViewProps): Built => ({
    end: true,
    message: {
      type: "liveactivity",
      category: null,
      collapseId: null,
      badge: null,
      priority: "high",
      ttl: 3600,
      // Gone at once, as the app ends them itself ("immediate").
      liveActivity: { event: "end", contentState: contentState(kind, props), staleDate: null, dismissalDate: seconds(now) },
    },
  });
  const update = (props: FocusViewProps | TimerViewProps, staleAt: number | null): Built => ({
    end: false,
    message: {
      type: "liveactivity",
      category: null,
      collapseId: null,
      badge: null,
      priority: "high",
      ttl: staleAt ? Math.max(60, Math.min(2_419_200, seconds(staleAt - now))) : 3600,
      liveActivity: { event: "update", contentState: contentState(kind, props), staleDate: staleAt ? Math.ceil(staleAt / 1000) : null, dismissalDate: null },
    },
  });
  const texts = labels ?? NO_LABELS;
  if (kind === "focus") {
    const state = focusState(user, now);
    if (state.phase === "idle")
      return end(focusProps({ phase: "focus", startedAt: now, focusEndsAt: now, breakEndsAt: now, task: null }, texts, false));
    if (!labels) return null;
    const props = focusProps(
      { phase: state.phase, startedAt: state.startedAt, focusEndsAt: state.focusEndsAt, breakEndsAt: state.breakEndsAt, task: state.task },
      labels,
      content,
    );
    return update(props, props.endsAt);
  }
  const timer = runningTimer(user);
  if (!timer) return end(timerProps({ start: now, title: "", database: "", url: "/" }, texts, false));
  if (!labels) return null;
  return update(timerProps(timer, labels, content), null);
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
    const stored = one<{ relay_token: string; labels: string | null }>(
      "SELECT relay_token,labels FROM mobile_live_activities WHERE device_id=? AND kind=?",
      item.device_id,
      item.kind,
    );
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
    const built = liveActivityMessage(item.kind, user, parseLiveLabels(stored.labels), now);
    if (!built) continue;
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
