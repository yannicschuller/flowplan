"use client";
// The focus mode of a study session (docs/specs/flashcards.md §6): a layer
// over the app with one card at a time.
//
// - Space or Enter (or a tap on the card) reveals the answer; then 1–4 rate
//   it Again / Hard / Good / Easy, Space or Enter is Good. Z (⌘Z / Ctrl+Z)
//   undoes the last rating, H shows the hint, Escape ends the session.
// - On touch screens a revealed card is swiped: left Again, right Good, up
//   Easy, down Hard, past 30 % of its width (height). A swipe that starts
//   within 24 px of the screen's edge is the system's or the app's (back,
//   sidebar) and leaves the card alone. The buttons are always there.
// - The intervals under the buttons come from lib/fsrs with the review's
//   id as seed – the same the server computes for the rating.
// - Undo asks the server (study.undo), which replays the card's log; the
//   card comes back unrated.
// - The answer time is measured while the tab is visible, capped at 60 s,
//   and only kept in the person's own log.
// - A dialog (aria-modal): the app's back gesture ends the session
//   (lib/app-back.ts); motion follows the person's setting.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Lightbulb, X } from "@phosphor-icons/react";
import { useLocale, useT } from "../i18n";
import { localeTag } from "@/lib/i18n";
import { api } from "../ui";
import { InlineText } from "../inline-text";
import { ReadOnlyDocument } from "../read-only-document";
import { intervalOf, preview, type FsrsParams, type Memory, type StudyRating } from "@/lib/fsrs";

export type StudySide = { text: string; formatted?: boolean } | { html: string };
export type StudyCard = { rowId: string; sub: string; kind: string; memory: Memory | null; front: StudySide; back: StudySide; hint?: StudySide; extra?: StudySide };
type Counts = { new: number; learning: number; review: number };
type Base = { pageId: string; title: string; zone: string; dayStart: number; day: string; dayEnd: number; now: number };
export type StudyOverview =
  | (Base & { configured: false })
  | (Base & {
      configured: true;
      blocked: "hidden" | null;
      params: FsrsParams;
      limits: { new: number; review: number };
      prefs: { newPerDay: number | null; reviewsPerDay: number | null; retention: number | null; moreToday: { new: number; review: number } };
      deckDefaults: { newPerDay: number; reviewsPerDay: number; retention: number };
      done: { new: number; review: number; all: number };
      counts: Counts;
      nextDue: number | null;
      total: number;
      states: { new: number; learning: number; review: number };
      tomorrow: number;
      cards: StudyCard[];
    });
type Ready = Extract<StudyOverview, { configured: true }>;

export const studyZoneNow = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
const EDGE = 24;
const MAX_DURATION = 60_000;
const UNDO_DEPTH = 20;

// The interval on a button: short ("4 T") and long ("in 4 Tagen").
function useIntervalText() {
  const t = useT();
  const format = new Intl.NumberFormat(localeTag(useLocale()), { maximumFractionDigits: 1 });
  return (memory: Memory, now: number, clock: { zone: string; dayStart: number }) => {
    const { unit, value } = intervalOf(memory, now, clock);
    const n = format.format(value);
    switch (unit) {
      case "now":
        return { short: t("< 1 Min", "< 1 min"), long: t("in weniger als einer Minute", "in less than a minute") };
      case "minutes":
        return { short: t(`${n} Min`, `${n} min`), long: t(`in ${n} Minuten`, `in ${n} minutes`) };
      case "hours":
        return { short: t(`${n} Std`, `${n} h`), long: t(`in ${n} Stunden`, `in ${n} hours`) };
      case "days":
        return value === 1 ? { short: t("1 T", "1 d"), long: t("morgen", "tomorrow") } : { short: t(`${n} T`, `${n} d`), long: t(`in ${n} Tagen`, `in ${n} days`) };
      case "months":
        return { short: t(`${n} Mon.`, `${n} mo`), long: t(`in ${n} Monaten`, `in ${n} months`) };
      default:
        return { short: t(`${n} J`, `${n} y`), long: t(`in ${n} Jahren`, `in ${n} years`) };
    }
  };
}

