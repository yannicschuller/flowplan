// Records waiting for a push to GitHub/GitLab (lib/issue-sync.ts). Kept
// apart from the sync engine so that the write paths (lib/automations.ts,
// comments) can note a change without loading it. Changes the sync makes
// itself run "quietly" and are not queued again.
import { one, run } from "./db";

type QueueState = { quiet: number; onQueued?: (pageId: string) => void };
const runtime = globalThis as typeof globalThis & { flowplanIssueQueue?: QueueState };
const state = (runtime.flowplanIssueQueue ??= { quiet: 0 });

export function quietly<T>(fn: () => T): T {
  state.quiet++;
  try {
    return fn();
  } finally {
    state.quiet--;
  }
}

// After a record (or its comments) changed: queue it when its database
// syncs towards GitHub/GitLab. One indexed lookup for all other databases.
export function queueIssuePush(pageId: string, rowId: string) {
  if (state.quiet) return;
  const map = one<{ config: string }>("SELECT config FROM issue_sync_maps WHERE page_id=?", pageId);
  if (!map) return;
  try {
    if ((JSON.parse(map.config) as { direction?: string }).direction === "pull") return;
  } catch {
    return;
  }
  run(
    "INSERT INTO issue_sync_queue(row_id,page_id,at) VALUES(?,?,?) ON CONFLICT(row_id) DO UPDATE SET at=excluded.at",
    rowId,
    pageId,
    Date.now(),
  );
  state.onQueued?.(pageId);
}

// The worker (lib/issue-sync.ts) pushes shortly after a change.
export function onIssueQueued(fn: ((pageId: string) => void) | undefined) {
  state.onQueued = fn;
}
