import { z } from "zod";

// "Ton bei neuen Benachrichtigungen" (#401, Settings → Notifications): a
// short, quiet sound in the open app (browser tab or the desktop app's
// window) when a new notification reaches the inbox. Phones get the system
// sound with their push, the desktop app with its system notifications;
// this is for the app in front of you. Stored per person on the server
// (users.notification_sound: NULL = the default, "soft"), delivered with
// the bootstrap. The sounds are drawn with the Web Audio API in the browser
// (lib/notification-sound-client.ts) – no audio files, nothing loaded.
//
// Pure: the choice, the tones and the decision whether a change of the
// inbox makes a sound. Shared by the browser and the server.
export const NOTIFICATION_SOUNDS = ["off", "soft", "clear", "bell"] as const;
export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number];
export const DEFAULT_NOTIFICATION_SOUND: NotificationSound = "soft";
export const notificationSoundSchema = z.enum(NOTIFICATION_SOUNDS);

// What a stored value means: anything unknown is the default.
export function notificationSoundOf(value: unknown): NotificationSound {
  return value === "off" || value === "clear" || value === "bell" ? value : DEFAULT_NOTIFICATION_SOUND;
}

// One tone: a sine or triangle wave with a quick attack and a soft decay.
// `start` and `duration` in seconds, `gain` the peak (0–1, kept low).
export type Tone = { frequency: number; wave: "sine" | "triangle"; start: number; duration: number; gain: number };
export const SOUND_TONES: Record<Exclude<NotificationSound, "off">, Tone[]> = {
  // Sanft: two low, overlapping sine notes going up (E5 → A5).
  soft: [
    { frequency: 659.25, wave: "sine", start: 0, duration: 0.2, gain: 0.05 },
    { frequency: 880, wave: "sine", start: 0.1, duration: 0.24, gain: 0.045 },
  ],
  // Klar: two short, brighter triangle notes (B5 → E6).
  clear: [
    { frequency: 987.77, wave: "triangle", start: 0, duration: 0.11, gain: 0.04 },
    { frequency: 1318.51, wave: "triangle", start: 0.1, duration: 0.15, gain: 0.035 },
  ],
  // Glocke: one struck note with a quieter overtone, ringing out.
  bell: [
    { frequency: 1046.5, wave: "sine", start: 0, duration: 0.4, gain: 0.05 },
    { frequency: 2093, wave: "sine", start: 0, duration: 0.28, gain: 0.015 },
    { frequency: 2637, wave: "sine", start: 0, duration: 0.16, gain: 0.008 },
  ],
};
// How long a sound lasts, in seconds.
export const soundLength = (sound: Exclude<NotificationSound, "off">) => Math.max(...SOUND_TONES[sound].map((t) => t.start + t.duration));

// What the decision looks at: the newest notifications as GET
// /api/notifications gives them (lib/notification-feed.ts) – server time.
export type SoundItem = { id: string; kind: string | null; createdAt: string; read: boolean };
// Kinds a person can set off themself, right now, with what they do
// (a rule or a workflow that notifies its own trigger). Every other kind
// leaves out whoever caused it on the server (mentions, comments, shares,
// changes) or is not caused by an action (reminders, security).
export const SELF_CAUSED_KINDS: ReadonlySet<string> = new Set(["automation", "workflow", "workflow_ops"]);
// Such a notification within this time of the person's own change in this
// browser counts as their own.
export const OWN_ACTION_MS = 15_000;
// Older notifications make no sound: a late look (a tab that just woke up,
// a reconnect) is no arrival.
export const FRESH_MS = 2 * 60_000;

export type SoundDecision = { play: boolean; fresh: string[] };
// Whether this look at the inbox makes a sound, and which notifications it
// saw arrive (`fresh`: remembered as heard whether or not it played).
//   sound         – the person's setting
//   items, now    – the feed and its server time
//   known         – ids already heard or seen in this browser
//   ownActionAgo  – ms since this browser's last own change (Infinity: none)
//   quiet         – "do not disturb" applies
//   handledElsewhere – the desktop app shows a system notification (with
//                   its sound) for these instead
export function soundDecision(input: {
  sound: NotificationSound;
  items: readonly SoundItem[];
  now: string | number;
  known: ReadonlySet<string>;
  ownActionAgo: number;
  quiet?: boolean;
  handledElsewhere?: boolean;
}): SoundDecision {
  const now = typeof input.now === "number" ? input.now : Date.parse(input.now);
  // New: unread, never seen here, and recent. A count going down (read,
  // deleted) or a notification marked unread again brings nothing new.
  const fresh = input.items.filter((n) => {
    if (n.read || input.known.has(n.id)) return false;
    const at = Date.parse(n.createdAt);
    return !Number.isFinite(now) || !Number.isFinite(at) || at >= now - FRESH_MS;
  });
  const ids = fresh.map((n) => n.id);
  if (!fresh.length || input.sound === "off" || input.quiet || input.handledElsewhere) return { play: false, fresh: ids };
  // The person's own doing: only self-caused kinds, right after their change.
  const own = (n: SoundItem) => !!n.kind && SELF_CAUSED_KINDS.has(n.kind) && input.ownActionAgo < OWN_ACTION_MS;
  return { play: fresh.some((n) => !own(n)), fresh: ids };
}

// The ids remembered as heard: the newest first, at most this many.
export const KNOWN_LIMIT = 200;
export function rememberKnown(known: readonly string[], fresh: readonly string[]): string[] {
  const next = [...fresh, ...known.filter((id) => !fresh.includes(id))];
  return next.slice(0, KNOWN_LIMIT);
}
