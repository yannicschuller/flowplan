"use client";
// Loading and rating flashcards with and without a connection
// (docs/specs/flashcards.md §10.4; the queue and its storage:
// lib/study-offline.ts).
//
// - studyLoad: the deck from the server; offline (or when the request
//   finds no server) built on the device from the offline copy
//   (GET /api/pages/{id}/study?offline=1 in the data cache) with the
//   ratings still waiting applied – the answer carries `offline: true`.
//   Waiting ratings of the deck are sent first when online, so the server's
//   answer already counts them.
// - studyRateOffline: a rating kept on the device (IndexedDB) for later.
// - flushStudyReviews: sends the waiting ratings (study.reviews, 500 at a
//   time); every answer but a missing connection or a busy server removes
//   them (ok, replayed, duplicate, orphaned – all final).
// - useStudyPending: the count for "N Wertungen warten auf Verbindung",
//   and the sending once the connection is back (every 30 s while some
//   wait, and on "online").
import { useEffect, useState } from "react";
import { api, deviceOffline, isTransient } from "../ui";
import { DATA_CACHE, offlineStore } from "@/lib/offline-store";
import { studyUrl } from "@/lib/offline-plan";
import { nativeApp } from "@/lib/native-app";
import { IDEMPOTENCY_HEADER, newIdempotencyKey } from "@/lib/idempotency-key";
import {
  STUDY_PENDING,
  dropReviews,
  isOfflineDeck,
  localQueue,
  pendingReviews,
  queueReview,
  reviewBatches,
  type OfflineDeck,
  type PendingReview,
} from "@/lib/study-offline";

// The stored deck of the offline copy, if there is one.
async function storedDeck(pageId: string): Promise<OfflineDeck | null> {
  try {
    const store = offlineStore();
    if (!store) return null;
    const answer = await (await store.open(DATA_CACHE)).match(studyUrl(pageId));
    const value = answer ? await answer.json() : null;
    return isOfflineDeck(value) ? value : null;
  } catch {
    return null;
  }
}
// After studying online: the stored deck follows (only where the copy
// keeps it already), so the device does not show cards again offline that
// were studied since its last refresh.
export async function refreshStoredDeck(pageId: string) {
  try {
    const store = offlineStore();
    if (!store || deviceOffline()) return;
    const cache = await store.open(DATA_CACHE);
    const key = studyUrl(pageId);
    if (!(await cache.match(key))) return;
    const response = await fetch(key, { cache: "no-store", credentials: "same-origin", headers: { "X-Flowplan-Offline": "1" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !(response.headers.get("content-type") || "").includes("application/json")) return;
    const text = await response.text();
    if (isOfflineDeck(JSON.parse(text))) await cache.put(key, new Response(text, { status: 200, headers: response.headers }));
  } catch {}
}

export class NotOffline extends Error {}
type Load = { viewId?: string; limit: number; ahead?: boolean; zone: string; userId?: string };
// The deck like GET /api/pages/{id}/study, from the server or the device.
export async function studyLoad<T>(pageId: string, options: Load): Promise<T> {
  const local = async () => {
    const deck = await storedDeck(pageId);
    if (!deck) throw new NotOffline();
    const pending = await pendingReviews(deck.userId, pageId);
    return localQueue(deck, pending, { now: Date.now(), zone: options.zone, viewId: options.viewId, limit: options.limit, ahead: options.ahead }) as T;
  };
  if (deviceOffline()) return await local();
  if (options.userId && (await pendingReviews(options.userId, pageId)).length) await flushStudyReviews(options.userId).catch(() => undefined);
  const query = new URLSearchParams({ zone: options.zone, limit: String(options.limit) });
  if (options.viewId) query.set("view", options.viewId);
  if (options.ahead) query.set("ahead", "1");
  try {
    return await api<T>(`/api/pages/${pageId}/study?${query}`);
  } catch (error) {
    if (!isTransient(error)) throw error;
    return await local();
  }
}

export async function studyRateOffline(review: PendingReview) {
  await queueReview(review);
}

let flushing: Promise<number> | null = null;
// Sends the waiting ratings; returns how many the server took.
export function flushStudyReviews(userId: string): Promise<number> {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    try {
      if (deviceOffline()) return 0;
      for (const batch of reviewBatches(await pendingReviews(userId), userId)) {
        // A request of its own (not api()): it never waits for a sign-in
        // and gives up after 30 seconds, so a later attempt is not blocked.
        let response: Response;
        try {
          response = await fetch("/api/command", {
            method: "POST",
            headers: { "Content-Type": "application/json", [IDEMPOTENCY_HEADER]: newIdempotencyKey() },
            body: JSON.stringify({ action: "study.reviews", source: nativeApp() ? "app" : "web", reviews: batch.map(({ userId: _user, ...r }) => r) }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch {
          break;
        }
        const answer = (await response.json().catch(() => null)) as { results?: { id: string }[] } | null;
        // No connection, a busy server, signed out: the ratings wait. Only a
        // refusal of the batch itself (400: it does not fit the schema)
        // would never change – those go.
        if (!response.ok || !answer) {
          if (response.status === 400 && answer) await dropReviews(batch.map((r) => r.id));
          break;
        }
        await dropReviews((answer.results || []).map((r) => r.id));
        sent += answer.results?.length || 0;
        for (const pageId of new Set(batch.map((r) => r.pageId))) await refreshStoredDeck(pageId);
      }
    } finally {
      flushing = null;
    }
    return sent;
  })();
  return flushing;
}

// The waiting ratings of the person (of one deck, or all), kept current;
// `sync`: also send them once the connection is back.
export function useStudyPending(userId: string | undefined, pageId?: string, sync = false) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    const update = async () => {
      const list = await pendingReviews(userId, pageId);
      if (live) setCount(list.length);
      return list.length;
    };
    const send = async () => {
      if ((await update()) && sync) {
        await flushStudyReviews(userId).catch(() => undefined);
        await update();
      }
    };
    void send();
    const changed = () => void update();
    const online = () => void send();
    window.addEventListener(STUDY_PENDING, changed);
    window.addEventListener("online", online);
    const timer = sync ? setInterval(() => void send(), 30_000) : null;
    return () => {
      live = false;
      window.removeEventListener(STUDY_PENDING, changed);
      window.removeEventListener("online", online);
      if (timer) clearInterval(timer);
    };
  }, [userId, pageId, sync]);
  return count;
}
