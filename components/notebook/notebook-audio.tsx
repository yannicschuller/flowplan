"use client";
// Audio in a notebook (like GoodNotes or Notability): record while writing,
// play back with the ink appearing as it was written. Server side:
// lib/notebook-audio.ts; time marks and limits: lib/ink/audio-sync.ts.
//
// - One button in the notebook bar opens the list of recordings (play,
//   rename, download, delete) with "Record" on top for editors.
// - Recording: a bar with the time, a level meter, pause/resume and stop.
//   Every stroke and text written meanwhile gets `rec: { id, t }`. Pieces go
//   to IndexedDB at once (audio-store.ts) and up to the server in chunks
//   while recording and at the end; a reload or crash leaves an unfinished
//   recording that the next visit offers to save. Three hours at most, and
//   no more than the storage left (checked before the start, with every
//   chunk and at the end); it stops by itself with a notice.
// - Playback: play/pause, scrub, 1×/1.5×/2×; ink of this recording not
//   reached yet is dimmed. "Play from here" (or a long press with a finger)
//   on a stroke jumps to when it was written.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  DownloadSimple,
  HandTap,
  Microphone,
  Pause,
  PencilSimple,
  Play,
  Stop,
  Trash,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { useT } from "../i18n";
import { api, downloadBlob, Modal } from "../ui";
import { useMenuPlacement } from "../ink/menu-placement";
import type { InkEditor } from "../ink/use-ink-editor";
import { addChunk, durable, pendingSessions, removeSession, saveSession, sessionBlob, type StoredSession } from "./audio-store";
import { clientToPage } from "@/lib/ink/coords";
import { hitItem } from "@/lib/ink/geometry";
import type { InkItem } from "@/lib/ink/model";
import {
  formatClock,
  nextUploadRange,
  pickRecordingFormat,
  recordingExt,
  recordingLimitMs,
  roomTooSmall,
  RECORDING_CHUNK_BYTES,
  RECORDING_MAX_MS,
  seekTimeOf,
  type NotebookRecording,
  type Playback,
  type RecordingFormat,
} from "@/lib/ink/audio-sync";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";

type Info = { recordings: NotebookRecording[]; canEdit: boolean; room: number | null; chunkBytes: number };
type Live = {
  recorder: MediaRecorder;
  stream: MediaStream;
  context: AudioContext | null;
  session: StoredSession;
  format: RecordingFormat;
  limitMs: number;
  room: number | null;
  // Audio time: what ran before the last resume, and since when it runs.
  acc: number;
  since: number | null;
  queue: Promise<unknown>;
  wake: { release(): Promise<void> } | null;
  reason: string;
  uploaded: number;
};
type Status =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "recording" | "paused"; limitMs: number }
  | { kind: "uploading"; progress: number; name: string }
  | { kind: "failed"; session: StoredSession; message: string };

const SPEEDS = [1, 1.5, 2];
const SLICE_MS = 5000;
const LONG_PRESS_MS = 550;
class UploadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
const appleWebKit = () => typeof navigator !== "undefined" && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS|Android/.test(navigator.userAgent);
const live = (live: Live) => live.acc + (live.since !== null ? performance.now() - live.since : 0);

