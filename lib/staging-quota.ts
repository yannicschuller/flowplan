// What each person has staged in unfinished uploads (#493–#495): notebook
// recordings (lib/notebook-audio.ts), meeting pieces (lib/meetings.ts) and
// transcription chunks (lib/transcribe.ts). The bytes wait in lib/staging.ts
// (the data folder, or the bucket in cluster mode); staged_uploads keeps one
// row per staged part with its size and whose it is.
//
// Before a part is written, reserveStaged() checks the limits and records
// the part, in one transaction under a lock per person (lockFor: an
// advisory lock on PostgreSQL, the single writer on SQLite), so parallel
// requests and other instances take turns:
// - at most `maxOpen` unfinished uploads of a kind per person (uploads not
//   added to for `staleAfter` no longer count as open; their bytes do);
// - at most `uploadMax` bytes in one upload;
// - the person's staged bytes of every kind together with this part within
//   `room` (what their storage limit and the workspace quota leave).
// The parts go with the staging: releaseStaged() when an upload is
// finished, discarded or swept, sweepStaged() for rows older than the
// staging's own time to live.
import { HttpError } from "./auth";
import { all, lockFor, one, run, transaction } from "./db";
import type { Identity } from "./types";

export type StagingKind = "notebook-audio" | "meetings" | "transcribe";

export type StagingReservation = {
  kind: StagingKind;
  upload: string;
  part: string;
  // The part's size after this write (a part written again replaces the old size).
  bytes: number;
  maxOpen: number;
  staleAfter: number;
  uploadMax?: number;
  // What this person may still store, null without a limit; asked under the lock.
  room?: () => Promise<number | null>;
  tooLong?: string;
  noRoom?: string;
};

// Records the part, or refuses with 403 (another person's upload), 429 (too
// many open uploads) or 413 (upload too long, no room). Returns whether the
// upload is new (no open part before), for releaseStaged() after a failed write.
export async function reserveStaged(user: Identity, r: StagingReservation): Promise<{ created: boolean }> {
  return await transaction(async () => {
    await lockFor(`staging:${user.id}`);
    const now = Date.now();
    const owner = await one<{ user_id: string }>("SELECT user_id FROM staged_uploads WHERE kind=? AND upload_id=? AND user_id<>? LIMIT 1", r.kind, r.upload, user.id);
    if (owner) throw new HttpError(403, "Keine Berechtigung.");
    const open = await all<{ upload_id: string }>(
      "SELECT upload_id FROM staged_uploads WHERE user_id=? AND kind=? AND active=1 GROUP BY upload_id HAVING MAX(at)>?",
      user.id,
      r.kind,
      now - r.staleAfter,
    );
    const created = !open.some((o) => o.upload_id === r.upload);
    if (created && open.length >= r.maxOpen) throw new HttpError(429, "Zu viele Aufnahmen gleichzeitig. Bitte später erneut versuchen.");
    if (r.uploadMax !== undefined) {
      const upload = await one<{ n: number | null }>("SELECT SUM(bytes) n FROM staged_uploads WHERE kind=? AND upload_id=? AND part<>?", r.kind, r.upload, r.part);
      if (Number(upload?.n || 0) + r.bytes > r.uploadMax) throw new HttpError(413, r.tooLong || "Die Aufnahme ist zu lang.");
    }
    if (r.room) {
      const room = await r.room();
      if (room !== null) {
        const mine = await one<{ n: number | null }>(
          "SELECT SUM(bytes) n FROM staged_uploads WHERE user_id=? AND NOT (kind=? AND upload_id=? AND part=?)",
          user.id,
          r.kind,
          r.upload,
          r.part,
        );
        if (Number(mine?.n || 0) + r.bytes > room) throw new HttpError(413, r.noRoom || "Der Speicher reicht für diese Aufnahme nicht.");
      }
    }
    await run(
      "INSERT INTO staged_uploads(kind,upload_id,part,user_id,bytes,active,at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(kind,upload_id,part) DO UPDATE SET bytes=excluded.bytes,active=1,at=excluded.at",
      r.kind,
      r.upload,
      r.part,
      user.id,
      r.bytes,
      now,
    );
    return { created };
  }, user);
}

// Prefixes are digits and "/" (a meeting session: "<n>/"), no wildcards.
const likePrefix = (prefix: string) => {
  if (!/^[0-9/]+$/.test(prefix)) throw new Error("Invalid staging prefix");
  return `${prefix}%`;
};
// The parts of an upload are gone (finished, discarded, swept); with
// `partPrefix` only those below it (one session of a meeting).
export async function releaseStaged(kind: StagingKind, upload: string, partPrefix?: string) {
  if (partPrefix === undefined) await run("DELETE FROM staged_uploads WHERE kind=? AND upload_id=?", kind, upload);
  else await run("DELETE FROM staged_uploads WHERE kind=? AND upload_id=? AND part LIKE ?", kind, upload, likePrefix(partPrefix));
}
// The upload is complete and waits to be processed: it no longer counts as
// open, its bytes still do.
export async function closeStaged(kind: StagingKind, upload: string, partPrefix: string) {
  await run("UPDATE staged_uploads SET active=0 WHERE kind=? AND upload_id=? AND part LIKE ?", kind, upload, likePrefix(partPrefix));
}
// Rows of uploads nobody added to within the staging's time to live (the
// sweep removed the bytes, or will).
export async function sweepStaged(kind: StagingKind, olderThan: number) {
  await run("DELETE FROM staged_uploads WHERE kind=? AND at<?", kind, olderThan);
}
