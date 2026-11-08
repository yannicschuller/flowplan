"use client";
// Quick capture: one field for the title, one for the text, saved straight
// into the default capture database (an inbox). Works offline: the record
// waits on the device and is created once the connection is back.
// "Text verbessern" (#172, only online and where the writing assistant may
// run for the chosen database): title and text go to the writing assistant's
// "improve" action (lib/capture-improve.ts) – on the server or on this
// device, as in the editor – and the answer is shown as a preview to take
// ("Übernehmen") or not ("Original behalten"). Nothing is saved by it.
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Check, Sparkle, Stop, X } from "@phosphor-icons/react";
import { textLocale } from "@/lib/i18n";
import { streamAiFrom } from "@/lib/ai/client";
import { DeviceAiError, deviceErrorText, runOnDevice, runRouted } from "@/lib/ai/device";
import { deviceWriteFits, deviceWritePrompt } from "@/lib/ai/device-prompts";
import { captureImprovable, captureImproveChanged, captureImproveSource, lostCaptureTokens, parseCaptureImprove, type CaptureText } from "@/lib/capture-improve";
import { useLocale, useT } from "./i18n";
import { Modal } from "./ui";
import { AiProviderFooter, DeviceAiChip, useAiBlockedHint, useAiRoute } from "./ai-context";
import { CaptureTargetPicker, rememberCaptureTarget, useCaptureTargets } from "./capture-target";

type Improve = {
  phase: "running" | "done" | "error";
  // What was sent, and the answer as title and text.
  source: CaptureText;
  result: CaptureText;
  error: string;
  ranOn: "device" | "server" | null;
};

