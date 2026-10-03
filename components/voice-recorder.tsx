"use client";
// Records a voice note in the browser (MediaRecorder); the recording is
// uploaded as audio and, if the server has Whisper, turned into text.
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { Microphone, Stop, Trash } from "@phosphor-icons/react";
import { Modal } from "./ui";

const MAX_SECONDS = 10 * 60;
function pickType() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) =>
    MediaRecorder.isTypeSupported(t),
  ) || "";
}
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function VoiceRecorder({
  open,
  transcription,
  onClose,
  onInsert,
}: {
  open: boolean;
  transcription: boolean;
  onClose: () => void;
  onInsert: (file: File, transcribe: boolean) => void;
}) {
  const t = useT();
  const [state, setState] = useState<"idle" | "recording" | "done">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [toText, setToText] = useState(transcription);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopAll = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(() => {
    if (!open) {
      if (recorder.current?.state === "recording") recorder.current.stop();
      stopAll();
      setState("idle");
      setSeconds(0);
      setFile(null);
      setError("");
    }
  }, [open]);
  useEffect(() => () => stopAll(), []);
  useEffect(() => {
    if (!file) return setUrl("");
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  const start = async () => {
    setError("");
    const type = pickType();
    if (!type || !navigator.mediaDevices?.getUserMedia)
      return setError(t("Dieser Browser kann nicht aufnehmen.", "This browser cannot record."));
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setError(t("Kein Zugriff auf das Mikrofon. Erlaube es in den Browser-Einstellungen.", "No access to the microphone. Allow it in the browser settings."));
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream.current, { mimeType: type });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stopAll();
      const base = type.split(";")[0];
      const ext = base.includes("mp4") ? "m4a" : base.includes("ogg") ? "ogg" : "webm";
      const stamp = new Date().toLocaleString(LOCALE_TAG, { dateStyle: "short", timeStyle: "short" }).replace(/[/:, ]+/g, "-");
      setFile(new File(chunks, t(`Sprachnotiz-${stamp}.${ext}`, `Voice-note-${stamp}.${ext}`), { type: base }));
      setState("done");
    };
    recorder.current = rec;
    rec.start(1000);
    setSeconds(0);
    setState("recording");
    timer.current = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_SECONDS) rec.stop();
        return s + 1;
      });
    }, 1000);
  };
  return (
    <Modal open={open} onClose={onClose} title={t("Sprachnotiz", "Voice note")}>
      <div className="voice-recorder">
        {state === "recording" ? (
          <>
            <span className="voice-live" aria-hidden="true" />
            <strong className="voice-time" aria-live="polite">{clock(seconds)}</strong>
            <small>{t("Höchstens", "At most")}{" "}{MAX_SECONDS / 60} {t("Minuten", "minutes")}</small>
            <button type="button" className="button primary voice-button" onClick={() => recorder.current?.stop()}>
              <Stop size={18} weight="fill" /> {t("Aufnahme beenden", "Stop recording")}
            </button>
          </>
        ) : state === "done" && file ? (
          <>
            {url && <audio controls src={url} aria-label={t("Aufnahme anhören", "Listen to the recording")} />}
            <small>{clock(seconds)} · {(file.size / 1024 / 1024).toLocaleString(LOCALE_TAG, { maximumFractionDigits: 1 })} MB</small>
            {transcription ? (
              <label className="voice-option">
                <input type="checkbox" checked={toText} onChange={(e) => setToText(e.target.checked)} />
                {t("Gesprochenes als Text einfügen", "Insert the spoken words as text")}
              </label>
            ) : (
              <small className="muted">{t("Transkription ist auf diesem Server nicht eingerichtet; die Aufnahme wird als Audio eingefügt.", "Transcription is not set up on this server; the recording is inserted as audio.")}</small>
            )}
            <div className="modal-actions">
              <button type="button" className="button" onClick={() => { setFile(null); setState("idle"); }}>
                <Trash size={16} /> {t("Verwerfen", "Discard")}
              </button>
              <button type="button" className="button primary" onClick={() => onInsert(file, transcription && toText)}>
                {t("Einfügen", "Insert")}
              </button>
            </div>
          </>
        ) : (
          <>
            <button type="button" className="voice-start" onClick={() => void start()} aria-label={t("Aufnahme starten", "Start recording")}>
              <Microphone size={34} />
            </button>
            <small>{t("Tippen, um die Aufnahme zu starten", "Tap to start recording")}</small>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
