"use client";
// "Mit KI zusammenfassen" in a journal's review (#170): the week or month
// the review shows as highlights, a chronological overview and open items.
// The server collects the days and checks everything (lib/ai/journal-summary.ts);
// the answer streams in here as a preview. Nothing is stored until "Als
// Seite speichern" – a sub page of the journal, one per period
// (lib/journal-summary.ts saveAiSummary); asked again, the page there is
// offered: open it, or replace its content.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, ArrowsClockwise, Copy, FloppyDisk, Info, Sparkle, Stop, Trash } from "@phosphor-icons/react";
import { textLocale } from "@/lib/i18n";
import { streamAiFrom } from "@/lib/ai/client";
import { aiMarkdownToHtml } from "@/lib/ai/insert";
import { cleanAnswer } from "@/lib/ai/prompts";
import { useLocale, useT } from "./i18n";
import { AiProviderFooter } from "./ai-context";
import { api } from "./ui";

type Phase = "ask" | "running" | "done" | "error" | "exists";

export function JournalAiSummary({
  pageId,
  from,
  to,
  label,
  editable,
  existingId,
  onSaved,
  onOpen,
  onDiscard,
}: {
  pageId: string;
  from: string;
  to: string;
  label: string;
  // May save the answer as a page below the journal.
  editable: boolean;
  // The period's saved AI summary, when there is one.
  existingId: string | null;
  onSaved: (id: string) => Promise<unknown> | void;
  onOpen: (id: string) => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const locale = textLocale(useLocale());
  const controller = useRef<AbortController | null>(null);
  // A saved summary first offers itself (open, or make a new one to replace it).
  const [phase, setPhase] = useState<Phase>(existingId ? "ask" : "running");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [known, setKnown] = useState(existingId);
  const [info, setInfo] = useState<{ included?: number; total?: number; parts: number; truncated: boolean }>({ parts: 1, truncated: false });
  const run = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setAnswer("");
    setError("");
    setStatus("");
    setInfo({ parts: 1, truncated: false });
    setPhase("running");
    try {
      const text = await streamAiFrom(
        "/api/ai/journal-summary",
        { journalId: pageId, from, to, locale },
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
      if (controller.current !== abort) return;
      setAnswer(text);
      setPhase("done");
    } catch (e) {
      if (controller.current !== abort) return;
      if ((e as Error).name === "AbortError") return setPhase("done");
      setError((e as Error).message);
      setPhase("error");
    }
  }, [pageId, from, to, locale]);
  useEffect(() => {
    if (!existingId) void run();
    return () => controller.current?.abort();
    // Once per period (the review gives each period its own panel).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const preview = useMemo(() => aiMarkdownToHtml(answer), [answer]);
  const save = async (replace = false) => {
    setSaving(true);
    try {
      const result = await api<{ id: string; existing: boolean; replaced?: boolean }>("/api/command", {
        action: "journal.aiSummary",
        pageId,
        from,
        to,
        markdown: cleanAnswer(answer),
        ...(replace ? { replace: true } : {}),
      });
      if (result.existing) {
        // Saved meanwhile (another tab, another person): open or replace.
        setKnown(result.id);
        setPhase("exists");
        return;
      }
      await onSaved(result.id);
      onOpen(result.id);
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    controller.current?.abort();
    onDiscard();
  };
  return (
    <section className="journal-ai-summary ai-summary" aria-label={t("KI-Zusammenfassung", "AI summary")}>
      <h3>
        <Sparkle size={16} weight="fill" aria-hidden /> {t(`KI-Zusammenfassung: ${label}`, `AI summary: ${label}`)}
      </h3>
      {phase === "ask" || phase === "exists" ? (
        <>
          <p className="journal-summary-exists" role="status">
            {t(`Für ${label} gibt es schon eine KI-Zusammenfassung.`, `There already is an AI summary for ${label}.`)}
          </p>
          <div className="ai-writer-buttons">
            <button type="button" className="button primary compact" onClick={() => known && onOpen(known)}>
              <ArrowSquareOut size={14} /> {t("Öffnen", "Open")}
            </button>
            {editable && (
              <button
                type="button"
                className="button compact"
                disabled={saving}
                onClick={() => (phase === "exists" && answer.trim() ? void save(true) : void run())}
              >
                <ArrowsClockwise size={14} /> {phase === "exists" && answer.trim() ? t("Durch diese ersetzen", "Replace with this one") : t("Neu erstellen und ersetzen", "Create again and replace")}
              </button>
            )}
            <button type="button" className="button compact" onClick={discard}>
              <Trash size={14} /> {t("Verwerfen", "Discard")}
            </button>
          </div>
        </>
      ) : (
        <>
          {(info.parts > 1 || info.truncated || (info.included !== undefined && info.total !== undefined && info.included < info.total)) && (
            <p className="ai-summary-note">
              <Info size={14} aria-hidden />
              <span>
                {info.included !== undefined &&
                  info.total !== undefined &&
                  info.included < info.total &&
                  t(`${info.included} von ${info.total} Tagen zusammengefasst (die übrigen sind für die KI gesperrt).`, `${info.included} of ${info.total} days summarised (the others are closed to the AI).`)}
                {info.parts > 1 && ` ${t(`Lang: in ${info.parts} Teilen zusammengefasst.`, `Long: summarised in ${info.parts} parts.`)}`}
                {info.truncated && ` ${t("Sehr lang: nur der Anfang wurde berücksichtigt.", "Very long: only the beginning was included.")}`}
              </span>
            </p>
          )}
          <div className={`ai-preview${phase === "running" ? " streaming" : ""}`} aria-live="polite" aria-busy={phase === "running"}>
            {answer ? (
              <div dangerouslySetInnerHTML={{ __html: preview }} />
            ) : phase === "running" ? (
              <p className="muted">{info.parts > 1 ? t("Lange Inhalte werden in Teilen gelesen …", "Long content is read in parts …") : t("Die KI liest …", "The AI is reading …")}</p>
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
                {editable && answer.trim() && (
                  <button type="button" className="button primary compact" disabled={saving} onClick={() => void save(!!known)}>
                    <FloppyDisk size={14} /> {saving ? t("Wird gespeichert …", "Saving …") : known ? t("Als Seite speichern (ersetzt die bisherige)", "Save as page (replaces the previous one)") : t("Als Seite speichern", "Save as page")}
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
                  <ArrowsClockwise size={14} /> {t("Erneut", "Retry")}
                </button>
              </>
            )}
            <button type="button" className="button compact" onClick={discard}>
              <Trash size={14} /> {t("Verwerfen", "Discard")}
            </button>
          </div>
        </>
      )}
      {status && (
        <p className="ai-summary-status muted" role="status">
          {status}
        </p>
      )}
      {phase !== "ask" && phase !== "exists" && <AiProviderFooter />}
    </section>
  );
}
