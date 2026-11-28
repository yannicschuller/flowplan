// What this browser tab keeps of the signed-in person in sessionStorage
// besides the page cache (lib/swr-cache.ts): the Ask-AI conversation per
// workspace (components/ai-ask.tsx), the titles of the back and forward
// steps and the places visited in this tab (lib/history-nav.ts, #647). clearAppCache removes all of it, so nothing of
// the last person stays in the tab after signing out.
export const ASK_STORAGE_PREFIX = "flowplan-ask:";
export const HISTORY_TITLES_KEY = "flowplan-history-titles";
export const RECENT_PLACES_KEY = "flowplan-recent-places";
export const SWR_STORAGE_PREFIX = "flowplan:swr:";

export const isAccountTabKey = (key: string) =>
  key.startsWith(SWR_STORAGE_PREFIX) || key.startsWith(ASK_STORAGE_PREFIX) || key === HISTORY_TITLES_KEY || key === RECENT_PLACES_KEY;
