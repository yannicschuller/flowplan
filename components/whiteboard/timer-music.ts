// Background music for the workshop timer: three short loops synthesized
// in the browser with the Web Audio API. There are no audio files and
// nothing is streamed – the notes below and this code are Flowplan's own
// (AGPL-3.0 like the rest of Flowplan; the patterns may also be used under
// CC0). Volume and mute are per person (localStorage); the music only
// starts once the browser allows sound (a click or key press on the page),
// otherwise the timer offers "Ton an".

// i18n-table: 2 – [id, German, English]
export const MUSIC_TRACKS = [
  ["calm", "Ruhig", "Calm"],
  ["focus", "Fokus", "Focus"],
  ["lofi", "Lo-fi", "Lo-fi"],
] as const;
export type MusicTrack = (typeof MUSIC_TRACKS)[number][0];
export const isMusicTrack = (value: unknown): value is MusicTrack => MUSIC_TRACKS.some(([id]) => id === value);

export type MusicSettings = { volume: number; muted: boolean };
const KEY = "flowplan-board-music";
export function musicSettings(): MusicSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && typeof saved.volume === "number")
      return { volume: Math.max(0, Math.min(1, saved.volume)), muted: !!saved.muted };
  } catch {}
  return { volume: 0.5, muted: false };
}
export function saveMusicSettings(settings: MusicSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {}
}

const midi = (note: number) => 440 * 2 ** ((note - 69) / 12);
// One bar per chord (MIDI notes); a loop is a few bars.
const PATTERNS: Record<MusicTrack, { bpm: number; chords: number[][]; bass: number[]; arp?: boolean; beat?: boolean }> = {
  // Slow pads: Cmaj7 – Am7 – Fmaj7 – G6.
  calm: { bpm: 60, chords: [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 64]], bass: [36, 33, 29, 31] },
  // A soft arpeggio in D minor pentatonic over Dm9 – Bbmaj7 – F – C.
  focus: { bpm: 96, chords: [[62, 65, 69, 72], [58, 62, 65, 69], [53, 57, 60, 65], [55, 60, 64, 67]], bass: [38, 34, 29, 36], arp: true },
  // Electric-piano chords with a quiet beat: Ebmaj7 – Dm7 – Cm7 – Bb6.
  lofi: { bpm: 78, chords: [[63, 67, 70, 74], [62, 65, 69, 72], [60, 63, 67, 70], [58, 62, 65, 67]], bass: [39, 38, 36, 34], beat: true },
};

type AudioContextClass = typeof AudioContext;
// One player for the page: the timer of any board uses it.
class TimerMusic {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private track: MusicTrack | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private next = 0;
  private step = 0;
  private settings = musicSettings();
  private listeners = new Set<() => void>();
  blocked = false;

  private context() {
    if (this.ctx) return this.ctx;
    const Ctor = (globalThis as unknown as { AudioContext?: AudioContextClass; webkitAudioContext?: AudioContextClass }).AudioContext ||
      (globalThis as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.level();
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }
  private level() {
    return this.settings.muted ? 0 : this.settings.volume * 0.35;
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  get playing() {
    return this.track;
  }
  // Starts (or switches) the loop. Without a user gesture before, browsers
  // keep the context suspended: then nothing plays and `blocked` is set.
  async play(track: MusicTrack) {
    const ctx = this.context();
    if (!ctx) return;
    if (this.track !== track) {
      this.stopLoop();
      this.track = track;
      this.step = 0;
      this.next = ctx.currentTime + 0.1;
      this.timer = setInterval(() => this.schedule(), 200);
    }
    try {
      if (ctx.state !== "running") await Promise.race([ctx.resume(), new Promise((done) => setTimeout(done, 400))]);
    } catch {}
    this.blocked = ctx.state !== "running";
    this.next = Math.max(this.next, ctx.currentTime + 0.05);
    this.emit();
  }
  // "Ton an": called from a click, which lets the browser start sound.
  unlock() {
    const ctx = this.context();
    if (!ctx) return;
    void ctx.resume().then(() => {
      this.blocked = ctx.state !== "running";
      this.emit();
    });
  }
  stop() {
    this.stopLoop();
    this.track = null;
    this.blocked = false;
    // Let the last notes fade, then rest the context.
    const ctx = this.ctx;
    if (ctx && this.master) {
      this.master.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
      const master = this.master;
      setTimeout(() => {
        if (!this.track) {
          master.gain.value = this.level();
          void ctx.suspend().catch(() => {});
        }
      }, 800);
    }
    this.emit();
  }
  private stopLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  setSettings(settings: MusicSettings) {
    this.settings = settings;
    saveMusicSettings(settings);
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.05);
    this.emit();
  }
  getSettings() {
    return this.settings;
  }
  // Notes up to a second ahead (a lookahead scheduler).
  private schedule() {
    const ctx = this.ctx,
      track = this.track;
    if (!ctx || !track || !this.master) return;
    if (ctx.state === "running") this.master.gain.setTargetAtTime(this.level(), ctx.currentTime, 0.05);
    const pattern = PATTERNS[track];
    const beat = 60 / pattern.bpm;
    while (this.next < ctx.currentTime + 1) {
      const bar = Math.floor(this.step / 4) % pattern.chords.length,
        inBar = this.step % 4,
        chord = pattern.chords[bar],
        at = this.next;
      if (inBar === 0) {
        for (const note of chord) this.voice(midi(note), at, beat * 4, pattern.arp ? 0.025 : 0.05, track === "lofi" ? "triangle" : "sine");
        this.voice(midi(pattern.bass[bar]), at, beat * 4, 0.09, "sine");
      }
      if (pattern.arp)
        for (let i = 0; i < 2; i++)
          this.voice(midi(chord[(inBar * 2 + i) % chord.length] + 12), at + (i * beat) / 2, beat * 0.45, 0.04, "triangle");
      if (pattern.beat) {
        if (inBar % 2 === 0) this.kick(at);
        else this.noise(at, 0.06);
        this.noise(at + beat / 2, 0.015);
      }
      this.next += beat;
      this.step++;
    }
  }
  private voice(freq: number, at: number, length: number, peak: number, type: OscillatorType) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator(),
      gain = ctx.createGain(),
      filter = ctx.createBiquadFilter();
    osc.type = type;
    osc.frequency.value = freq;
    filter.type = "lowpass";
    filter.frequency.value = 1800;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + Math.min(0.4, length / 4));
    gain.gain.setTargetAtTime(0, at + length * 0.7, length / 6);
    osc.connect(filter).connect(gain).connect(this.master!);
    osc.start(at);
    osc.stop(at + length * 1.3);
  }
  private kick(at: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator(),
      gain = ctx.createGain();
    osc.frequency.setValueAtTime(120, at);
    osc.frequency.exponentialRampToValueAtTime(45, at + 0.15);
    gain.gain.setValueAtTime(0.18, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.3);
    osc.connect(gain).connect(this.master!);
    osc.start(at);
    osc.stop(at + 0.32);
  }
  private noise(at: number, peak: number) {
    const ctx = this.ctx!;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.12), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const source = ctx.createBufferSource(),
      filter = ctx.createBiquadFilter(),
      gain = ctx.createGain();
    source.buffer = buffer;
    filter.type = "highpass";
    filter.frequency.value = 3000;
    gain.gain.value = peak;
    source.connect(filter).connect(gain).connect(this.master!);
    source.start(at);
  }
}
let player: TimerMusic | null = null;
export const timerMusic = () => (player ??= new TimerMusic());
