import { useSyncExternalStore } from "react";
import { DEFAULT_NOTIFICATION_SOUND, SOUND_TONES, notificationSoundOf, soundLength, type NotificationSound } from "./notification-sound";

// "Ton bei neuen Benachrichtigungen" (#401, lib/notification-sound.ts) in the
// browser: the setting (from the bootstrap and the settings), the sounds
// drawn with the Web Audio API, and the person's own changes in this
// browser (so their own rules and workflows stay quiet).
//
// Autoplay: browsers let a page make sound only after the person clicked,
// tapped or typed in it. The AudioContext is created (or resumed) on the
// first such gesture; until then nothing plays – silently, no error.

const listeners = new Set<() => void>();
let current: NotificationSound = DEFAULT_NOTIFICATION_SOUND;
export function notificationSound(): NotificationSound {
  return current;
}
export function setNotificationSoundLocal(value: unknown) {
  const next = notificationSoundOf(value);
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useNotificationSound(): NotificationSound {
  return useSyncExternalStore(subscribe, notificationSound, () => DEFAULT_NOTIFICATION_SOUND);
}

type AudioContextClass = typeof AudioContext;
let context: AudioContext | null = null;
let armed = false;
const audioClass = (): AudioContextClass | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioContextClass; webkitAudioContext?: AudioContextClass };
  return w.AudioContext || w.webkitAudioContext || null;
};
// Inside a gesture: the context is made (or resumed) and may then play.
export function unlockAudio(): AudioContext | null {
  const Audio = audioClass();
  if (!Audio) return null;
  try {
    context ??= new Audio();
    if (context.state === "suspended") void context.resume().catch(() => {});
  } catch {
    context = null;
  }
  return context;
}
// Waits for the page's first gesture (once per page).
export function armAudioUnlock() {
  if (armed || typeof window === "undefined" || !audioClass()) return;
  armed = true;
  const events = ["pointerdown", "keydown", "touchend"] as const;
  const unlock = () => {
    const ctx = unlockAudio();
    if (ctx?.state === "running") for (const name of events) window.removeEventListener(name, unlock, true);
  };
  for (const name of events) window.addEventListener(name, unlock, { capture: true, passive: true });
}
// Whether a sound could play now (the context was unlocked by a gesture).
export const audioUnlocked = () => context?.state === "running";

// Plays one of the sounds. Returns false when the browser does not allow it
// (yet): nothing plays then. `gesture`: called from a click (the preview),
// which may start the context itself.
export function playNotificationSound(sound: NotificationSound, gesture = false): boolean {
  if (sound === "off") return false;
  const ctx = gesture ? unlockAudio() : context;
  if (!ctx || (ctx.state !== "running" && !gesture)) return false;
  try {
    const at = ctx.currentTime + 0.01;
    // One output per sound, so the tones together stay as quiet as each.
    const output = ctx.createGain();
    output.gain.setValueAtTime(1, at);
    output.connect(ctx.destination);
    for (const tone of SOUND_TONES[sound]) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = tone.wave;
      oscillator.frequency.setValueAtTime(tone.frequency, at);
      const start = at + tone.start,
        end = start + tone.duration;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(tone.gain, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain);
      gain.connect(output);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }
    // Let go of the nodes once it has rung out.
    setTimeout(() => {
      try {
        output.disconnect();
      } catch {}
    }, (soundLength(sound) + 0.2) * 1000);
    return true;
  } catch {
    return false;
  }
}

// The person's own changes in this browser (every POST of components/ui.tsx
// api()), shared by its tabs: a rule or workflow they set off themself
// makes no sound (lib/notification-sound.ts SELF_CAUSED_KINDS).
const OWN_KEY = "flowplan:own-change";
let ownAt = 0;
export function noteOwnAction(now = Date.now()) {
  ownAt = now;
  try {
    localStorage.setItem(OWN_KEY, String(now));
  } catch {}
}
export function ownActionAgo(now = Date.now()) {
  let at = ownAt;
  try {
    at = Math.max(at, Number(localStorage.getItem(OWN_KEY)) || 0);
  } catch {}
  return at ? now - at : Infinity;
}