function Side({ side, pageId }: { side: StudySide; pageId: string }) {
  if ("html" in side) return <ReadOnlyDocument html={side.html} pageId={pageId} className="study-document" />;
  return <p className="study-text">{side.formatted ? <InlineText value={side.text} /> : side.text}</p>;
}
const sidePlain = (side: StudySide) => ("html" in side ? new DOMParser().parseFromString(side.html, "text/html").body.textContent || "" : side.text);

type Shown = { card: StudyCard; reviewId: string; revealed: boolean; hint: boolean };
type Done = { reviewId: string; card: StudyCard; rating: StudyRating; wasNew: boolean; durationMs: number };

export function StudyFocus({ pageId, viewId, title, onClose }: { pageId: string; viewId?: string; title: string; onClose: () => void }) {
  const t = useT();
  const intervalText = useIntervalText();
  const [deck, setDeck] = useState<Ready | null>(null),
    [queue, setQueue] = useState<StudyCard[]>([]),
    [shown, setShown] = useState<Shown | null>(null),
    [phase, setPhase] = useState<"loading" | "card" | "done">("loading"),
    [history, setHistory] = useState<Done[]>([]),
    [error, setError] = useState(""),
    [announce, setAnnounce] = useState(""),
    [swipe, setSwipe] = useState<StudyRating | null>(null),
    [position, setPosition] = useState(1);
  const busy = useRef(false),
    root = useRef<HTMLDivElement>(null),
    cardRef = useRef<HTMLDivElement>(null),
    backRef = useRef<HTMLDivElement>(null),
    closeRef = useRef(onClose),
    started = useRef(Date.now()),
    // The answer time: visible time since the card was shown.
    timer = useRef<{ spent: number; since: number | null }>({ spent: 0, since: null });
  closeRef.current = onClose;
  const zone = useMemo(studyZoneNow, []);
  const startTimer = () => (timer.current = { spent: 0, since: document.visibilityState === "visible" ? performance.now() : null });
  const show = useCallback((card: StudyCard | undefined) => {
    if (!card) {
      setShown(null);
      setPhase("done");
      return;
    }
    setShown({ card, reviewId: crypto.randomUUID(), revealed: false, hint: false });
    setPhase("card");
    startTimer();
  }, []);
  // The next batch from the server: learning cards due soon first, then
  // reviews and new cards within today's limits.
  const load = useCallback(async () => {
    const query = new URLSearchParams({ zone, limit: "50" });
    if (viewId) query.set("view", viewId);
    const next = await api<StudyOverview>(`/api/pages/${pageId}/study?${query}`);
    if (!next.configured) {
      closeRef.current();
      return;
    }
    setDeck(next);
    setQueue(next.cards.slice(1));
    show(next.cards[0]);
  }, [pageId, viewId, zone, show]);
  useEffect(() => {
    load().catch((e) => {
      setError((e as Error).message);
      setPhase("done");
    });
  }, [load]);
  useEffect(() => {
    root.current?.focus();
  }, []);
  useEffect(() => {
    const visibility = () => {
      const now = performance.now();
      const state = timer.current;
      if (document.visibilityState === "visible") state.since ??= now;
      else if (state.since !== null) {
        state.spent += now - state.since;
        state.since = null;
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  const reveal = useCallback(() => {
    setShown((s) => (s && !s.revealed ? { ...s, revealed: true } : s));
  }, []);
  useEffect(() => {
    if (!shown?.revealed) return;
    backRef.current?.focus();
    setAnnounce(t(`Antwort: ${sidePlain(shown.card.back)}`, `Answer: ${sidePlain(shown.card.back)}`).slice(0, 400));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.revealed, shown?.reviewId]);
  const clock = deck ? { zone: deck.zone, dayStart: deck.dayStart } : { zone, dayStart: 4 };
  const outcomes = useMemo(
    () => (deck && shown ? preview(shown.card.memory, Date.now(), deck.params, clock, shown.reviewId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deck?.params, deck?.zone, deck?.dayStart, shown?.reviewId, shown?.revealed],
  );
  const rate = useCallback(
    async (rating: StudyRating) => {
      if (!shown?.revealed || busy.current || !deck) return;
      busy.current = true;
      const state = timer.current;
      const durationMs = Math.min(MAX_DURATION, Math.round(state.spent + (state.since === null ? 0 : performance.now() - state.since)));
      try {
        const answer = await api<Ready & { review: { memory: Memory } }>("/api/command", {
          action: "study.review",
          id: shown.reviewId,
          pageId,
          rowId: shown.card.rowId,
          sub: shown.card.sub,
          rating,
          zone,
          durationMs,
          ...(viewId ? { viewId } : {}),
        });
        setDeck((d) => (d ? { ...d, ...answer, cards: d.cards } : d));
        setHistory((h) => [...h, { reviewId: shown.reviewId, card: shown.card, rating, wasNew: !shown.card.memory, durationMs }].slice(-UNDO_DEPTH));
        setPosition((p) => p + 1);
        setError("");
        if (queue.length) {
          show(queue[0]);
          setQueue(queue.slice(1));
        } else await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        busy.current = false;
      }
    },
    [shown, deck, pageId, zone, viewId, queue, show, load],
  );
  const undo = useCallback(async () => {
    const last = history.at(-1);
    if (!last || busy.current) return;
    busy.current = true;
    try {
      const answer = await api<Ready & { card: StudyCard | null }>("/api/command", { action: "study.undo", pageId, reviewId: last.reviewId, zone, ...(viewId ? { viewId } : {}) });
      setDeck((d) => (d ? { ...d, ...answer, cards: d.cards } : d));
      setHistory((h) => h.slice(0, -1));
      setPosition((p) => Math.max(1, p - 1));
      // The card again, unrated; the one shown waits behind it.
      if (shown && phase === "card") setQueue((q) => [shown.card, ...q.filter((c) => !(c.rowId === shown.card.rowId && c.sub === shown.card.sub))]);
      show(answer.card ?? last.card);
      setAnnounce(t("Letzte Wertung rückgängig gemacht.", "Last rating undone."));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [history, pageId, zone, viewId, shown, phase, show, t]);
  // Keys win over the app's shortcuts while the session is open.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Dialogs above the session (none yet) and form fields keep their keys.
      if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if ((e.key === "z" || e.key === "Z") && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (phase !== "card" || !shown) return;
      if (e.key === " " || e.key === "Enter") {
        // Buttons keep Enter and Space.
        if (target?.closest?.("button, a")) return;
        e.preventDefault();
        e.stopPropagation();
        if (!shown.revealed) reveal();
        else void rate(3);
        return;
      }
      if (["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        void rate(Number(e.key) as StudyRating);
        return;
      }
      if ((e.key === "h" || e.key === "H") && shown.card.hint) {
        e.preventDefault();
        e.stopPropagation();
        setShown({ ...shown, hint: true });
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [phase, shown, reveal, rate, undo]);
  // Swiping a revealed card (pointer events; the transform is set through
  // the element's style object, which the CSP allows).
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const directionOf = (dx: number, dy: number, el: HTMLElement): StudyRating | null => {
    const { width, height } = el.getBoundingClientRect();
    if (Math.abs(dx) >= Math.abs(dy)) return Math.abs(dx) >= width * 0.3 ? (dx < 0 ? 1 : 3) : null;
    return Math.abs(dy) >= Math.min(height, width) * 0.3 ? (dy < 0 ? 4 : 2) : null;
  };
  const resetCard = () => {
    const el = cardRef.current;
    if (el) el.style.transform = "";
    setSwipe(null);
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("a, button, input, video, audio")) return;
    // The edges belong to the system and the app (back, sidebar).
    if (e.clientX < EDGE || e.clientX > innerWidth - EDGE || e.clientY < EDGE || e.clientY > innerHeight - EDGE) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current,
      el = cardRef.current;
    if (!d || d.id !== e.pointerId || !el || !shown?.revealed) return;
    const dx = e.clientX - d.x,
      dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 8) return;
    if (!d.moved) el.setPointerCapture?.(e.pointerId);
    d.moved = true;
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${Math.max(-12, Math.min(12, dx / 25))}deg)`;
    setSwipe(directionOf(dx, dy, el));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current,
      el = cardRef.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId || !el) return;
    if (!d.moved) {
      if (!shown?.revealed) reveal();
      return;
    }
    const rating = directionOf(e.clientX - d.x, e.clientY - d.y, el);
    resetCard();
    if (rating && shown?.revealed) void rate(rating);
  };
  const left = deck ? deck.counts.new + deck.counts.learning + deck.counts.review : 0;
  const reviewed = history.length;
  const labels: Record<StudyRating, string> = { 1: t("Nochmal", "Again"), 2: t("Schwer", "Hard"), 3: t("Gut", "Good"), 4: t("Leicht", "Easy") };
  const minutes = Math.max(1, Math.round((Date.now() - started.current) / 60_000));
  const correct = reviewed ? Math.round((history.filter((h) => h.rating > 1).length / reviewed) * 100) : 0;
  return (
    <div className="study-focus" role="dialog" aria-modal="true" aria-label={t(`Lernen: ${title}`, `Study: ${title}`)} tabIndex={-1} ref={root}>
      <header className="study-focus-bar">
        <button className="icon-button" onClick={() => closeRef.current()} title={t("Sitzung beenden (Esc)", "End session (Esc)")} aria-label={t("Sitzung beenden", "End session")}>
          <X size={20} />
        </button>
        <span className="study-focus-title">{title}</span>
        <span className="study-focus-counts" aria-label={deck ? t(`Noch ${deck.counts.new} neu, ${deck.counts.learning} in Lernschritten, ${deck.counts.review} fällig`, `${deck.counts.new} new, ${deck.counts.learning} learning, ${deck.counts.review} due left`) : undefined}>
          {deck && (
            <>
              <span className="study-count-chip new">{t(`neu ${deck.counts.new}`, `new ${deck.counts.new}`)}</span>
              <span className="study-count-chip learning">{t(`Lernen ${deck.counts.learning}`, `learning ${deck.counts.learning}`)}</span>
              <span className="study-count-chip review">{t(`fällig ${deck.counts.review}`, `due ${deck.counts.review}`)}</span>
            </>
          )}
        </span>
        <button className="icon-button" onClick={() => void undo()} disabled={!history.length} title={t("Letzte Wertung rückgängig (Z)", "Undo last rating (Z)")} aria-label={t("Letzte Wertung rückgängig", "Undo last rating")}>
          <ArrowCounterClockwise size={20} />
        </button>
      </header>
      <progress className="study-progress" max={Math.max(1, reviewed + left)} value={reviewed} aria-label={t("Fortschritt", "Progress")} />
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      {error && (
        <p className="study-error study-focus-error" role="alert">
          {error}
        </p>
      )}
      {phase === "loading" && <p className="study-focus-loading muted">{t("Karten werden geladen …", "Loading cards …")}</p>}
      {phase === "card" && shown && deck && (
        <main className="study-focus-main">
          <div
            className={`study-card${shown.revealed ? " revealed" : ""}${swipe ? ` swipe-${swipe}` : ""}`}
            ref={cardRef}
            role="region"
            aria-label={t(`Karte ${position} von ${Math.max(position, position - 1 + left)}`, `Card ${position} of ${Math.max(position, position - 1 + left)}`)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              drag.current = null;
              resetCard();
            }}
          >
            {swipe && (
              <span className={`study-swipe-label rating-${swipe}`} aria-hidden>
                {labels[swipe]}
              </span>
            )}
            <div className="study-side study-front">
              <Side side={shown.card.front} pageId={pageId} />
            </div>
            {shown.card.hint && !shown.revealed && (
              <div className="study-hint">
                {shown.hint ? (
                  <Side side={shown.card.hint} pageId={pageId} />
                ) : (
                  <button className="button compact" onClick={() => setShown({ ...shown, hint: true })}>
                    <Lightbulb aria-hidden /> {t("Hinweis (H)", "Hint (H)")}
                  </button>
                )}
              </div>
            )}
            {shown.revealed && (
              <div className="study-side study-back" ref={backRef} tabIndex={-1} aria-label={t("Antwort", "Answer")}>
                <hr />
                <Side side={shown.card.back} pageId={pageId} />
                {shown.card.extra && (
                  <div className="study-extra">
                    <Side side={shown.card.extra} pageId={pageId} />
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="study-answer-bar">
            {!shown.revealed ? (
              <button className="button primary study-reveal" onClick={reveal}>
                {t("Antwort zeigen", "Show answer")} <kbd>{t("Leertaste", "Space")}</kbd>
              </button>
            ) : (
              <div className="study-ratings" role="group" aria-label={t("Wie gut wusstest du es?", "How well did you know it?")}>
                {([1, 2, 3, 4] as const).map((r) => {
                  const interval = outcomes ? intervalText(outcomes[r].memory, Date.now(), clock) : null;
                  return (
                    <button
                      key={r}
                      className={`button study-rate rating-${r}`}
                      onClick={() => void rate(r)}
                      aria-label={interval ? t(`${labels[r]}, nächste Wiederholung ${interval.long}`, `${labels[r]}, next review ${interval.long}`) : labels[r]}
                      aria-keyshortcuts={String(r)}
                    >
                      <span className="study-rate-label">
                        <kbd>{r}</kbd> {labels[r]}
                      </span>
                      {interval && <small aria-hidden>{interval.short}</small>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      )}
      {phase === "done" && (
        <main className="study-focus-main study-summary" aria-labelledby="study-summary-title">
          <h2 id="study-summary-title">{deck?.nextDue ? t("Für jetzt geschafft", "Done for now") : t("Geschafft für heute", "Done for today")}</h2>
          {reviewed > 0 && (
            <p>
              {t(`${reviewed} Karten in ${minutes} Min`, `${reviewed} cards in ${minutes} min`)} · {t(`${history.filter((h) => h.wasNew).length} neu`, `${history.filter((h) => h.wasNew).length} new`)} ·{" "}
              {t(`${history.filter((h) => h.rating === 1).length}× „Nochmal“`, `${history.filter((h) => h.rating === 1).length}× “Again”`)} · {t(`Richtig ${correct} %`, `Correct ${correct} %`)}
            </p>
          )}
          {deck?.nextDue && (
            <p className="muted">
              {t(
                `Die nächste Karte in Lernschritten ist um ${new Date(deck.nextDue).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} dran.`,
                `The next card in learning steps is up at ${new Date(deck.nextDue).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`,
              )}
            </p>
          )}
          {deck && <p className="muted">{t(`Morgen fällig: ${deck.tomorrow}`, `Due tomorrow: ${deck.tomorrow}`)}</p>}
          <div className="study-summary-actions">
            <button
              className="button"
              onClick={async () => {
                try {
                  await api("/api/command", { action: "study.prefs", pageId, zone, more: { new: 10 } });
                  setPhase("loading");
                  await load();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {t("Heute mehr lernen (+10 neue)", "Study more today (+10 new)")}
            </button>
            <button className="button primary" onClick={() => closeRef.current()} autoFocus>
              {t("Zurück zum Stapel", "Back to the deck")}
            </button>
          </div>
        </main>
      )}
    </div>
  );
}
