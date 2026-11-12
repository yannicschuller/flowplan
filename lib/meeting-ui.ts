// Pure helpers of the meeting block's interface (components/meeting-block.tsx,
// #229): the pickers' lists, the quiet status line after a recording, and
// small adapters to what the processing side reports (lib/meetings.ts,
// lib/meeting-recorder.ts). The adapters accept what is there and answer
// "not available" otherwise, so the block shows a feature only when the
// server or recorder offers it.
import type { MeetingTrack } from "./meeting-core";

// ---- Attendee picker ----

export type PickerMember = { id: string; name: string; email?: string | null };
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

// Members not yet in the meeting that match the typed text (name or e-mail;
// a match at the start of a word first), at most `limit`.
export function matchMembers<T extends PickerMember>(members: T[], query: string, taken: { id?: string }[], limit = 50): T[] {
  const q = fold(query.trim());
  const ids = new Set(taken.map((a) => a.id).filter(Boolean));
  const rank = (m: T) => {
    if (!q) return 0;
    const name = fold(m.name);
    if (name.startsWith(q)) return 0;
    if (name.split(/[\s.-]+/).some((word) => word.startsWith(q))) return 1;
    if (name.includes(q)) return 2;
    if (m.email && fold(m.email).includes(q)) return 3;
    return -1;
  };
  return members
    .filter((m) => !ids.has(m.id))
    .map((m) => ({ m, r: rank(m) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.m.name.localeCompare(b.m.name))
    .slice(0, limit)
    .map((x) => x.m);
}
// The typed text as a guest – unless it is empty or names a member exactly.
export function guestName(query: string, members: PickerMember[]): string {
  const name = query.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!name) return "";
  return members.some((m) => fold(m.name) === fold(name)) ? "" : name;
}

// ---- Event picker ----

export type PickerEvent = { title: string; start: string; timed: boolean; source?: string; calendar?: boolean };
export type EventGroup<T> = { source: string; events: T[] };
// Calendar appointments grouped by their calendar (in order of the first
// appointment), each group by time – all-day ones first. Dated records of
// other databases (sync logs, tasks) come apart as `others`. An event
// without the `calendar` flag (an older server) counts as an appointment.
export function groupEvents<T extends PickerEvent>(events: T[]): { calendars: EventGroup<T>[]; others: T[] } {
  const byTime = (a: T, b: T) => Number(a.timed) - Number(b.timed) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title);
  const calendars: EventGroup<T>[] = [];
  const sorted = [...events].sort(byTime);
  for (const event of sorted) {
    if (event.calendar === false) continue;
    const source = event.source || "";
    let group = calendars.find((g) => g.source === source);
    if (!group) calendars.push((group = { source, events: [] }));
    group.events.push(event);
  }
  return { calendars, others: sorted.filter((e) => e.calendar === false) };
}

// ---- Status after a recording ----

export type MeetingStatusLike = {
  status: string;
  error: string | null;
  durationMs: number;
  sessions: { n: number; state: string; by?: string; byName?: string }[];
  audio: unknown[];
  summarizedAt?: number | null;
  [key: string]: unknown;
};
export type CalmState =
  | { kind: "new" }
  | { kind: "busy" }
  | { kind: "failed"; error: string }
  // Someone else records right now.
  | { kind: "elsewhere"; name: string }
  // A session of this person never finished (tab closed, connection lost).
  | { kind: "interrupted" }
  | { kind: "done"; durationMs: number; transcribed: boolean; summarized: boolean; note: string };

// What the block shows below its header when no recording runs here: one
// state, of which only "failed" carries a prominent action.
export function calmState(status: MeetingStatusLike | null, o: { userId: string; transcript: boolean; summary: boolean; recordingHere: boolean }): CalmState {
  if (!status || !status.sessions.length || status.status === "new") return { kind: "new" };
  if (status.status === "transcribing" || status.status === "summarizing") return { kind: "busy" };
  if (status.status === "failed") return { kind: "failed", error: status.error || "" };
  const open = status.sessions.filter((s) => s.state === "recording");
  if (status.status === "recording" && open.length && !o.recordingHere) {
    const mine = open.find((s) => s.by === o.userId);
    if (mine) return { kind: "interrupted" };
    return { kind: "elsewhere", name: open[0].byName || "" };
  }
  return {
    kind: "done",
    durationMs: status.durationMs,
    transcribed: o.transcript,
    summarized: o.summary,
    // "done" with an error: the transcript is there, the summary is not.
    note: status.status === "done" ? status.error || "" : "",
  };
}

// ---- Adapters to the processing side ----

// The technical cause of an error; the server sends it to administrators only.
export function errorDetail(status: Record<string, unknown> | null): string {
  const value = status?.errorDetail ?? status?.error_detail;
  return typeof value === "string" ? value.trim() : "";
}
// Whether "Transcribe again" is offered: while the audio is kept
// (POST /api/meetings/{id}/retranscribe), not while it is processed.
export function canRetranscribe(status: Record<string, unknown> | null): boolean {
  if (!status || !Array.isArray(status.audio) || !status.audio.length) return false;
  return !["recording", "transcribing", "summarizing"].includes(String(status.status));
}
// The workspace's glossary (names and terms for the speech recognition),
// when the server has one: a list, or text with one entry per line or comma.
export function glossaryOf(settings: Record<string, unknown> | null): string[] | null {
  const value = settings?.glossary;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string")
    return value
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean);
  return null;
}
// The glossary with one more entry, in the shape the server keeps it.
export function withGlossaryEntry(settings: Record<string, unknown>, entry: string): string[] | string {
  const list = glossaryOf(settings) || [];
  const next = list.some((v) => v.toLowerCase() === entry.trim().toLowerCase()) ? list : [...list, entry.trim()];
  return typeof settings.glossary === "string" ? next.join("\n") : next;
}
// Whether new transcripts open unlocked (an optional workspace default).
export function transcriptEditableByDefault(settings: Record<string, unknown> | null): boolean {
  return settings?.transcriptEditable === true || settings?.transcriptLocked === false;
}

// Levels per source, 0…1, from whatever the recorder reports: an object
// ({ me: 0.4, others: 0.1 }), or a track and a level.
export type Levels = Partial<Record<MeetingTrack, number>>;
export function normalizeLevels(...args: unknown[]): Levels {
  const clamp = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));
  const [first, second] = args;
  if (typeof first === "string" && typeof second === "number") return { [first as MeetingTrack]: clamp(second) };
  if (first && typeof first === "object") {
    const out: Levels = {};
    const source = ((first as { levels?: unknown }).levels as Record<string, unknown>) || (first as Record<string, unknown>);
    for (const track of ["me", "others", "mixed"] as MeetingTrack[]) if (track in source) out[track] = clamp(source[track]);
    return out;
  }
  return {};
}
// The source that stays silent while the other has sound, if the recorder
// says so (its state's `silentSource`, or the level report's `silent`).
export function silentSourceOf(...reports: unknown[]): MeetingTrack | null {
  for (const report of reports) {
    if (!report || typeof report !== "object") continue;
    const value = (report as { silentSource?: unknown; silent?: unknown }).silentSource ?? (report as { silent?: unknown }).silent;
    if (value === "me" || value === "others" || value === "mixed") return value;
  }
  return null;
}
