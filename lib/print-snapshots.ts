import { randomBytes } from "node:crypto";

// Print views for iPhone and iPad apps on the home screen, which cannot print
// themselves: the browser sends the finished view (page copy, styles, images
// as data), and it is shown once more in Safari under a secret address – Safari
// there has no session. Kept in memory for a short time only.
export const PRINT_SNAPSHOT_MAX_BYTES = 40 * 1024 * 1024;
const TTL_MS = 15 * 60 * 1000;
const TOTAL_BYTES = 200 * 1024 * 1024;
const snapshots = new Map<string, { html: string; userId: string; expires: number; bytes: number }>();

function prune(now = Date.now()) {
  let total = 0;
  for (const [token, s] of snapshots) if (s.expires <= now) snapshots.delete(token);
  // Oldest first out when they take too much memory together.
  for (const [token, s] of [...snapshots].reverse()) {
    total += s.bytes;
    if (total > TOTAL_BYTES) snapshots.delete(token);
  }
}

export function storePrintSnapshot(userId: string, html: string) {
  prune();
  // One view per person at a time: a new one replaces the previous one.
  for (const [token, s] of snapshots) if (s.userId === userId) snapshots.delete(token);
  const token = randomBytes(24).toString("base64url");
  snapshots.set(token, { html, userId, expires: Date.now() + TTL_MS, bytes: Buffer.byteLength(html) });
  prune();
  return token;
}

export function printSnapshot(token: string) {
  prune();
  return snapshots.get(token)?.html ?? null;
}
