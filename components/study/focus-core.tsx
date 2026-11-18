"use client";
// The focus mode of a study session (docs/specs/flashcards.md §6): a layer
// with one card at a time. Where the cards come from and where a rating
// goes is the caller's (`backend`): the app's session with the server and
// the offline copy (./focus.tsx StudyFocus), or the practice of a public
// link with its state in the browser (./public-practice.tsx).
//
// - Space or Enter (or a tap on the card) reveals the answer; then 1–4 rate
//   it Again / Hard / Good / Easy, Space or Enter is Good. Z (⌘Z / Ctrl+Z)
//   undoes the last rating, H shows the hint, Escape ends the session.
// - On touch screens a revealed card is swiped: left Again, right Good, up
//   Easy, down Hard, past 30 % of its width (height). A swipe that starts
//   within 24 px of the screen's edge is the system's or the app's (back,
//   sidebar) and leaves the card alone. The buttons are always there.
// - The intervals under the buttons come from lib/fsrs with the review's
//   id as seed – the same the backend computes for the rating.
// - The answer time is measured while the tab is visible, capped at 60 s.
// - A dialog (aria-modal): the app's back gesture ends the session
//   (lib/app-back.ts); motion follows the person's setting.
// - Card types (§5): a cloze card hides its gaps and shows them filled
//   when revealed; a typed card asks for the answer in a field (Enter
//   checks, the comparison suggests a rating), a multiple choice card
//   offers its options (A–E, shuffled per review), an image occlusion card
//   shows its picture with the masks asked covered and opens them. The
//   suggestion is preselected – Space or Enter takes it – but every rating
//   stays open.
// - Only learning cards later today left: a wait screen counts down to the
//   next one and offers "Früher zeigen" (the queue with `ahead`).
// - `next`: the deck after this one (#study, "Alle fälligen lernen").
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowCounterClockwise, Fire, Hourglass, Lightbulb, X } from "@phosphor-icons/react";
import { useLocale, useT } from "../i18n";
import { localeTag } from "@/lib/i18n";
import { CHOICE_KEYS, ChoiceOptions, Side, TypedVerdict, choiceOrder, type StudySide } from "./card-parts";
import { OcclusionImage } from "./occlusion-image";
import type { OcclusionCard } from "@/lib/study-content";
import { compareTyped, type TypedResult } from "@/lib/study-compare";
import { intervalOf, preview, type FsrsParams, type Memory, type StudyRating } from "@/lib/fsrs";
import { intervalText, minutesText } from "@/lib/study-interval";
import type { TypedCompare } from "@/lib/study-schema";

export type { StudySide } from "./card-parts";
export type StudyCard = {
  rowId: string;
  sub: string;
  kind: string;
  memory: Memory | null;
  front: StudySide;
  back: StudySide;
  hint?: StudySide;
  extra?: StudySide;
  // Cloze cards: the other side – above (context) or after revealing (note).
  context?: StudySide;
  note?: StudySide;
  typed?: { answer: string };
  choice?: { options: string[]; correct: number };
  // Image occlusion: the picture, its masks and the ones asked.
  occlusion?: OcclusionCard;
};
type Counts = { new: number; learning: number; review: number };
// `offline`: built on the device (components/study/offline.ts), `pending`:
// ratings of the deck waiting for the connection.
type Base = { pageId: string; title: string; userId?: string; zone: string; dayStart: number; day: string; dayEnd: number; now: number; offline?: boolean; pending?: number };
export type StudyFit = { logLoss: number; rmse: number; items: number };
export type StudyModel = { source: "default" | "deck" | "all"; at: number | null; reviews: number | null; fit: { before: StudyFit; after: StudyFit } | null };
export type StudyOverview =
  | (Base & { configured: false })
  | (Base & {
      configured: true;
      blocked: "hidden" | null;
      settings?: { typedCompare?: Partial<TypedCompare> };
      params: FsrsParams;
      // The FSRS weights in use (§23) and, in the overview, the note to
      // optimise them.
      model?: StudyModel;
      optimizer?: { reviews: number; since: number | null; suggest: "first" | "again" | null };
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
      // With no card left: the workspace's streak (the summary's tile).
      streak?: number;
    });
