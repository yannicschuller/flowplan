"use client";
// "Mit KI zusammenfassen": a summary, key points and open tasks of a page,
// a record or the records of a database view. The content is loaded and
// checked on the server (lib/ai/summarize.ts); the answer streams in here
// and can be copied or – into an open document – inserted as a callout at
// the top or its tasks as a checklist. In the Flowplan apps on Apple
// devices an open page or record is summarised on the device where it can
// (lib/ai/device.ts: its text from the open editor, open tasks by guided
// generation), the server taking over where the person may use it – in
// end-to-end encrypted spaces only on the device.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, CheckSquare, Copy, Info, Sparkle, Stop, X } from "@phosphor-icons/react";
import { streamAiFrom } from "@/lib/ai/client";
import { aiMarkdownToHtml } from "@/lib/ai/insert";
import { cleanAnswer, parseSummary } from "@/lib/ai/prompts";
import { aiCanInsert, aiInsertInto, aiReadOpen } from "@/lib/ai/editor-bridge";
import { DeviceAiError, deviceErrorText, deviceSummary, deviceSummaryFits, runRouted } from "@/lib/ai/device";
import { flushOpenDocuments } from "@/lib/document-flush";
import { useLocale, useT } from "./i18n";
import { AiProviderFooter, DeviceAiChip, useAiRoute } from "./ai-context";
import { Modal } from "./ui";

export type AiSummaryTarget = {
  pageId: string;
  rowId?: string;
  // A database view: its records in the order shown.
  rowIds?: string[];
  title: string;
  kind: "page" | "record" | "database";
  // A page of an end-to-end encrypted space: the device only.
  encrypted?: boolean;
};

// The callout for the top of the page: the summary and the key points.
export function summaryCallout(answer: string, heading: string) {
  const parsed = parseSummary(answer);
  const lines = [`> [!note] ${heading}`, ...parsed.summary.split("\n").map((line) => `> ${line}`)];
  if (parsed.points.length) lines.push(">", ...parsed.points.map((point) => `> - ${point}`));
  return lines.join("\n");
}
export const summaryChecklist = (answer: string) =>
  parseSummary(answer)
    .tasks.map((task) => `- [ ] ${task}`)
    .join("\n");