export function useNotebookAudio({
  pageId,
  editor,
  canEdit,
  scroller,
  onError,
  off = false,
}: {
  pageId: string;
  editor: InkEditor;
  canEdit: boolean;
  // Guests of an edit link (#280): no recordings.
  off?: boolean;
  // The scrolling box of the sheets: "play from here" listens there.
  scroller: RefObject<HTMLDivElement | null>;
  onError: (message: string) => void;
}) {
  const t = useT();
  const placeMenu = useMenuPlacement();
  const base = `/api/pages/${pageId}/recordings`;
  const [info, setInfo] = useState<Info | null>(null);
  const [status, setStatusState] = useState<Status>({ kind: "idle" });
  const statusRef = useRef(status);
  const setStatus = (next: Status) => {
    statusRef.current = next;
    setStatusState(next);
  };
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<StoredSession[]>([]);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<NotebookRecording | null>(null);
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<NotebookRecording | null>(null);
  const liveRef = useRef<Live | null>(null);
  const timers = useRef<{ tick?: ReturnType<typeof setInterval>; meter?: number; push?: ReturnType<typeof setInterval> }>({});
  const uploading = useRef<Promise<unknown> | null>(null);

  // ---- The list ----
  const load = useCallback(async () => {
    if (off) return null;
    try {
      const data = await api<Info>(base);
      setInfo(data);
      return data;
    } catch {
      return null;
    }
  }, [base, off]);
  useEffect(() => {
    void load();
  }, [load]);
  // Recordings left on this device (a reload, a crash, no connection);
  // one written to in the last moments is still running in another tab.
  const refreshPending = useCallback(async () => {
    if (!canEdit) return;
    const active = liveRef.current?.session.id;
    const list = await pendingSessions(pageId);
    setPending(list.filter((s) => s.id !== active && !(s.state === "recording" && Date.now() - s.updatedAt < 20_000) && s.bytes > 0));
  }, [canEdit, pageId]);
  useEffect(() => {
    void refreshPending();
  }, [refreshPending]);

  // ---- Upload ----
  const statusOf = useCallback(async (id: string) => {
    const response = await fetch(`${base}?upload=${id}`, { cache: "no-store", credentials: "same-origin" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new UploadError(serverMessage(String(data?.error || "Anfrage fehlgeschlagen")), response.status);
    return data as { size: number; finished: boolean; recording?: NotebookRecording };
  }, [base]);
  // Sends what the server does not have yet; with `finish` the recording is
  // then stored. Resumes from the server's size (a retry, a reload).
  const send = useCallback(
    async (session: StoredSession, finish: boolean, onProgress?: (share: number) => void): Promise<NotebookRecording | null> => {
      const state = await statusOf(session.id);
      if (state.finished) return state.recording || null;
      let size = state.size;
      const blob = await sessionBlob(session.id, session.mime);
      const chunk = info?.chunkBytes || RECORDING_CHUNK_BYTES;
      let restarts = 0;
      for (let range = nextUploadRange(size, blob.size, chunk); range; range = nextUploadRange(size, blob.size, chunk)) {
        const query = new URLSearchParams({ upload: session.id, offset: String(range.start), type: session.mime });
        const response = await fetch(`${base}?${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: blob.slice(range.start, range.end),
          credentials: "same-origin",
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 409 && restarts++ < 3) {
          size = (await statusOf(session.id)).size;
          continue;
        }
        if (!response.ok) throw new UploadError(serverMessage(String(data?.error || "Anfrage fehlgeschlagen")), response.status);
        size = Number(data.size) || range.end;
        if (liveRef.current?.session.id === session.id) liveRef.current.uploaded = size;
        onProgress?.(blob.size ? size / blob.size : 1);
      }
      if (!finish) return null;
      const answer = await api<{ recording: NotebookRecording }>(base, { action: "finish", recId: session.id, name: session.name, durationMs: session.durationMs });
      return answer.recording;
    },
    [base, info?.chunkBytes, statusOf],
  );
  const finishUpload = useCallback(
    async (session: StoredSession) => {
      setStatus({ kind: "uploading", progress: 0, name: session.name });
      // Pieces sent while recording: wait for them, then go on from there.
      await uploading.current?.catch(() => {});
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const recording = await send(session, true, (progress) => setStatus({ kind: "uploading", progress, name: session.name }));
          await removeSession(session.id);
          setStatus({ kind: "idle" });
          if (recording) setInfo((now) => (now ? { ...now, recordings: [...now.recordings.filter((r) => r.id !== recording.id), recording] } : now));
          setNotice(t(`„${session.name}“ ist gespeichert.`, `“${session.name}” is saved.`));
          void load();
          void refreshPending();
          return;
        } catch (e) {
          lastError = e;
          // Refused (too long, quota, rights): no point in trying again.
          if (e instanceof UploadError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) break;
          if (e && typeof e === "object" && "status" in e && Number((e as { status: number }).status) >= 400 && Number((e as { status: number }).status) < 500) break;
          await new Promise((done) => setTimeout(done, 1500 * (attempt + 1)));
        }
      }
      const message =
        lastError instanceof Error && lastError.message && !(lastError instanceof TypeError)
          ? lastError.message
          : t("Die Aufnahme konnte nicht hochgeladen werden. Sie bleibt auf diesem Gerät.", "The recording could not be uploaded. It stays on this device.");
      setStatus({ kind: "failed", session, message });
    },
    [load, refreshPending, send, t],
  );

  // ---- Recording ----
  const release = useCallback(() => {
    const now = liveRef.current;
    if (timers.current.tick) clearInterval(timers.current.tick);
    if (timers.current.push) clearInterval(timers.current.push);
    if (timers.current.meter) cancelAnimationFrame(timers.current.meter);
    timers.current = {};
    editor.stampRef.current = null;
    if (!now) return;
    now.stream.getTracks().forEach((track) => track.stop());
    void now.context?.close().catch(() => {});
    void now.wake?.release().catch(() => {});
    setLevel(0);
  }, [editor.stampRef]);
  const stop = useCallback((reason = "") => {
    const now = liveRef.current;
    if (!now || now.recorder.state === "inactive") return;
    now.reason = reason;
    if (now.since !== null) {
      now.acc += performance.now() - now.since;
      now.since = null;
    }
    now.recorder.stop();
  }, []);
  const togglePause = () => {
    const now = liveRef.current;
    if (!now) return;
    if (now.recorder.state === "recording") {
      now.recorder.pause();
      if (now.since !== null) now.acc += performance.now() - now.since;
      now.since = null;
      now.recorder.requestData();
      setStatus({ kind: "paused", limitMs: now.limitMs });
    } else if (now.recorder.state === "paused") {
      now.recorder.resume();
      now.since = performance.now();
      setStatus({ kind: "recording", limitMs: now.limitMs });
    }
  };

  const start = async () => {
    setMenu(false);
    setNotice(null);
    if (liveRef.current || statusRef.current.kind === "uploading") return;
    // Plain http (#62): browsers offer the microphone only over HTTPS.
    if (!window.isSecureContext) return onError(t("Aufnehmen braucht HTTPS – diese Instanz läuft ohne.", "Recording needs HTTPS – this instance runs without it."));
    const format = typeof MediaRecorder === "undefined" ? null : pickRecordingFormat((m) => MediaRecorder.isTypeSupported(m), appleWebKit());
    if (!format || !navigator.mediaDevices?.getUserMedia) return onError(t("Dieser Browser kann nicht aufnehmen.", "This browser cannot record."));
    setStatus({ kind: "starting" });
    closePlayer();
    // Room in the storage: before the microphone is asked for.
    const fresh = await load();
    const room = fresh?.room ?? null;
    if (roomTooSmall(room, format.bitsPerSecond)) {
      setStatus({ kind: "idle" });
      return onError(t("Der Speicher ist voll: Für eine Aufnahme ist kein Platz mehr.", "The storage is full: there is no room for a recording."));
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      setStatus({ kind: "idle" });
      const name = (e as { name?: string })?.name;
      return onError(
        name === "NotFoundError" || name === "OverconstrainedError"
          ? t("Kein Mikrofon gefunden.", "No microphone found.")
          : t(
              "Kein Zugriff auf das Mikrofon. Erlaube es in den Einstellungen des Browsers oder – in der App – unter Einstellungen › Flowplan › Mikrofon.",
              "No access to the microphone. Allow it in the browser settings or – in the app – under Settings › Flowplan › Microphone.",
            ),
      );
    }
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: format.mime, audioBitsPerSecond: format.bitsPerSecond });
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      setStatus({ kind: "idle" });
      return onError(t("Dieser Browser kann nicht aufnehmen.", "This browser cannot record."));
    }
    const startedAt = Date.now();
    const stamp = new Date(startedAt).toLocaleString(LOCALE_TAG, { dateStyle: "short", timeStyle: "short" });
    const session: StoredSession = {
      id: crypto.randomUUID(),
      pageId,
      mime: format.mime,
      name: t(`Aufnahme ${stamp}`, `Recording ${stamp}`),
      startedAt,
      durationMs: 0,
      updatedAt: startedAt,
      bytes: 0,
      chunks: 0,
      state: "recording",
    };
    await saveSession(session);
    const limitMs = recordingLimitMs(room, format.bitsPerSecond);
    const now: Live = { recorder, stream, context: null, session, format, limitMs, room, acc: 0, since: performance.now(), queue: Promise.resolve(), wake: null, reason: "", uploaded: 0 };
    liveRef.current = now;
    recorder.ondataavailable = (event) => {
      if (!event.data?.size) return;
      now.queue = now.queue.then(async () => {
        now.session = await addChunk({ ...now.session, durationMs: Math.round(live(now)) }, event.data);
        // The storage left fills up: stop before the server refuses.
        if (now.room !== null && now.session.bytes > now.room * 0.97 && now.recorder.state !== "inactive")
          stop(t("Die Aufnahme wurde beendet: Der Speicher ist voll.", "The recording was stopped: the storage is full."));
      });
    };
    recorder.onstop = () => {
      now.queue = now.queue.then(async () => {
        const session = { ...now.session, durationMs: Math.round(Math.min(live(now), RECORDING_MAX_MS)), state: "stopped" as const, updatedAt: Date.now() };
        now.session = session;
        await saveSession(session);
        release();
        liveRef.current = null;
        setElapsed(session.durationMs);
        if (now.reason) setNotice(now.reason);
        await finishUpload(session);
      });
    };
    recorder.onerror = () => stop(t("Die Aufnahme wurde unterbrochen.", "The recording was interrupted."));
    // The microphone went away (another app took it, the device was unplugged).
    const track = stream.getAudioTracks()[0];
    track?.addEventListener("ended", () => stop(t("Das Mikrofon ist nicht mehr verfügbar; die Aufnahme wurde beendet.", "The microphone is no longer available; the recording was stopped.")));
    // iPad/iPhone: in the background (or with a call) the system mutes the
    // microphone of a web view. Paused, so the time marks stay true.
    track?.addEventListener("mute", () => {
      if (liveRef.current !== now || now.recorder.state !== "recording") return;
      togglePause();
      setNotice(t("Die Aufnahme ist pausiert: Das Mikrofon war nicht verfügbar (App im Hintergrund, Anruf).", "The recording is paused: the microphone was unavailable (app in the background, a call)."));
    });
    recorder.start(SLICE_MS);
    // New ink carries the moment.
    editor.stampRef.current = () => (liveRef.current === now ? { id: now.session.id, t: live(now) } : null);
    setElapsed(0);
    setStatus({ kind: "recording", limitMs });
    // The screen stays on (a locked iPad stops the microphone of a web view).
    try {
      const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wakeLock) now.wake = await wakeLock.request("screen");
    } catch {}
    // Level meter.
    try {
      const Context = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Context) {
        const context = new Context();
        now.context = context;
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        let last = 0;
        const frame = (time: number) => {
          if (liveRef.current !== now) return;
          if (time - last > 80) {
            last = time;
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (const v of data) sum += ((v - 128) / 128) ** 2;
            setLevel(now.recorder.state === "recording" ? Math.min(1, Math.sqrt(sum / data.length) * 3) : 0);
          }
          timers.current.meter = requestAnimationFrame(frame);
        };
        timers.current.meter = requestAnimationFrame(frame);
      }
    } catch {}
    timers.current.tick = setInterval(() => {
      const ms = live(now);
      setElapsed(ms);
      if (ms >= now.limitMs)
        stop(
          now.limitMs >= RECORDING_MAX_MS
            ? t("Die Aufnahme wurde nach drei Stunden beendet (die Höchstlänge).", "The recording was stopped after three hours (the maximum).")
            : t("Die Aufnahme wurde beendet: Mehr passt nicht in den Speicher.", "The recording was stopped: no more fits into the storage."),
        );
    }, 250);
    // While recording, what is on this device goes up every half minute.
    timers.current.push = setInterval(() => {
      if (uploading.current || now.session.bytes - now.uploaded < 256 * 1024) return;
      uploading.current = now.queue
        .then(() => send(now.session, false))
        .catch(() => {})
        .finally(() => (uploading.current = null));
    }, 30_000);
    if (!(await durable()))
      setNotice(t("Dieser Browser speichert die Aufnahme nicht zwischen: Bitte die Seite bis zum Ende nicht neu laden.", "This browser does not keep the recording in between: please do not reload the page until it ends."));
  };
  // The tab goes to the background: what was recorded so far is kept.
  useEffect(() => {
    const hidden = () => {
      const now = liveRef.current;
      if (document.visibilityState === "hidden" && now?.recorder.state === "recording") now.recorder.requestData();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", hidden);
    };
  }, []);
  // Leaving the notebook ends the recording (it is saved).
  useEffect(
    () => () => {
      const now = liveRef.current;
      if (now && now.recorder.state !== "inactive") now.recorder.stop();
    },
    [],
  );

  const discard = async (session: StoredSession) => {
    await removeSession(session.id);
    await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "discard", recId: session.id }), credentials: "same-origin" }).catch(() => {});
    if (statusRef.current.kind === "failed") setStatus({ kind: "idle" });
    void refreshPending();
  };

  // ---- Playback ----
  const audio = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<NotebookRecording | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [seekMode, setSeekMode] = useState(false);
  const pendingSeek = useRef<number | null>(null);
  const closePlayer = () => {
    audio.current?.pause();
    setCurrent(null);
    setPlaying(false);
    setSeekMode(false);
    setTime(0);
  };
  const open = (recording: NotebookRecording, at = 0, play = true) => {
    setMenu(false);
    if (current?.id !== recording.id) {
      setCurrent(recording);
      setTime(at);
      pendingSeek.current = at;
    } else if (audio.current) {
      audio.current.currentTime = at / 1000;
      setTime(at);
    }
    if (play) setTimeout(() => void audio.current?.play().catch(() => {}), 0);
  };
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    el.playbackRate = speed;
  }, [speed, current]);
  // The time while playing, a few times a second (the ink follows).
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const step = () => {
      const el = audio.current;
      if (el) setTime(Math.round((el.currentTime * 1000) / 100) * 100);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  const playback: Playback = useMemo(() => (current ? { id: current.id, t: time } : null), [current, time]);
  const known = useMemo(() => new Map((info?.recordings || []).map((r) => [r.id, r])), [info?.recordings]);

  // ---- "Play from here" ----
  const itemAt = useCallback(
    (x: number, y: number): InkItem | null => {
      const root = scroller.current;
      const layer = (document.elementFromPoint(x, y) as Element | null)?.closest?.(".ink-layer[data-page]") as HTMLElement | null;
      if (!root || !layer || !root.contains(layer)) return null;
      const box = (layer.querySelector("svg.ink-strokes") as SVGSVGElement | null)?.viewBox.baseVal;
      if (!box?.width) return null;
      const size = { width: box.width, height: box.height };
      const rect = layer.getBoundingClientRect();
      const at = clientToPage(x, y, rect, size);
      const tolerance = 10 / (rect.width / size.width || 1);
      const items = editor.docRef.current.pages[layer.dataset.page || ""] || [];
      for (let i = items.length - 1; i >= 0; i--) if (items[i].rec && known.has(items[i].rec!.id) && hitItem(items[i], at, tolerance)) return items[i];
      return null;
    },
    [editor.docRef, known, scroller],
  );
  const seekTo = useCallback(
    (item: InkItem) => {
      const target = seekTimeOf(item);
      const recording = target && known.get(target.id);
      if (!target || !recording) return false;
      open(recording, target.t, true);
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [known, current],
  );
  useEffect(() => {
    const root = scroller.current;
    if (!root || !known.size) return;
    let press: { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
    const cancel = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    const down = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.(".ink-ui")) return;
      if (seekMode) {
        const item = itemAt(event.clientX, event.clientY);
        // The tap is the player's, not the pen's.
        event.preventDefault();
        event.stopPropagation();
        if (item) seekTo(item);
        else setNotice(t("Dort wurde während einer Aufnahme nichts geschrieben.", "Nothing there was written during a recording."));
        return;
      }
      // A long press of a finger that does not draw (pen-only), or anyone's
      // on a notebook they only read.
      const fingerFree = event.pointerType === "touch" && (editor.penOnly || !canEdit);
      if (!fingerFree && !(event.pointerType === "mouse" && !canEdit)) return;
      cancel();
      const { clientX: x, clientY: y, pointerId: id } = event;
      press = {
        id,
        x,
        y,
        timer: setTimeout(() => {
          press = null;
          const item = itemAt(x, y);
          if (item) seekTo(item);
        }, LONG_PRESS_MS),
      };
    };
    const move = (event: PointerEvent) => {
      if (press && event.pointerId === press.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) cancel();
    };
    root.addEventListener("pointerdown", down, true);
    root.addEventListener("pointermove", move, true);
    root.addEventListener("pointerup", cancel, true);
    root.addEventListener("pointercancel", cancel, true);
    return () => {
      cancel();
      root.removeEventListener("pointerdown", down, true);
      root.removeEventListener("pointermove", move, true);
      root.removeEventListener("pointerup", cancel, true);
      root.removeEventListener("pointercancel", cancel, true);
    };
  }, [canEdit, editor.penOnly, itemAt, known.size, scroller, seekMode, seekTo, t]);
  useEffect(() => {
    if (!seekMode) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setSeekMode(false);
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [seekMode]);
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    if (seekMode) root.dataset.audioSeek = "true";
    else delete root.dataset.audioSeek;
  }, [scroller, seekMode]);

  // ---- The menu ----
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.(".notebook-audio-anchor")) setMenu(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setMenu(false);
    };
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [menu]);
  const download = async (recording: NotebookRecording) => {
    setMenu(false);
    try {
      const response = await fetch(`/api/files/${recording.fileId}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error();
      downloadBlob(`${recording.name}.${recordingExt(recording.mime)}`, await response.blob());
    } catch {
      onError(t("Die Aufnahme konnte nicht geladen werden.", "The recording could not be loaded."));
    }
  };
  const rename = async () => {
    const recording = renaming;
    setRenaming(null);
    if (!recording || !newName.trim() || newName.trim() === recording.name) return;
    try {
      const answer = await api<{ recording: NotebookRecording }>(base, { action: "rename", recId: recording.id, name: newName.trim() });
      setInfo((now) => (now ? { ...now, recordings: now.recordings.map((r) => (r.id === recording.id ? answer.recording : r)) } : now));
      if (current?.id === recording.id) setCurrent(answer.recording);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const remove = async () => {
    const recording = deleting;
    setDeleting(null);
    if (!recording) return;
    try {
      await api(base, { action: "delete", recId: recording.id });
      if (current?.id === recording.id) closePlayer();
      setInfo((now) => (now ? { ...now, recordings: now.recordings.filter((r) => r.id !== recording.id) } : now));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const recordingNow = status.kind === "recording" || status.kind === "paused";
  const recordings = info?.recordings || [];
  const mayRecord = canEdit && !!info?.canEdit;
  const show = mayRecord || recordings.length > 0;
  const date = (at: number) => new Date(at).toLocaleString(LOCALE_TAG, { dateStyle: "medium", timeStyle: "short" });

  const button = show ? (
    <div className="notebook-menu-anchor notebook-audio-anchor">
      <button
        type="button"
        className={`icon-button notebook-audio-button${recordingNow ? " is-recording" : current ? " active" : ""}`}
        aria-label={t("Aufnahmen", "Recordings")}
        title={t("Aufnahmen", "Recordings")}
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
      >
        <Microphone size={18} weight={recordingNow ? "fill" : "regular"} />
      </button>
      {menu && (
        <div ref={placeMenu} className="ink-menu notebook-menu notebook-menu-end notebook-audio-menu" role="menu" aria-label={t("Aufnahmen", "Recordings")}>
          {mayRecord && (
            <button type="button" role="menuitem" className="notebook-audio-record" disabled={status.kind !== "idle" && status.kind !== "failed"} onClick={() => void start()}>
              <span className="notebook-audio-dot" aria-hidden="true" /> {recordingNow ? t("Aufnahme läuft …", "Recording …") : t("Aufnahme starten", "Start recording")}
            </button>
          )}
          {recordings.length === 0 ? (
            <p className="notebook-audio-empty">{t("Noch keine Aufnahmen. Während einer Aufnahme Geschriebenes erscheint beim Abspielen im Takt.", "No recordings yet. What you write during a recording appears in step when it plays.")}</p>
          ) : (
            <ul className="notebook-audio-list" aria-label={t("Aufnahmen dieses Notizbuchs", "Recordings of this notebook")}>
              {recordings.map((r) => (
                <li key={r.id} className={current?.id === r.id ? "is-current" : undefined}>
                  <button type="button" role="menuitem" className="notebook-audio-item" onClick={() => open(r)}>
                    <Play size={15} weight="fill" />
                    <span className="notebook-audio-name">
                      <strong>{r.name}</strong>
                      <small>
                        {formatClock(r.durationMs)} · {date(r.createdAt)}
                      </small>
                    </span>
                  </button>
                  <span className="notebook-audio-actions">
                    <button type="button" className="icon-button" aria-label={t(`„${r.name}“ herunterladen`, `Download “${r.name}”`)} title={t("Herunterladen", "Download")} onClick={() => void download(r)}>
                      <DownloadSimple size={15} />
                    </button>
                    {mayRecord && (
                      <>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={t(`„${r.name}“ umbenennen`, `Rename “${r.name}”`)}
                          title={t("Umbenennen", "Rename")}
                          onClick={() => (setMenu(false), setNewName(r.name), setRenaming(r))}
                        >
                          <PencilSimple size={15} />
                        </button>
                        <button type="button" className="icon-button danger" aria-label={t(`„${r.name}“ löschen`, `Delete “${r.name}”`)} title={t("Löschen", "Delete")} onClick={() => (setMenu(false), setDeleting(r))}>
                          <Trash size={15} />
                        </button>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  ) : null;

  const limit = status.kind === "recording" || status.kind === "paused" ? status.limitMs : RECORDING_MAX_MS;
  const firstPending = pending[0];
  const bar = (
    <>
      {recordingNow && (
        <div className={`notebook-audio-bar is-recording${status.kind === "paused" ? " is-paused" : ""}`} role="region" aria-label={t("Aufnahme", "Recording")}>
          <span className="notebook-audio-live" aria-hidden="true" />
          <strong className="notebook-audio-time" aria-live="off">
            {formatClock(elapsed)}
          </strong>
          <small className="notebook-audio-limit">
            {status.kind === "paused" ? t("Pausiert", "Paused") : t(`von ${formatClock(limit)}`, `of ${formatClock(limit)}`)}
          </small>
          <span className="notebook-audio-meter" role="meter" aria-label={t("Pegel", "Level")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
            <span style={{ transform: `scaleX(${level})` }} />
          </span>
          <button type="button" className="icon-button" aria-label={status.kind === "paused" ? t("Aufnahme fortsetzen", "Resume recording") : t("Aufnahme pausieren", "Pause recording")} title={status.kind === "paused" ? t("Fortsetzen", "Resume") : t("Pausieren", "Pause")} onClick={togglePause}>
            {status.kind === "paused" ? <Microphone size={18} /> : <Pause size={18} weight="fill" />}
          </button>
          <button type="button" className="button notebook-audio-stop" onClick={() => stop()}>
            <Stop size={16} weight="fill" /> {t("Beenden", "Stop")}
          </button>
        </div>
      )}
      {status.kind === "starting" && (
        <div className="notebook-audio-bar" role="status">
          <Microphone size={18} /> {t("Mikrofon wird geöffnet …", "Opening the microphone …")}
        </div>
      )}
      {status.kind === "uploading" && (
        <div className="notebook-audio-bar" role="status">
          <Waveform size={18} />
          <span className="notebook-audio-upload">{t(`„${status.name}“ wird hochgeladen … ${Math.round(status.progress * 100)} %`, `Uploading “${status.name}” … ${Math.round(status.progress * 100)} %`)}</span>
          <progress max={1} value={status.progress} aria-label={t("Hochladen", "Uploading")} />
        </div>
      )}
      {status.kind === "failed" && (
        <div className="notebook-audio-bar is-error" role="alert">
          <span>{status.message}</span>
          <button type="button" className="button" onClick={() => void finishUpload(status.session)}>
            {t("Erneut versuchen", "Try again")}
          </button>
          <button type="button" className="button" onClick={() => void discard(status.session)}>
            {t("Verwerfen", "Discard")}
          </button>
        </div>
      )}
      {status.kind === "idle" && firstPending && (
        <div className="notebook-audio-bar" role="status">
          <Waveform size={18} />
          <span>
            {t(
              `Eine nicht gespeicherte Aufnahme ist auf diesem Gerät: „${firstPending.name}“ (${formatClock(firstPending.durationMs)}).`,
              `An unsaved recording is on this device: “${firstPending.name}” (${formatClock(firstPending.durationMs)}).`,
            )}
          </span>
          <button type="button" className="button primary" onClick={() => void finishUpload(firstPending)}>
            {t("Speichern", "Save")}
          </button>
          <button type="button" className="button" onClick={() => void discard(firstPending)}>
            {t("Verwerfen", "Discard")}
          </button>
        </div>
      )}
      {current && !recordingNow && (
        <div className="notebook-audio-bar notebook-audio-player" role="region" aria-label={t(`Wiedergabe: ${current.name}`, `Playback: ${current.name}`)}>
          <audio
            ref={audio}
            src={`/api/files/${current.fileId}`}
            preload="metadata"
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              el.playbackRate = speed;
              if (pendingSeek.current !== null) {
                el.currentTime = pendingSeek.current / 1000;
                pendingSeek.current = null;
              }
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={(e) => {
              setPlaying(false);
              setTime(Math.max(current.durationMs, e.currentTarget.currentTime * 1000));
            }}
            onSeeked={(e) => setTime(Math.round(e.currentTarget.currentTime * 1000))}
            onError={() => onError(t("Die Aufnahme kann hier nicht abgespielt werden.", "The recording cannot be played here."))}
          />
          <button
            type="button"
            className="icon-button notebook-audio-play"
            aria-label={playing ? t("Pause", "Pause") : t("Abspielen", "Play")}
            title={playing ? t("Pause", "Pause") : t("Abspielen", "Play")}
            onClick={() => {
              const el = audio.current;
              if (!el) return;
              if (el.paused) void el.play().catch(() => {});
              else el.pause();
            }}
          >
            {playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
          </button>
          <span className="notebook-audio-time">{formatClock(time)}</span>
          <input
            type="range"
            className="notebook-audio-scrub"
            min={0}
            max={Math.max(1, current.durationMs)}
            step={100}
            value={Math.min(time, current.durationMs)}
            aria-label={t("Position", "Position")}
            aria-valuetext={`${formatClock(time)} / ${formatClock(current.durationMs)}`}
            onChange={(e) => {
              const ms = Number(e.target.value);
              setTime(ms);
              if (audio.current) audio.current.currentTime = ms / 1000;
            }}
          />
          <span className="notebook-audio-time is-total">{formatClock(current.durationMs)}</span>
          <button
            type="button"
            className="button notebook-audio-speed"
            aria-label={t(`Geschwindigkeit ${speed}×`, `Speed ${speed}×`)}
            title={t("Geschwindigkeit", "Speed")}
            onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
          >
            {speed.toLocaleString(LOCALE_TAG)}×
          </button>
          <button
            type="button"
            className={`icon-button${seekMode ? " active" : ""}`}
            aria-pressed={seekMode}
            aria-label={t("Ab hier abspielen: auf Geschriebenes tippen", "Play from here: tap something written")}
            title={t("Ab hier abspielen: auf Geschriebenes tippen", "Play from here: tap something written")}
            onClick={() => setSeekMode(!seekMode)}
          >
            <HandTap size={18} />
          </button>
          <button type="button" className="icon-button" aria-label={t("Wiedergabe schließen", "Close playback")} title={t("Schließen", "Close")} onClick={closePlayer}>
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <p className="notebook-notice" role="status">
          {notice}
          <button type="button" className="icon-button" aria-label={t("Hinweis schließen", "Dismiss")} onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </p>
      )}
      <Modal open={!!renaming} onClose={() => setRenaming(null)} title={t("Aufnahme umbenennen", "Rename recording")}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void rename();
          }}
        >
          <input className="input" value={newName} maxLength={120} autoFocus aria-label={t("Name", "Name")} onChange={(e) => setNewName(e.target.value)} />
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setRenaming(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button type="submit" className="button primary">
              {t("Umbenennen", "Rename")}
            </button>
          </div>
        </form>
      </Modal>
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={t("Aufnahme löschen?", "Delete recording?")}>
        <p>
          {t(
            "Die Aufnahme kommt in den Papierkorb (Medien). Das Geschriebene bleibt; es erscheint beim Abspielen nur nicht mehr im Takt.",
            "The recording goes to the trash (media). What was written stays; it just no longer appears in step during playback.",
          )}
        </p>
        <div className="modal-actions">
          <button type="button" className="button" onClick={() => setDeleting(null)}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="button" className="button danger-solid" onClick={() => void remove()}>
            {t("Löschen", "Delete")}
          </button>
        </div>
      </Modal>
    </>
  );

  return { button, bar, playback, recording: recordingNow };
}