export type Ready = Extract<StudyOverview, { configured: true }>;

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

// The interval on a button: short ("10 Tage") and long ("in 10 Tagen"),
// lib/study-interval.ts.
function useNumberFormat() {
  const format = new Intl.NumberFormat(localeTag(useLocale()), { maximumFractionDigits: 1 });
  return (n: number) => format.format(n);
}

const sidePlain = (side: StudySide) => ("html" in side ? new DOMParser().parseFromString(side.html, "text/html").body.textContent || "" : side.text);
const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
// A typed or multiple choice card: the back says nothing beyond the
// expected answer shown already (the comparison, the marked option).
const backRepeats = (card: StudyCard) => {
  const expected = card.typed?.answer ?? (card.choice ? card.choice.options[card.choice.correct] : undefined);
  return expected !== undefined && sameText(sidePlain(card.back), expected);
};
// The kind of a card in the counts: new, in the learning phase, due.
const kindOf = (card: StudyCard): keyof Counts => (!card.memory ? "new" : card.memory.state === 2 ? "review" : "learning");

type Shown = {
  card: StudyCard;
  reviewId: string;
  revealed: boolean;
  hint: boolean;
  // A typed card: the text and its comparison; a choice card: the pick.
  typed: string;
  result: TypedResult | null;
  picked: number | null;
  // The rating the answer suggests (Space and Enter take it).
  suggested: StudyRating | null;
};
// `offline`: the rating waits on the device (undone there).
export type FocusDone = { reviewId: string; card: StudyCard; rating: StudyRating; wasNew: boolean; durationMs: number; offline?: boolean };
// The session's ratings for its summary (not capped like the undo history).
type Rated = { key: string; rating: StudyRating; wasNew: boolean };
// Where a session's cards come from and its ratings go. `load`: the next
// batch (`ahead`: learning cards due later today too); `rate` and `undo`
// answer with the deck's new counts (or null to keep them); `more`:
// "Heute mehr lernen" (none: no button).
export type FocusBackend = {
  load: (ahead: boolean) => Promise<StudyOverview>;
  rate: (review: { card: StudyCard; rating: StudyRating; reviewId: string; durationMs: number }) => Promise<{ deck: Ready | null; offline?: boolean }>;
  undo: (last: FocusDone) => Promise<{ deck: Ready | null; card?: StudyCard | null }>;
  more?: () => Promise<void>;
};