function AiSummaryBody({ target }: { target: AiSummaryTarget }) {
  const t = useT();
  const locale = useLocale();
  const controller = useRef<AbortController | null>(null);
  const [answer, setAnswer] = useState("");
  const [phase, setPhase] = useState<"running" | "done" | "error">("running");
  const [error, setError] = useState("");
  const [info, setInfo] = useState<{ included?: number; total?: number; parts: number; truncated: boolean }>({ parts: 1, truncated: false });
  const [status, setStatus] = useState("");
  // Database views always on the server; pages and records on the device
  // where it can.
  const route = useAiRoute("summarize", target.pageId, { encrypted: target.encrypted, enabled: target.kind !== "database" });
  const routeRef = useRef(route);
  routeRef.current = route;
  const [ranOn, setRanOn] = useState<"device" | "server" | null>(null);
  // The texts of the moment, without restarting the summary.
  const tRef = useRef(t);
  tRef.current = t;
  const run = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setAnswer("");
    setError("");
    setStatus("");
    setRanOn(null);
    setInfo({ parts: 1, truncated: false });
    setPhase("running");
    try {
      const { result: text } = await runRouted(routeRef.current, {
        device: async () => {
          setRanOn("device");
          const content = aiReadOpen(target.pageId, target.rowId);
          if (content === null) throw new DeviceAiError("unavailable", "not open");
          if (!content.trim()) throw new DeviceAiError("error", "empty");
          // Too long for the device: the server when it may, else the beginning.
          if (!deviceSummaryFits(content) && routeRef.current.fallback) throw new DeviceAiError("context-too-long");
          const summary = await deviceSummary(content, { title: target.title, locale, signal: abort.signal, onPart: (_part, parts) => setInfo({ parts, truncated: false }) });
          if (controller.current === abort) setInfo({ parts: summary.parts, truncated: summary.truncated });
          return summary.markdown;
        },
        server: async () => {
          setRanOn("server");
          // The server reads the stored page: unsaved changes go first.
          await flushOpenDocuments().catch(() => {});
          return await streamAiFrom(
            "/api/ai/summarize",
            { pageId: target.pageId, ...(target.rowId ? { rowId: target.rowId } : {}), ...(target.rowIds ? { rowIds: target.rowIds } : {}), locale },
            {
              signal: abort.signal,
              onText: (_piece, all) => setAnswer(all),
              onResponse: (response) => {
                const number = (name: string) => {
                  const value = response.headers.get(name);
                  return value === null ? undefined : Number(value);
                };
                setInfo({
                  included: number("X-Flowplan-AI-Included"),
                  total: number("X-Flowplan-AI-Total"),
                  parts: number("X-Flowplan-AI-Parts") || 1,
                  truncated: response.headers.get("X-Flowplan-AI-Truncated") === "1",
                });
              },
            },
          );
        },
      });
      if (controller.current !== abort) return;
      setAnswer(text);
      setPhase("done");
    } catch (e) {
      if (controller.current !== abort) return;
      if ((e as Error).name === "AbortError") return setPhase("done");
      setError(e instanceof DeviceAiError ? deviceErrorText(e, tRef.current) : (e as Error).message);
      setPhase("error");
    }
  }, [target, locale]);
  useEffect(() => {
    void run();
    return () => controller.current?.abort();
  }, [run]);
  const preview = useMemo(() => aiMarkdownToHtml(answer), [answer]);
  const tasks = useMemo(() => (phase === "done" ? parseSummary(answer).tasks : []), [answer, phase]);
  const insertable = phase === "done" && !!answer.trim() && target.kind !== "database" && aiCanInsert(target.pageId, target.rowId);
  const insert = (markdown: string, place: "top" | "caret") => {
    if (aiInsertInto(target.pageId, target.rowId, markdown, place)) setStatus(t("Eingefügt.", "Inserted."));
    else setStatus(t("Das Dokument ist nicht zum Bearbeiten geöffnet.", "The document is not open for editing."));
  };
  return (
    <div className="ai-summary">
      {ranOn === "device" && (
        <p className="ai-summary-source">
          <DeviceAiChip />
        </p>
      )}
      {(info.included !== undefined || info.parts > 1 || info.truncated) && (
        <p className="ai-summary-note">
          <Info size={14} aria-hidden />
          <span>
            {info.included !== undefined &&
              info.total !== undefined &&
              (info.included < info.total
                ? t(`${info.included} von ${info.total} Einträgen der Ansicht zusammengefasst (Höchstgrenze oder für die KI gesperrt).`, `${info.included} of ${info.total} records of the view summarised (limit, or closed to the AI).`)
                : t(`Alle ${info.total} Einträge der Ansicht zusammengefasst.`, `All ${info.total} records of the view summarised.`))}
            {info.parts > 1 && ` ${t(`Lang: in ${info.parts} Teilen zusammengefasst.`, `Long: summarised in ${info.parts} parts.`)}`}
            {info.truncated && ` ${t("Sehr lang: nur der Anfang wurde berücksichtigt.", "Very long: only the beginning was included.")}`}
          </span>
        </p>
      )}
      <div className={`ai-preview${phase === "running" ? " streaming" : ""}`} aria-live="polite" aria-busy={phase === "running"}>
        {answer ? (
          <div dangerouslySetInnerHTML={{ __html: preview }} />
        ) : phase === "running" ? (
          <p className="muted">
            {info.parts > 1
              ? t("Lange Inhalte werden in Teilen gelesen …", "Long content is read in parts …")
              : ranOn === "device"
                ? t("Die KI auf diesem Gerät liest …", "The on-device AI is reading …")
                : t("Die KI liest …", "The AI is reading …")}
          </p>
        ) : null}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="ai-writer-buttons">
        {phase === "running" ? (
          <button type="button" className="button compact" onClick={() => controller.current?.abort()}>
            <Stop size={14} weight="fill" /> {t("Stopp", "Stop")}
          </button>
        ) : (
          <>
            {insertable && (
              <button type="button" className="button primary compact" onClick={() => insert(summaryCallout(answer, t("KI-Zusammenfassung", "AI summary")), "top")}>
                <Info size={14} /> {t("Als Callout oben einfügen", "Insert as callout at the top")}
              </button>
            )}
            {insertable && tasks.length > 0 && (
              <button type="button" className="button compact" onClick={() => insert(summaryChecklist(answer), "caret")}>
                <CheckSquare size={14} /> {t("Aufgaben als Checkliste einfügen", "Insert tasks as checklist")}
              </button>
            )}
            {answer.trim() && (
              <button
                type="button"
                className="button compact"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(cleanAnswer(answer))
                    .then(() => setStatus(t("Kopiert.", "Copied.")))
                    .catch(() => setStatus(t("Kopieren nicht möglich.", "Copying failed.")))
                }
              >
                <Copy size={14} /> {t("Kopieren", "Copy")}
              </button>
            )}
            <button type="button" className="button compact" onClick={() => void run()}>
              <ArrowClockwise size={14} /> {t("Erneut", "Retry")}
            </button>
          </>
        )}
      </div>
      {status && (
        <p className="ai-summary-status muted" role="status">
          {status}
        </p>
      )}
      <AiProviderFooter device={ranOn ? ranOn === "device" : route.primary === "device"} />
    </div>
  );
}

// Next to a page, like the comments.
export function AiSummaryPanel({ target, onClose }: { target: AiSummaryTarget; onClose: () => void }) {
  const t = useT();
  return (
    <aside className="comments-panel ai-summary-panel" aria-label={t("KI-Zusammenfassung", "AI summary")}>
      <header>
        <h3>
          <Sparkle size={16} weight="fill" aria-hidden /> {t("Zusammenfassung", "Summary")}
        </h3>
        <button className="icon-button" aria-label={t("Zusammenfassung schließen", "Close summary")} onClick={onClose}>
          <X />
        </button>
      </header>
      <AiSummaryBody key={`${target.pageId}-${target.rowId || ""}`} target={target} />
    </aside>
  );
}

// For a database view or a record (both live in dialogs already).
export function AiSummaryDialog({ target, onClose }: { target: AiSummaryTarget | null; onClose: () => void }) {
  const t = useT();
  return (
    <Modal open={!!target} onClose={onClose} title={target ? t(`Zusammenfassung: ${target.title}`, `Summary: ${target.title}`) : ""} wide>
      {target && <AiSummaryBody target={target} />}
    </Modal>
  );
}
