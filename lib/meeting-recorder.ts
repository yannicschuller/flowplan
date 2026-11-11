// Browser side of meeting recordings (#199, lib/meetings.ts): the
// microphone ("me") and – in the desktop app – the computer's sound
// ("others") as two MediaRecorders with one shared start, each sending
// 30-second pieces as they come. A piece stays here until the server
// confirmed it; after a lost connection the queue goes on by itself, and
// before "finish" the server is asked which pieces it has.
//
// System sound (desktop app, flowplan-desktop's preload): window.
// FlowplanDesktop.systemAudio says whether it works on this computer;
// armSystemAudio() makes the next getDisplayMedia answer without a picker
// with the loopback audio (and a screen video track this page stops at
// once). On macOS a missing "Screen & System Audio Recording" permission
// shows as reason "permission" – or, from 14.2, as an audio track that is
// already ended (or ends within a second).
import { serverMessage } from "./i18n-errors";
import { MEETING_CHUNK_SECONDS, type MeetingTrack } from "./meeting-core";

type Bridge = {
  version?: string;
  systemAudio?: { supported: boolean; platform?: string; needsPermission?: boolean; reason?: string };
  armSystemAudio?: () => Promise<{ ok: boolean; reason?: string }>;
};
const bridge = () => (typeof window === "undefined" ? null : ((window as unknown as { FlowplanDesktop?: Bridge }).FlowplanDesktop ?? null));

// "browser": no desktop app; "update": an older desktop app; "permission",
// "os-version", "platform" and others from the desktop app.
export type SystemAudio = { supported: boolean; reason?: string };
export function systemAudioSupport(): SystemAudio {
  const d = bridge();
  if (!d) return { supported: false, reason: "browser" };
  if (!d.systemAudio || typeof d.armSystemAudio !== "function") return { supported: false, reason: "update" };
  if (!d.systemAudio.supported) return { supported: false, reason: d.systemAudio.reason || "platform" };
  return { supported: true };
}

export function recorderMime() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) if (MediaRecorder.isTypeSupported(type)) return type;
  return "";
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(serverMessage(String(data?.error || "Die Anfrage ist fehlgeschlagen."))) as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = data?.code;
    throw error;
  }
  return data as T;
}
export const postJson = <T>(url: string, body: unknown) => call<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const getJson = <T>(url: string) => call<T>(url, { cache: "no-store" });

// The system sound: armed, asked for, the video stopped. Null with the
// reason when it is not there.
async function systemStream(): Promise<{ stream: MediaStream | null; reason?: string }> {
  const d = bridge();
  if (!systemAudioSupport().supported || !d?.armSystemAudio) return { stream: null, reason: systemAudioSupport().reason };
  const armed = await d.armSystemAudio().catch(() => ({ ok: false, reason: "error" }));
  if (!armed.ok) return { stream: null, reason: armed.reason || "error" };
  let display: MediaStream;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch {
    return { stream: null, reason: "permission" };
  }
  for (const track of display.getVideoTracks()) track.stop();
  const audio = display.getAudioTracks()[0];
  // macOS 14.2+: without the permission the track arrives ended or ends at once.
  if (!audio || audio.readyState === "ended") return { stream: null, reason: "permission" };
  const ended = await new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(audio.readyState === "ended"), 1000);
    audio.addEventListener("ended", () => (clearTimeout(timer), done(true)), { once: true });
  });
  if (ended) return { stream: null, reason: "permission" };
  return { stream: new MediaStream([audio]) };
}

type Piece = { track: MeetingTrack; index: number; blob: Blob };
export type RecorderState = { phase: "starting" | "recording" | "paused" | "stopping" | "uploading" | "done"; elapsedMs: number; pending: number; offline: boolean };

export class MeetingRecorder {
  private recorders = new Map<MeetingTrack, MediaRecorder>();
  private streams: MediaStream[] = [];
  private counts = new Map<MeetingTrack, number>();
  private queue: Piece[] = [];
  private pumping = false;
  private session = 0;
  private startedAt = 0;
  private pausedAt = 0;
  private pausedMs = 0;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  tracks: MeetingTrack[] = [];
  systemReason: string | undefined;
  phase: RecorderState["phase"] = "starting";
  offline = false;

