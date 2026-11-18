"use client";
// "Üben" on a public link (docs/specs/flashcards.md §7.3): the focus mode
// (./focus-core.tsx) without an account. The cards come from the share
// (GET /api/share/<token>?study=1, lib/shared-study.ts, in parts of 2000),
// the learning state stays in this browser (lib/public-study-progress.ts) –
// nothing about the practice goes to the server. Loaded only when a visitor
// starts it (components/public-study.tsx).
import { useMemo, useRef, useState } from "react";
import { Info } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { FocusSession, studyZoneNow, type FocusBackend, type StudyCard, type StudyOverview } from "./focus-core";
import { currentDeck, practiceParams, practiceQueue, progressStore, MAX_DAY_REVIEWS, type ProgressStore } from "@/lib/public-study-progress";
import type { PublicStudyAnswer, PublicStudyCard } from "@/lib/shared-study";

// At most this many parts of 2000 cards are fetched.
const MAX_PARTS = 10;

async function fetchCards(token: string, pageId: string, viewId: string | undefined) {
  const cards: PublicStudyCard[] = [];
  let first: PublicStudyAnswer | null = null;
  let offset: number | null = 0;
  for (let part = 0; part < MAX_PARTS && offset !== null; part++) {
    const query = new URLSearchParams({ study: "1", pageId, offset: String(offset) });
    if (viewId) query.set("viewId", viewId);
    const response = await fetch(`/api/share/${encodeURIComponent(token)}?${query}`, { cache: "no-store", credentials: "same-origin" });
    const body = (await response.json().catch(() => ({}))) as PublicStudyAnswer & { error?: string };
    if (!response.ok) throw new Error(body.error || response.statusText);
    first ??= body;
    cards.push(...body.cards);
    offset = body.next;
  }
  return { ...first!, cards };
}

function localStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export default function PublicPractice({
  token,
  pageId,
  viewId,
  title,
  onClose,
  onCleared,
}: {
  token: string;
  pageId: string;
  viewId?: string;
  title: string;
  onClose: () => void;
  onCleared: () => void;
}) {
  const t = useT();
  const zone = useMemo(studyZoneNow, []);
  const store = useRef<ProgressStore | null>(null);
  store.current ??= progressStore(token, localStore());
  const [noted, setNoted] = useState(() => !!store.current!.read().noted);
  const deck = useRef<Promise<Awaited<ReturnType<typeof fetchCards>>> | null>(null);
  const backend = useMemo<FocusBackend>(() => {
    const cards = () => (deck.current ??= fetchCards(token, pageId, viewId));
    const progressOf = async (now: number) => {
      const { settings } = await cards();
      return currentDeck(store.current!.read().decks[pageId], practiceParams(settings), now, zone);
    };
    const save = (progress: Awaited<ReturnType<typeof progressOf>>) => {
      const all = store.current!.read();
      store.current!.write({ ...all, decks: { ...all.decks, [pageId]: progress } });
    };
    const queue = async (limit: number, ahead = false) => {
      const answer = await cards();
      const now = Date.now();
      const progress = await progressOf(now);
      return practiceQueue({ pageId, title: answer.title, settings: answer.settings, cards: answer.cards, progress }, { now, zone, limit, ahead }) as unknown as Extract<StudyOverview, { configured: true }>;
    };
    return {
      load: async (ahead) => (await queue(50, ahead)) as StudyOverview,
      rate: async ({ card, rating, reviewId, durationMs }) => {
        const now = Date.now();
        const progress = await progressOf(now);
        progress.reviews = [...progress.reviews, { id: reviewId, userId: "", pageId, rowId: card.rowId, sub: card.sub, rating, reviewedAt: now, zone, durationMs, baseReps: card.memory?.reps ?? 0 }].slice(-MAX_DAY_REVIEWS);
        save(progress);
        return { deck: await queue(0) };
      },
      undo: async (last) => {
        const progress = await progressOf(Date.now());
        progress.reviews = progress.reviews.filter((r) => r.id !== last.reviewId);
        save(progress);
        return { deck: await queue(0), card: null as StudyCard | null };
      },
      more: async () => {
        const now = Date.now();
        const progress = await progressOf(now);
        progress.more[progress.day] = (progress.more[progress.day] || 0) + 10;
        save(progress);
      },
    };
  }, [token, pageId, viewId, zone]);
  const clear = () => {
    store.current!.clear();
    onCleared();
    onClose();
  };
  const persistent = store.current.persistent;
  const notice = !noted ? (
    <div className="public-study-note" role="note">
      <Info aria-hidden size={18} />
      <p>
        {persistent
          ? t("Dein Fortschritt bleibt nur in diesem Browser. Flowplan speichert nichts davon.", "Your progress stays in this browser only. Flowplan stores none of it.")
          : t("Dieser Browser speichert keinen Fortschritt – die Übung gilt nur für diese Sitzung. Flowplan speichert nichts davon.", "This browser keeps no progress – the practice lasts for this session only. Flowplan stores none of it.")}
      </p>
      <span className="public-study-note-actions">
        {persistent && (
          <button type="button" className="button compact" onClick={clear}>
            {t("Fortschritt löschen", "Delete progress")}
          </button>
        )}
        <button
          type="button"
          className="button compact primary"
          onClick={() => {
            const all = store.current!.read();
            store.current!.write({ ...all, noted: true });
            setNoted(true);
          }}
        >
          {t("Verstanden", "Got it")}
        </button>
      </span>
    </div>
  ) : null;
  return <FocusSession pageId={pageId} title={title} onClose={onClose} backend={backend} notice={notice} shareToken={token} />;
}
