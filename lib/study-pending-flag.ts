// Whether this device keeps flashcard ratings that wait for a connection
// (lib/study-offline.ts). A small flag of its own, so the app loads the
// sending (components/study/sync.tsx) only when there is something to send.
export const STUDY_PENDING = "flowplan:study-pending";
const KEY = "flowplan-study-pending";

export function studyPendingFlag(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setStudyPendingFlag(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {}
}