export function QuickCapture({
  workspaceId,
  online = true,
  onClose,
  mutate,
  onSaved,
  notify,
}: {
  workspaceId: string;
  // Offline the AI is not offered (capturing still works).
  online?: boolean;
  onClose: () => void;
  mutate: (b: Record<string, unknown>) => Promise<unknown>;
  onSaved: (pageId: string, rowId: string, offline: boolean) => void;
  notify: (message: string) => void;
}) {
  const t = useT();
  const textLocaleNow = textLocale(useLocale());
  const [targets] = useCaptureTargets(workspaceId);
  const [database, setDatabase] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const improve = useImprove(database, online);
  const blockedHint = useAiBlockedHint();
  const titleField = useRef<HTMLInputElement>(null);
  const improveButton = useRef<HTMLButtonElement>(null);
  const useButton = useRef<HTMLButtonElement>(null);
  const { state: improving, reset: resetImprove } = improve;
  // Typing on after asking: the answer is for the old text, so it goes.
  useEffect(() => {
    if (improving && (improving.source.title !== title || improving.source.text !== text)) resetImprove();
  }, [improving, title, text, resetImprove]);
  // The answer is there: the focus on "Übernehmen".
  useEffect(() => {
    if (improving?.phase === "done") useButton.current?.focus();
  }, [improving?.phase]);
  useEffect(() => {
    if (targets) setDatabase((current) => current || targets.default || targets.databases[0]?.id || "");
  }, [targets]);
  // Offline the list of databases is not available: the last one is kept.
  useEffect(() => {
    if (!targets || targets.databases.length) return;
    try {
      const last = localStorage.getItem(`flowplan-capture:${workspaceId}`);
      if (last) setDatabase(last);
    } catch {}
  }, [targets, workspaceId]);
  const save = async () => {
    if (!database || (!title.trim() && !text.trim())) return;
    setBusy(true);
    try {
      const rowId = crypto.randomUUID();
      const result = (await mutate({ action: "capture.record", pageId: database, rowId, title, text })) as { offline?: boolean } | null;
      try {
        localStorage.setItem(`flowplan-capture:${workspaceId}`, database);
      } catch {}
      if (makeDefault && !result?.offline) await rememberCaptureTarget(workspaceId, database, targets).catch(() => undefined);
      onSaved(database, rowId, !!result?.offline);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const offlineFallback = targets && !targets.databases.length && database;
  const changed = !!improving && captureImproveChanged(improving.source, improving.result);
  // Shorthand and links the AI changed or dropped (#172): the same check as
  // the desktop capture window, shown before the text is taken.
  const lost = improving?.phase === "done" && changed ? lostCaptureTokens(captureImproveSource(improving.source), captureImproveSource(improving.result), { today: localDay(), locale: textLocaleNow }) : [];
  return (
    <Modal open sheet onClose={onClose} title={t("Erfassen", "Capture")}>
      <form
        className="quick-capture"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          {t("Titel", "Title")}
          <input ref={titleField} autoFocus value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder={t("Was willst du festhalten?", "What do you want to capture?")} />
        </label>
        <label>
          {t("Text", "Text")}
          <textarea
            rows={5}
            value={text}
            maxLength={20000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
            }}
            placeholder={t("Optional – Gedanken, Link, Notiz …", "Optional – thoughts, link, note …")}
          />
        </label>
        {improve.offered && !improving && (
          <div className="quick-capture-ai-row">
            <button
              ref={improveButton}
              type="button"
              className="button compact quick-capture-improve"
              disabled={!improve.usable || !database || !captureImprovable({ title, text })}
              title={
                improve.usable
                  ? t("Rechtschreibung und Grammatik mit KI verbessern – gespeichert wird erst mit „Erfassen“", "Improve spelling and grammar with AI – nothing is saved until “Capture”")
                  : blockedHint
              }
              onClick={() => improve.run({ title, text })}
            >
              <Sparkle size={14} weight="fill" aria-hidden /> {t("Text verbessern", "Improve text")}
            </button>
          </div>
        )}
        {improving && (
          <div className="quick-capture-ai" role="region" aria-label={t("KI-Vorschlag", "AI suggestion")}>
            <p className="ai-writer-job">
              <Sparkle size={14} weight="fill" aria-hidden /> <span>{t("Text verbessern", "Improve text")}</span>
              {improving.ranOn === "device" && <DeviceAiChip />}
            </p>
            <div className={`ai-preview quick-capture-preview${improving.phase === "running" ? " streaming" : ""}`} aria-live="polite" aria-busy={improving.phase === "running"}>
              {improving.result.title || improving.result.text ? (
                <div>
                  {improving.result.title && <p className="quick-capture-preview-title">{improving.result.title}</p>}
                  {improving.result.text && <p className="quick-capture-preview-text">{improving.result.text}</p>}
                </div>
              ) : improving.phase === "running" ? (
                <p className="muted">{improving.ranOn === "device" ? t("Die KI auf diesem Gerät schreibt …", "The on-device AI is writing …") : t("Die KI schreibt …", "The AI is writing …")}</p>
              ) : null}
              {improving.phase === "done" && !changed && <p className="muted small">{t("Die KI hat nichts zu verbessern gefunden.", "The AI found nothing to improve.")}</p>}
              {lost.length > 0 && (
                <p className="quick-capture-lost" role="alert">
                  {t(`Die KI hat Kurzschreibweisen oder Links verändert oder entfernt: ${lost.join(" ")}`, `The AI changed or removed shorthand or links: ${lost.join(" ")}`)}
                </p>
              )}
              {improving.error && (
                <p className="error" role="alert">
                  {improving.error}
                </p>
              )}
            </div>
            <div className="ai-writer-buttons">
              {improving.phase === "running" ? (
                <button type="button" className="button compact" onClick={improve.stop}>
                  <Stop size={14} weight="fill" aria-hidden /> {t("Stopp", "Stop")}
                </button>
              ) : (
                <>
                  {improving.phase === "done" && changed && (
                    <button
                      ref={useButton}
                      type="button"
                      className="button primary compact"
                      onClick={() => {
                        const next = improving.result;
                        resetImprove();
                        setTitle(next.title);
                        setText(next.text);
                        titleField.current?.focus();
                      }}
                    >
                      <Check size={14} aria-hidden /> {t("Übernehmen", "Use")}
                    </button>
                  )}
                  {improving.phase === "error" && (
                    <button type="button" className="button compact" onClick={() => improve.run(improving.source)}>
                      <ArrowClockwise size={14} aria-hidden /> {t("Erneut", "Retry")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button compact"
                    onClick={() => {
                      resetImprove();
                      requestAnimationFrame(() => improveButton.current?.focus());
                    }}
                  >
                    <X size={14} aria-hidden /> {t("Original behalten", "Keep original")}
                  </button>
                </>
              )}
            </div>
            <AiProviderFooter device={improving.ranOn ? improving.ranOn === "device" : improve.primary === "device"} />
          </div>
        )}
        {offlineFallback ? (
          <p className="muted small">{t("Offline: wird in die zuletzt gewählte Datenbank erfasst, sobald die Verbindung zurück ist.", "Offline: captured into the last chosen database once the connection is back.")}</p>
        ) : (
          <CaptureTargetPicker targets={targets} value={database} onChange={setDatabase} makeDefault={makeDefault} onMakeDefault={setMakeDefault} />
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={busy || improving?.phase === "running" || !database || (!title.trim() && !text.trim())}>
            {busy ? t("Wird gespeichert …", "Saving …") : t("Erfassen", "Capture")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// The writing assistant's "improve" for the capture: where it runs (this
// device or the server, as for the editor's writing assistant), whether it
// is offered (online, the feature usable) and usable (the AI may read the
// target database), and the running request. The rate limits and quotas are
// the server's (POST /api/ai/write).
function useImprove(database: string, online: boolean) {
  const t = useT();
  const locale = textLocale(useLocale());
  const route = useAiRoute("write", database || null);
  const routeRef = useRef(route);
  routeRef.current = route;
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<Improve | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const [reset] = useState(() => () => {
    controller.current?.abort();
    controller.current = null;
    setState(null);
  });
  // Going offline: stopped, the original stays.
  useEffect(() => {
    if (!online) reset();
  }, [online, reset]);
  const run = (source: CaptureText) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const text = captureImproveSource(source);
    const update = (next: Partial<Improve>) => {
      if (controller.current === abort) setState((current) => (current ? { ...current, ...next } : current));
    };
    setState({ phase: "running", source, result: { title: "", text: "" }, error: "", ranOn: null });
    const onText = (all: string) => update({ result: parseCaptureImprove(all, source) });
    void (async () => {
      try {
        const { result } = await runRouted(routeRef.current, {
          device: async () => {
            update({ ranOn: "device" });
            const request = { action: "improve" as const, text, locale, capture: true };
            if (!deviceWriteFits(request)) throw new DeviceAiError("context-too-long");
            return String(await runOnDevice(deviceWritePrompt(request), { signal: abort.signal, onText }));
          },
          server: () => {
            update({ ranOn: "server", result: { title: "", text: "" } });
            return streamAiFrom("/api/ai/write", { pageId: database, action: "improve", text, locale, capture: true }, { signal: abort.signal, onText: (_piece, all) => onText(all) });
          },
        });
        if (controller.current !== abort) return;
        const improved = parseCaptureImprove(result, source);
        if (!improved.title && !improved.text) update({ phase: "error", result: improved, error: t("Die KI hat nichts geantwortet.", "The AI did not answer anything.") });
        else update({ phase: "done", result: improved });
      } catch (e) {
        if (controller.current !== abort) return;
        // Stopped: what came so far is not taken; back to the original.
        if ((e as Error).name === "AbortError") return reset();
        update({ phase: "error", error: e instanceof DeviceAiError ? deviceErrorText(e, t) : (e as Error).message });
      }
    })();
  };
  return {
    offered: online && route.availability !== "hidden",
    usable: route.availability === "ok",
    primary: route.primary,
    state,
    run,
    reset,
    stop: () => controller.current?.abort(),
  };
}

// Today on this device, as YYYY-MM-DD (dates in the capture are relative to it).
function localDay() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
