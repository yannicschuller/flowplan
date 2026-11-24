"use client";
// Signing out on this device (#501): the one step every way out runs before
// the session ends – the account menu and "End demo"
// (components/workspace-app.tsx), "Sign out on this device" in Signed-in
// devices (components/my-sessions.tsx), the two-factor screen
// (components/two-factor.tsx) and deleting the own account
// (components/delete-own-account.tsx). The server answers the sign-out with
// Clear-Site-Data: "cache" as well (lib/sign-out.ts).
//
// Removed: the offline copy – Cache Storage with the app, the workspace and
// its pages, the marker and the periodic sync (disableOffline) – and what
// the tab keeps of the person: recent pages, the Ask-AI conversation and
// the history titles (clearAppCache, lib/tab-storage.ts).
//
// Kept: work the server does not have yet. The offline queue, the uploads
// made offline (components/offline-uploads.ts), today's journal entry and
// the handwriting written offline, flashcard ratings (lib/study-offline.ts),
// notebook recordings (components/notebook/audio-store.ts) and the editors'
// IndexedDB stores hold only – or may hold – changes not sent yet; the app
// has no record of which editor store is fully saved. Removing them would
// lose that work, so they stay as before: each is kept per account, offered
// only to that account and sent once it signs in here again.
import { clearAppCache } from "@/lib/swr-cache";
import { disableOffline } from "./offline";

export async function clearAccountData() {
  await disableOffline().catch(() => undefined);
  clearAppCache();
}
