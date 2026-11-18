"use client";
// The focus mode of a study session in the app (docs/specs/flashcards.md
// §6): the session of ./focus-core.tsx with the server and the device's
// offline copy as its backend.
//
// - The cards come from the server (GET /api/pages/{id}/study); offline (or
//   with the server out of reach) the device builds the batch from its copy
//   of the deck (components/study/offline.ts).
// - A rating goes to the server (study.review); offline it waits on the
//   device and the counts come from its copy.
// - Undo asks the server (study.undo), which replays the card's log; a
//   rating still waiting on the device is simply taken back there.
// - The answer time is only kept in the person's own log.
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { api, isTransient } from "../ui";
import { NotOffline, refreshStoredDeck, studyLoad, studyRateOffline, useStudyPending } from "./offline";
import { dropReviews, pendingReviews } from "@/lib/study-offline";
import { StudyPendingNote } from "./pending";
import type { Memory } from "@/lib/fsrs";
import { FocusSession, studyZoneNow, type FocusBackend, type Ready, type StudyCard, type StudyOverview } from "./focus-core";

export { studyZoneNow } from "./focus-core";
export type { StudyCard, StudyModel, StudyFit, StudyOverview, StudySide } from "./focus-core";

export function StudyFocus({
  pageId,
  viewId,
  title,
  onClose,
  next,
}: {
  pageId: string;
  viewId?: string;
  title: string;
  onClose: () => void;
  next?: { title: string; start: () => void };
}) {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const zone = useMemo(studyZoneNow, []);
  // The person (from the first answer), for the ratings kept offline.
  const userRef = useRef<string | undefined>(undefined),
    offlineRef = useRef(false);
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const notOffline = () => new Error(tRef.current("Dieser Stapel ist auf diesem Gerät nicht offline verfügbar.", "This deck is not available offline on this device."));
  const backend = useMemo<FocusBackend>(() => {
    const view = viewId ? { viewId } : {};
    const local = async () => {
      const deck = await studyLoad<StudyOverview>(pageId, { ...view, limit: 0, zone, userId: userRef.current }).catch(() => null);
      return deck?.configured ? deck : null;
    };
    return {
      load: async (ahead) => {
        let batch: StudyOverview;
        try {
          batch = await studyLoad<StudyOverview>(pageId, { ...view, limit: 50, ahead, zone, userId: userRef.current });
        } catch (e) {
          if (e instanceof NotOffline) throw notOffline();
          throw e;
        }
        userRef.current = batch.userId ?? userRef.current;
        if (batch.userId) setUserId(batch.userId);
        offlineRef.current = !!batch.offline;
        return batch;
      },
      rate: async ({ card, rating, reviewId, durationMs }) => {
        // Offline (or the server out of reach): the rating waits on the
        // device and the counts come from its copy of the deck.
        const keep = async () => {
          const userId = userRef.current;
          if (!userId) throw notOffline();
          await studyRateOffline({ id: reviewId, userId, pageId, rowId: card.rowId, sub: card.sub, rating, reviewedAt: Date.now(), zone, durationMs, baseReps: card.memory?.reps ?? 0 });
          return { deck: await local(), offline: true };
        };
        if (offlineRef.current) return await keep();
        try {
          const deck = await api<Ready & { review: { memory: Memory } }>("/api/command", { action: "study.review", id: reviewId, pageId, rowId: card.rowId, sub: card.sub, rating, zone, durationMs, ...view });
          return { deck };
        } catch (e) {
          if (!isTransient(e)) throw e;
          return await keep();
        }
      },
      undo: async (last) => {
        const userId = userRef.current;
        const waiting = last.offline && userId && (await pendingReviews(userId, pageId)).some((r) => r.id === last.reviewId);
        if (waiting) {
          await dropReviews([last.reviewId]);
          return { deck: offlineRef.current ? await local() : null, card: null };
        }
        const answer = await api<Ready & { card: StudyCard | null }>("/api/command", { action: "study.undo", pageId, reviewId: last.reviewId, zone, ...view });
        return { deck: answer, card: answer.card };
      },
      more: async () => {
        await api("/api/command", { action: "study.prefs", pageId, zone, more: { new: 10 } });
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, viewId, zone]);
  const pending = useStudyPending(userId, pageId);
  // Studied online: the device's copy of the deck follows when it ends.
  useEffect(() => () => void refreshStoredDeck(pageId), [pageId]);
  return (
    <FocusSession
      pageId={pageId}
      title={title}
      onClose={onClose}
      next={next}
      backend={backend}
      notice={pending > 0 ? <StudyPendingNote count={pending} className="study-focus-pending" /> : null}
    />
  );
}
