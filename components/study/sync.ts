"use client";
// Flashcard ratings made offline (components/study/offline.ts): sent once
// the connection is back, wherever the person is in the app. The app shell
// imports this only while ratings wait (lib/study-pending-flag.ts) and the
// device is online, so the queue and FSRS stay out of its first bundle and
// a missing chunk offline never breaks the app.
import { setStudyPendingFlag } from "@/lib/study-pending-flag";
import { pendingReviews } from "@/lib/study-offline";
import { flushStudyReviews } from "./offline";

export async function syncStudyReviews(userId: string) {
  await flushStudyReviews(userId).catch(() => 0);
  // Nothing of this person left: the flag goes until the next
  // rating made offline.
  if (!(await pendingReviews(userId)).length) setStudyPendingFlag(false);
}