  constructor(
    private options: {
      meetingId: string;
      pageId: string;
      rowId?: string | null;
      consent: boolean;
      system: boolean;
      onState: (state: RecorderState) => void;
      onError: (message: string) => void;
    },
  ) {}

  private emit() {
    this.options.onState({ phase: this.phase, elapsedMs: this.elapsed(), pending: this.queue.length, offline: this.offline });
  }
  elapsed() {
    if (!this.startedAt) return 0;
    const now = this.pausedAt || Date.now();
    return Math.max(0, now - this.startedAt - this.pausedMs);
  }
  private readonly online = () => {
    this.offline = false;
    void this.pump();
  };

  async start() {
    const mime = recorderMime();
    if (!mime || !navigator.mediaDevices?.getUserMedia) throw new Error("Dieser Browser kann keine Aufnahmen machen.");
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.streams.push(mic);
    let system: MediaStream | null = null;
    if (this.options.system) {
      const result = await systemStream();
      system = result.stream;
      this.systemReason = result.reason;
      if (system) this.streams.push(system);
    }
    this.tracks = system ? ["me", "others"] : ["me"];
    try {
      const started = await postJson<{ session: number; offsetMs: number }>(`/api/meetings/${this.options.meetingId}/start`, {
        pageId: this.options.pageId,
        rowId: this.options.rowId || null,
        tracks: this.tracks,
        mime: mime.split(";")[0],
        consent: this.options.consent,
      });
      this.session = started.session;
    } catch (error) {
      this.release();
      throw error;
    }
    const streamOf: Record<MeetingTrack, MediaStream | null> = { me: mic, others: system, mixed: null };
    for (const track of this.tracks) {
      const recorder = new MediaRecorder(streamOf[track]!, { mimeType: mime, audioBitsPerSecond: 32_000 });
      this.counts.set(track, 0);
      recorder.ondataavailable = (event) => {
        if (!event.data?.size) return;
        const index = this.counts.get(track)!;
        this.counts.set(track, index + 1);
        this.queue.push({ track, index, blob: event.data });
        void this.pump();
      };
      this.recorders.set(track, recorder);
    }
    // One shared start for both tracks.
    this.startedAt = Date.now();
    for (const recorder of this.recorders.values()) recorder.start(MEETING_CHUNK_SECONDS * 1000);
    this.phase = "recording";
    window.addEventListener("online", this.online);
    this.timer = setInterval(() => this.emit(), 500);
    this.emit();
  }
  pause() {
    if (this.phase !== "recording") return;
    for (const r of this.recorders.values()) if (r.state === "recording") r.pause();
    this.pausedAt = Date.now();
    this.phase = "paused";
    this.emit();
  }
  resume() {
    if (this.phase !== "paused") return;
    for (const r of this.recorders.values()) if (r.state === "paused") r.resume();
    this.pausedMs += Date.now() - this.pausedAt;
    this.pausedAt = 0;
    this.phase = "recording";
    this.emit();
  }
  private release() {
    for (const stream of this.streams) for (const track of stream.getTracks()) track.stop();
    this.streams = [];
  }
  // Sends the queue in order; a failed piece stays and is tried again.
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const piece = this.queue[0];
        try {
          const params = new URLSearchParams({ session: String(this.session), track: piece.track, index: String(piece.index) });
          await call(`/api/meetings/${this.options.meetingId}/chunk?${params}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: piece.blob });
          this.queue.shift();
          this.offline = false;
        } catch (error) {
          const status = (error as { status?: number }).status;
          // Refused for good (too large, no right): stop and say so.
          if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
            this.options.onError((error as Error).message);
            this.queue.shift();
            continue;
          }
          this.offline = true;
          this.emit();
          await new Promise((r) => setTimeout(r, 3000));
          if (this.stopped && !navigator.onLine) await new Promise((r) => setTimeout(r, 2000));
        }
        this.emit();
      }
    } finally {
      this.pumping = false;
    }
  }
  // Stops, sends what is left and starts the processing.
  async stop(language: string) {
    if (this.phase === "paused") this.resume();
    const durationMs = this.elapsed();
    this.phase = "stopping";
    this.stopped = true;
    this.emit();
    await Promise.all(
      [...this.recorders.values()].map(
        (r) =>
          new Promise<void>((done) => {
            if (r.state === "inactive") return done();
            r.addEventListener("stop", () => done(), { once: true });
            r.stop();
          }),
      ),
    );
    this.release();
    clearInterval(this.timer);
    this.phase = "uploading";
    this.emit();
    // Until every piece is there (a lost connection waits).
    for (let attempt = 0; attempt < 200; attempt++) {
      await this.pump();
      while (this.pumping || this.queue.length) await new Promise((r) => setTimeout(r, 500));
      const { received } = await getJson<{ received: Partial<Record<MeetingTrack, number[]>> }>(`/api/meetings/${this.options.meetingId}/chunks?session=${this.session}`).catch(
        () => ({ received: null as null | Partial<Record<MeetingTrack, number[]>> }),
      );
      if (received && this.tracks.every((t) => (received[t] || []).length === this.counts.get(t))) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    window.removeEventListener("online", this.online);
    const parts = Object.fromEntries(this.tracks.map((t) => [t, this.counts.get(t) || 0]));
    if (Object.values(parts).some((n) => !n)) throw new Error("In der Aufnahme ist nichts angekommen.");
    const status = await postJson(`/api/meetings/${this.options.meetingId}/finish`, { session: this.session, parts, durationMs, language });
    this.phase = "done";
    this.emit();
    return status;
  }
  cancel() {
    for (const r of this.recorders.values()) if (r.state !== "inactive") r.stop();
    this.release();
    clearInterval(this.timer);
    window.removeEventListener("online", this.online);
  }
}

// Existing recordings (M4A, MP3, WAV, AAC, WebM …): one file with
// everyone, or the microphone and the call as two files.
const UPLOAD_CHUNK = 4 * 1024 * 1024;
async function fileDuration(file: File) {
  return await new Promise<number>((done) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const finish = (ms: number) => {
      URL.revokeObjectURL(url);
      done(ms);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0);
    audio.onerror = () => finish(0);
    audio.src = url;
    setTimeout(() => finish(0), 8000);
  });
}
export async function uploadMeetingFiles(
  input: { meetingId: string; pageId: string; rowId?: string | null; consent: boolean; language: string; files: Partial<Record<MeetingTrack, File>> },
  onProgress?: (share: number) => void,
) {
  const tracks = (Object.keys(input.files) as MeetingTrack[]).filter((t) => input.files[t]);
  const mime = input.files[tracks[0]]!.type || "audio/mpeg";
  const started = await postJson<{ session: number }>(`/api/meetings/${input.meetingId}/start`, {
    pageId: input.pageId,
    rowId: input.rowId || null,
    tracks,
    mime: mime.split(";")[0],
    consent: input.consent,
  });
  const total = tracks.reduce((sum, t) => sum + input.files[t]!.size, 0);
  let sent = 0;
  const parts: Partial<Record<MeetingTrack, number>> = {};
  let durationMs = 0;
  for (const track of tracks) {
    const file = input.files[track]!;
    durationMs = Math.max(durationMs, await fileDuration(file));
    const count = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK));
    for (let index = 0; index < count; index++) {
      const params = new URLSearchParams({ session: String(started.session), track, index: String(index) });
      const body = file.slice(index * UPLOAD_CHUNK, (index + 1) * UPLOAD_CHUNK);
      await call(`/api/meetings/${input.meetingId}/chunk?${params}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body });
      sent += body.size;
      onProgress?.(total ? sent / total : 1);
    }
    parts[track] = count;
  }
  return await postJson(`/api/meetings/${input.meetingId}/finish`, { session: started.session, parts, durationMs, language: input.language });
}