export function FocusSession({
  pageId,
  title,
  onClose,
  next,
  backend,
  notice,
  shareToken,
}: {
  pageId: string;
  title: string;
  onClose: () => void;
  next?: { title: string; start: () => void };
  backend: FocusBackend;
  // Shown under the progress bar (waiting ratings, the note of a public link).
  notice?: ReactNode;
  // Documents of a public link: their embeds through the share.
  shareToken?: string;
}) {
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const t = useT();
  const locale = useLocale();
  const format = useNumberFormat();
  const intervalOfMemory = (memory: Memory, now: number, clock: { zone: string; dayStart: number }) => {
    const { unit, value } = intervalOf(memory, now, clock);
    return intervalText(unit, value, format, t);
  };
  const [deck, setDeck] = useState<Ready | null>(null),
    [queue, setQueue] = useState<StudyCard[]>([]),
    [shown, setShown] = useState<Shown | null>(null),
    [phase, setPhase] = useState<"loading" | "card" | "wait" | "done">("loading"),
    [history, setHistory] = useState<FocusDone[]>([]),
    [rated, setRated] = useState<Rated[]>([]),
    [legend, setLegend] = useState(false),
    [error, setError] = useState(""),
    [announce, setAnnounce] = useState(""),
    [swipe, setSwipe] = useState<StudyRating | null>(null),
    [position, setPosition] = useState(1);
  const busy = useRef(false),
    root = useRef<HTMLDivElement>(null),
    cardRef = useRef<HTMLDivElement>(null),
    backRef = useRef<HTMLDivElement>(null),
    typedRef = useRef<HTMLInputElement>(null),
    closeRef = useRef(onClose),
    started = useRef(Date.now()),
    // The answer time: visible time since the card was shown.
    timer = useRef<{ spent: number; since: number | null }>({ spent: 0, since: null });
  closeRef.current = onClose;
  const zone = useMemo(studyZoneNow, []);
  const startTimer = () => (timer.current = { spent: 0, since: document.visibilityState === "visible" ? performance.now() : null });
  const show = useCallback((card: StudyCard | undefined, waiting = false) => {
    if (!card) {
      setShown(null);
      setPhase(waiting ? "wait" : "done");
      return;
    }
    setShown({ card, reviewId: crypto.randomUUID(), revealed: false, hint: false, typed: "", result: null, picked: null, suggested: null });
    setPhase("card");
    startTimer();
  }, []);
  // The next batch: learning cards due soon first, then reviews and new
  // cards within today's limits. `ahead`: learning cards due later today
  // too ("Früher zeigen").
  const load = useCallback(
    async (ahead = false) => {
      const batch = await backendRef.current.load(ahead);
      if (!batch.configured) {
        closeRef.current();
        return;
      }
      setDeck(batch);
      setQueue(batch.cards.slice(1));
      show(batch.cards[0], !!batch.nextDue);
    },
    [show],
  );
  // Waiting for a learning card: on time (20 minutes ahead, as the queue
  // takes them), the next batch comes by itself.
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase !== "wait" || !deck?.nextDue) return;
    const tick = setInterval(() => setClockNow(Date.now()), 15_000);
    const due = setTimeout(() => void load().catch((e) => setError((e as Error).message)), Math.max(1000, deck.nextDue - 20 * 60_000 - Date.now()));
    return () => {
      clearInterval(tick);
      clearTimeout(due);
    };
  }, [phase, deck?.nextDue, load]);
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
  const compare = deck?.settings?.typedCompare;
  // Revealing checks a typed answer and keeps what it suggests.
  const reveal = useCallback(() => {
    setShown((s) => {
      if (!s || s.revealed) return s;
      if (s.card.typed) {
        const result = compareTyped(s.typed, s.card.typed.answer, compare);
        return { ...s, revealed: true, result, suggested: result.suggested };
      }
      return { ...s, revealed: true };
    });
  }, [compare]);
  const pick = useCallback((index: number) => {
    setShown((s) => {
      if (!s || s.revealed || !s.card.choice || s.picked !== null) return s;
      return { ...s, picked: index, revealed: true, suggested: index === s.card.choice.correct ? 3 : 1 };
    });
  }, []);
  const order = useMemo(() => (shown?.card.choice ? choiceOrder(shown.card.choice.options, shown.reviewId) : []), [shown?.card.choice, shown?.reviewId]);
  // A typed card's field has the focus when the card comes.
  useEffect(() => {
    if (shown && !shown.revealed && shown.card.typed) typedRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.reviewId]);
  useEffect(() => {
    if (!shown?.revealed) return;
    backRef.current?.focus();
    // Image occlusion: the labels of the masks asked, else which area opened.
    const occlusion = shown.card.occlusion;
    const answer = sidePlain(shown.card.back) || (occlusion ? t(`Bereich ${occlusion.index} von ${occlusion.total} aufgedeckt`, `Area ${occlusion.index} of ${occlusion.total} revealed`) : "");
    setAnnounce(t(`Antwort: ${answer}`, `Answer: ${answer}`).slice(0, 400));
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
        const { deck: answer, offline } = await backendRef.current.rate({ card: shown.card, rating, reviewId: shown.reviewId, durationMs });
        if (answer) {
          const next = answer;
          setDeck((d) => (d ? { ...d, ...next, cards: d.cards } : d));
        }
        setHistory((h) => [...h, { reviewId: shown.reviewId, card: shown.card, rating, wasNew: !shown.card.memory, durationMs, offline }].slice(-UNDO_DEPTH));
        setRated((r) => [...r, { key: `${shown.card.rowId}:${shown.card.sub}`, rating, wasNew: !shown.card.memory }]);
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
    [shown, deck, queue, show, load],
  );
  const undo = useCallback(async () => {
    const last = history.at(-1);
    if (!last || busy.current) return;
    busy.current = true;
    try {
      const answer = await backendRef.current.undo(last);
      if (answer.deck) {
        const next = answer.deck;
        setDeck((d) => (d ? { ...d, ...next, cards: d.cards } : d));
      }
      setHistory((h) => h.slice(0, -1));
      setRated((r) => r.slice(0, -1));
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
  }, [history, shown, phase, show, t]);
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
      if (phase === "wait" && (e.key === " " || e.key === "Enter") && !target?.closest?.("button, a")) {
        e.preventDefault();
        void load(true).catch((error) => setError((error as Error).message));
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
        else void rate(shown.suggested ?? 3);
        return;
      }
      // Multiple choice: A–E (or the digits before revealing) pick.
      const letter = CHOICE_KEYS.indexOf(e.key.toUpperCase());
      const choice = shown.card.choice;
      if (choice && !shown.revealed && (letter >= 0 || /^[1-5]$/.test(e.key))) {
        const position = letter >= 0 ? letter : Number(e.key) - 1;
        if (position < order.length) {
          e.preventDefault();
          e.stopPropagation();
          pick(order[position]);
        }
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
  }, [phase, shown, reveal, rate, undo, order, pick, load]);
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
    if (e.button !== 0 || (e.target as HTMLElement).closest("a, button, input, video, audio, .study-choices")) return;
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
      // A choice card is answered by its options; a tap elsewhere reveals.
      if (!shown?.revealed && !(shown?.card.choice && (e.target as HTMLElement).closest(".study-choices"))) reveal();
      return;
    }
    const rating = directionOf(e.clientX - d.x, e.clientY - d.y, el);
    resetCard();
    if (rating && shown?.revealed) void rate(rating);
  };
  const left = deck ? deck.counts.new + deck.counts.learning + deck.counts.review : 0;
  const reviewed = rated.length;
  const labels: Record<StudyRating, string> = { 1: t("Nochmal", "Again"), 2: t("Schwer", "Hard"), 3: t("Gut", "Good"), 4: t("Leicht", "Easy") };
  const minutes = Math.max(1, Math.round((Date.now() - started.current) / 60_000));
  // The counts: one word for each kind wherever the focus mode names them.
  const kinds = { new: t("Neu", "New"), learning: t("In der Lernphase", "Learning"), review: t("Fällig", "Due") };
  const current = phase === "card" && shown ? kindOf(shown.card) : null;
  const countsLabel = deck
    ? t(
        `Noch ${deck.counts.new} neu, ${deck.counts.learning} in der Lernphase, ${deck.counts.review} fällig`,
        `${deck.counts.new} new, ${deck.counts.learning} learning, ${deck.counts.review} due left`,
      )
    : undefined;
  // "1 / 2": the card shown of the session's cards (ratings, as a card in
  // its learning phase comes again); at the end all of them.
  const step = phase === "card" ? position : reviewed;
  const steps = phase === "card" ? Math.max(position, position - 1 + left) : reviewed + left;
  // The summary: cards (each once), new ones, the share known and the
  // ratings by button.
  const cardsSeen = new Set(rated.map((r) => r.key)).size;
  const newSeen = new Set(rated.filter((r) => r.wasNew).map((r) => r.key)).size;
  const known = reviewed ? rated.filter((r) => r.rating >= 3).length / reviewed : 0;
  const spread = ([1, 2, 3, 4] as const).map((r) => ({ rating: r, n: rated.filter((x) => x.rating === r).length }));
  const percent = new Intl.NumberFormat(localeTag(locale), { style: "percent", maximumFractionDigits: 0 });
  const repeats = shown ? backRepeats(shown.card) : false;
  return (
    <div className="study-focus" role="dialog" aria-modal="true" aria-label={t(`Lernen: ${title}`, `Study: ${title}`)} tabIndex={-1} ref={root}>
      <header className="study-focus-bar">
        <button className="icon-button" onClick={() => closeRef.current()} title={t("Sitzung beenden (Esc)", "End session (Esc)")} aria-label={t("Sitzung beenden", "End session")}>
          <X size={20} />
        </button>
        <span className="study-focus-title">{title}</span>
        {deck && (
          // Numbers only on a phone: a tap shows their words (the legend).
          <button
            type="button"
            className={`study-focus-counts${legend ? " legend" : ""}`}
            onClick={() => setLegend((l) => !l)}
            aria-label={countsLabel}
            aria-expanded={legend}
            title={`${kinds.new} · ${kinds.learning} · ${kinds.review}`}
          >
            {(["new", "learning", "review"] as const).map((kind, i) => (
              <span key={kind} className={`study-focus-count ${kind}${current === kind ? " current" : ""}`}>
                {i > 0 && (
                  <span className="study-focus-sep" aria-hidden>
                    ·
                  </span>
                )}
                <b>{deck.counts[kind]}</b>
                <span className="study-focus-word">{kinds[kind]}</span>
              </span>
            ))}
          </button>
        )}
        <button className="icon-button" onClick={() => void undo()} disabled={!history.length} title={t("Letzte Wertung rückgängig (Z)", "Undo last rating (Z)")} aria-label={t("Letzte Wertung rückgängig", "Undo last rating")}>
          <ArrowCounterClockwise size={20} />
        </button>
      </header>
      <div className="study-progress-row">
        <progress className="study-progress" max={Math.max(1, reviewed + left)} value={reviewed} aria-label={t("Fortschritt", "Progress")} />
        {deck && steps > 0 && (
          <span className="study-progress-text" aria-hidden>
            {step} / {steps}
          </span>
        )}
      </div>
      {notice}
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
            className={`study-card${shown.revealed ? " revealed" : ""}${swipe ? ` swipe-${swipe} rating-${swipe}` : ""}`}
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
            {/* The question keeps its place when the answer comes: it sits
                in the card's middle row, the answer in the row below. */}
            <div className="study-question">
              {shown.card.context && (
                <div className="study-context">
                  <Side side={shown.card.context} pageId={pageId} shareToken={shareToken} />
                </div>
              )}
              {/* A cloze card shows its text once: with gaps, then filled; an
                  image occlusion card its picture, the masks asked opened. */}
              {shown.card.occlusion ? (
                <div className="study-side study-front">
                  <OcclusionImage occlusion={shown.card.occlusion} reveal={shown.revealed} />
                </div>
              ) : shown.card.kind === "cloze" && shown.revealed ? (
                <div className="study-side study-front study-back" ref={backRef} tabIndex={-1} aria-label={t("Antwort", "Answer")}>
                  <Side side={shown.card.back} pageId={pageId} shareToken={shareToken} />
                </div>
              ) : (
                <div className="study-side study-front">
                  <Side side={shown.card.front} pageId={pageId} shareToken={shareToken} />
                </div>
              )}
              {shown.card.typed && (
                <div className="study-typed">
                  <input
                    ref={typedRef}
                    className="study-typed-input"
                    value={shown.typed}
                    readOnly={shown.revealed}
                    aria-label={t("Deine Antwort", "Your answer")}
                    placeholder={t("Antwort eintippen …", "Type the answer …")}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    enterKeyHint="done"
                    onChange={(e) => setShown({ ...shown, typed: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!shown.revealed) reveal();
                        else void rate(shown.suggested ?? 3);
                      } else if (e.key === "Escape") {
                        // With text, the first Escape only leaves the field.
                        e.stopPropagation();
                        e.preventDefault();
                        if (shown.typed.trim() && !shown.revealed) root.current?.focus();
                        else closeRef.current();
                      }
                    }}
                  />
                </div>
              )}
              {shown.card.choice && (
                <ChoiceOptions options={shown.card.choice.options} order={order} correct={shown.card.choice.correct} picked={shown.revealed ? (shown.picked ?? -1) : null} onPick={pick} />
              )}
            </div>
            <div className="study-answer-area">
              {shown.card.hint && !shown.revealed && (
                <div className="study-hint">
                  {shown.hint ? (
                    <Side side={shown.card.hint} pageId={pageId} shareToken={shareToken} />
                  ) : (
                    <button className="button compact" onClick={() => setShown({ ...shown, hint: true })}>
                      <Lightbulb aria-hidden /> {t("Hinweis (H)", "Hint (H)")}
                    </button>
                  )}
                </div>
              )}
              {shown.revealed && (
                <div className="study-answer-in">
                  {shown.card.typed && shown.result && <TypedVerdict result={shown.result} typed={shown.typed} />}
                  <div className="study-side study-back" ref={shown.card.kind === "cloze" ? undefined : backRef} tabIndex={-1} aria-label={t("Antwort", "Answer")}>
                    {/* A typed or choice card whose back is just the expected
                        answer: shown once (the comparison, the marked option). */}
                    {shown.card.kind !== "cloze" && !shown.card.occlusion && !repeats && (
                      <>
                        <hr />
                        <Side side={shown.card.back} pageId={pageId} shareToken={shareToken} />
                      </>
                    )}
                    {shown.card.occlusion && "text" in shown.card.back && shown.card.back.text && <p className="study-text occlusion-answer">{shown.card.back.text}</p>}
                    {shown.card.note && (
                      <div className="study-extra">
                        <Side side={shown.card.note} pageId={pageId} shareToken={shareToken} />
                      </div>
                    )}
                    {shown.card.extra && (
                      <div className="study-extra">
                        <Side side={shown.card.extra} pageId={pageId} shareToken={shareToken} />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          {/* While swiping: the rating large in the middle of the screen,
              outside the moving card so it stays in view. */}
          {swipe && (
            <span className={`study-swipe-label rating-${swipe}`} aria-hidden>
              {labels[swipe]}
            </span>
          )}
          <div className="study-answer-bar">
            {!shown.revealed ? (
              <button className="button primary study-reveal" onClick={reveal}>
                {shown.card.typed ? t("Prüfen", "Check") : t("Antwort zeigen", "Show answer")} <kbd>{shown.card.typed ? "↵" : t("Leertaste", "Space")}</kbd>
              </button>
            ) : (
              <>
                {/* Touch screens: which way rates what. */}
                <p className="study-swipe-hint" aria-hidden>
                  {t("← Nochmal · ↑ Leicht · ↓ Schwer · Gut →", "← Again · ↑ Easy · ↓ Hard · Good →")}
                </p>
                <div className="study-ratings" role="group" aria-label={t("Wie gut wusstest du es?", "How well did you know it?")}>
                  {([1, 2, 3, 4] as const).map((r) => {
                    const interval = outcomes ? intervalOfMemory(outcomes[r].memory, Date.now(), clock) : null;
                    return (
                      <button
                        key={r}
                        className={`button study-rate rating-${r}${shown.suggested === r ? " suggested" : ""}`}
                        onClick={() => void rate(r)}
                        aria-label={
                          (interval ? t(`${labels[r]}, nächste Wiederholung ${interval.long}`, `${labels[r]}, next review ${interval.long}`) : labels[r]) +
                          (shown.suggested === r ? t(" (Vorschlag)", " (suggested)") : "")
                        }
                        aria-keyshortcuts={String(r)}
                      >
                        <span className="study-rate-label">
                          <kbd>{r}</kbd> {labels[r]}
                        </span>
                        {interval && (
                          <span className="study-rate-interval" aria-hidden>
                            {interval.short}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </main>
      )}
      {phase === "wait" && deck?.nextDue && (
        <main className="study-focus-main study-summary study-wait" aria-labelledby="study-wait-title">
          <Hourglass size={34} aria-hidden />
          <h2 id="study-wait-title">
            {(() => {
              const minutes = Math.max(1, Math.ceil((deck.nextDue - clockNow) / 60_000));
              const at = new Date(deck.nextDue).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
              const wait = minutesText(minutes, format, t);
              return minutes >= 60 ? t(`Nächste Karte um ${at}`, `Next card at ${at}`) : t(`Nächste Karte in ${wait}`, `Next card in ${wait}`);
            })()}
          </h2>
          <p className="muted">
            {t(
              "Nur noch Karten in der Lernphase sind übrig – sie kommen wieder, sobald ihr Abstand vorbei ist. Du kannst warten oder sie früher zeigen.",
              "Only cards in the learning phase are left – they come back once their interval has passed. You can wait or show them sooner.",
            )}
          </p>
          <div className="study-summary-actions">
            <button className="button" onClick={() => setPhase("done")}>
              {t("Sitzung beenden", "End session")}
            </button>
            <button className="button primary" autoFocus onClick={() => void load(true).catch((e) => setError((e as Error).message))}>
              {t("Früher zeigen", "Show sooner")}
            </button>
          </div>
        </main>
      )}
      {phase === "done" && (
        <main className="study-focus-main study-summary" aria-labelledby="study-summary-title">
          <h2 id="study-summary-title">{deck?.nextDue ? t("Für jetzt geschafft", "Done for now") : t("Geschafft für heute", "Done for today")}</h2>
          {reviewed > 0 && (
            <>
              <ul className="study-summary-tiles">
                <li className="study-summary-tile">
                  <strong>{format(cardsSeen)}</strong>
                  <span>
                    {cardsSeen === 1 ? t("Karte", "card") : t("Karten", "cards")}
                    {newSeen > 0 && t(` · ${newSeen} neu`, ` · ${newSeen} new`)}
                  </span>
                </li>
                <li className="study-summary-tile">
                  <strong>{minutesText(minutes, format, t)}</strong>
                  <span>{t("Lernzeit", "Study time")}</span>
                </li>
                <li className="study-summary-tile">
                  <strong>{percent.format(known)}</strong>
                  <span>{t("gewusst (Gut/Leicht)", "known (Good/Easy)")}</span>
                </li>
                {deck?.streak ? (
                  <li className="study-summary-tile">
                    <strong>
                      <Fire aria-hidden weight="fill" className="study-streak-icon" /> {format(deck.streak)}
                    </strong>
                    <span>{deck.streak === 1 ? t("Lerntag in Folge", "study day in a row") : t("Lerntage in Folge", "study days in a row")}</span>
                  </li>
                ) : null}
              </ul>
              {/* The ratings by button: a bar (drawn, so no style attribute)
                  and the numbers with their words. */}
              <div className="study-summary-spread">
                <svg className="study-spread-bar" viewBox={`0 0 ${reviewed} 1`} preserveAspectRatio="none" aria-hidden>
                  {spread.map((s, i) => {
                    const x = spread.slice(0, i).reduce((sum, p) => sum + p.n, 0);
                    return s.n ? <rect key={s.rating} className={`rating-${s.rating}`} x={x} y={0} width={s.n} height={1} /> : null;
                  })}
                </svg>
                <ul className="study-spread-legend" aria-label={t("Wertungen", "Ratings")}>
                  {spread.map((s) => (
                    <li key={s.rating} className={`rating-${s.rating}`}>
                      <span className="study-spread-dot" aria-hidden />
                      {labels[s.rating]} {format(s.n)}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
          {deck?.nextDue && (
            <p className="muted">
              {t(
                `Die nächste Karte in der Lernphase ist um ${new Date(deck.nextDue).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} dran.`,
                `The next card in the learning phase is up at ${new Date(deck.nextDue).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`,
              )}
            </p>
          )}
          {deck && <p className="muted">{t(`Morgen fällig: ${deck.tomorrow}`, `Due tomorrow: ${deck.tomorrow}`)}</p>}
          <div className="study-summary-actions">
            {backend.more && (
              <button
                className="button"
                onClick={async () => {
                  try {
                    await backendRef.current.more?.();
                    setPhase("loading");
                    await load();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                {t("Heute mehr lernen (+10 neue)", "Study more today (+10 new)")}
              </button>
            )}
            {next ? (
              <>
                <button className="button" onClick={() => closeRef.current()}>
                  {t("Beenden", "Finish")}
                </button>
                <button className="button primary" onClick={next.start} autoFocus>
                  {t(`Weiter mit ${next.title}`, `Continue with ${next.title}`)}
                </button>
              </>
            ) : (
              <button className="button primary" onClick={() => closeRef.current()} autoFocus>
                {t("Zurück zum Stapel", "Back to the deck")}
              </button>
            )}
          </div>
        </main>
      )}
    </div>
  );
}
