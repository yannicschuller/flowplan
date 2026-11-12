// "Neuigkeiten nach Updates" per person (#223, lib/update-notes-pref.ts):
//   users.update_notes  the level (NULL: never chosen, "all")
//   users.seen_version  the last version whose notes the person saw (NULL:
//                       not tracked yet)
// The bootstrap hands out the versions between the two once after an update;
// closing the dialog marks the running version as seen (profile.updateNotes).
import { z } from "zod";
import { HttpError } from "./auth";
import { buildInfo } from "./build-info";
import { one, run } from "./db";
import { instanceSettings } from "./instance-settings";
import { CHANGELOG_URL, isVersion, loadReleaseNotes, notesBetween, notesForLevel } from "./release-notes";
import { compareVersions } from "./update-check";
import { updateNotesLevelOf, updateNotesLevelSchema, type ReleaseNotes, type UpdateNotesBoot } from "./update-notes-pref";
import type { Identity } from "./types";

type Row = { seen_version: string | null; update_notes: string | null; onboarded_at: number | null; last_open_at: number | null };
type Options = { current?: string; notes?: ReleaseNotes[] };

// For the bootstrap. Side effects only where nothing is to be shown, so the
// next update compares with the right version:
// - A new account (no introduction finished or the app never open) starts at
//   the running version with the administration's default level: no backlog.
// - Accounts from before #223 (seen_version NULL, but used before) see the
//   running version's notes once.
// - Nothing to show (level, or no notes for the skipped versions): the
//   running version counts as seen.
// API tokens and demo accounts only read.
export async function userUpdateNotes(user: Identity, options: Options = {}): Promise<UpdateNotesBoot> {
  const current = options.current ?? buildInfo().version;
  const row = await one<Row>("SELECT seen_version,update_notes,onboarded_at,last_open_at FROM users WHERE id=?", user.id);
  let level = updateNotesLevelOf(row?.update_notes);
  if (!row || !isVersion(current) || user.apiScope || user.demo) return { level };
  const all = options.notes ?? loadReleaseNotes();
  let skipped: ReleaseNotes[];
  if (row.seen_version === null) {
    if (row.onboarded_at === null || row.last_open_at === null) {
      if (row.update_notes === null) level = (await instanceSettings()).updateNotesDefault;
      await run("UPDATE users SET seen_version=?,update_notes=COALESCE(update_notes,?) WHERE id=? AND seen_version IS NULL", current, level, user.id);
      return { level };
    }
    skipped = notesBetween(all, null, current).slice(0, 1);
  } else skipped = notesBetween(all, row.seen_version, current);
  const pending = notesForLevel(skipped, level);
  if (pending.length) return { level, pending, changelog: CHANGELOG_URL };
  if (row.seen_version === null || compareVersions(current, row.seen_version) > 0) await markSeen(user.id, current);
  return { level };
}

// Only ever forward: after a downgrade the newer version stays seen.
async function markSeen(userId: string, current: string) {
  const row = await one<{ seen_version: string | null }>("SELECT seen_version FROM users WHERE id=?", userId);
  if (row && (row.seen_version === null || !isVersion(row.seen_version) || compareVersions(current, row.seen_version) > 0))
    await run("UPDATE users SET seen_version=? WHERE id=?", current, userId);
}

const commandSchema = z
  .object({ level: updateNotesLevelSchema.optional(), seen: z.literal(true).optional() })
  .refine((b) => b.level !== undefined || b.seen !== undefined, "level or seen");

// profile.updateNotes: the level, and/or "seen" – the dialog was closed.
export async function setUserUpdateNotes(user: Identity, input: unknown, options: Options = {}) {
  const b = commandSchema.parse(input);
  if (b.level) await run("UPDATE users SET update_notes=? WHERE id=?", b.level, user.id);
  const current = options.current ?? buildInfo().version;
  if (b.seen && isVersion(current)) await markSeen(user.id, current);
  const row = await one<{ seen_version: string | null; update_notes: string | null }>("SELECT seen_version,update_notes FROM users WHERE id=?", user.id);
  if (!row) throw new HttpError(404, "Benutzer nicht gefunden.");
  return { level: updateNotesLevelOf(row.update_notes), seenVersion: row.seen_version };
}

// releaseNotes.list ("Was ist neu", any time, whatever the level): the
// latest versions up to the running one.
export function recentReleaseNotes(input: unknown, options: Options = {}) {
  const { limit } = z.object({ limit: z.number().int().min(1).max(20).optional() }).parse(input ?? {});
  const current = options.current ?? buildInfo().version;
  const all = options.notes ?? loadReleaseNotes();
  // A build without a release version (development): the newest files.
  const versions = isVersion(current) ? notesBetween(all, null, current) : all;
  return { current: current || null, versions: versions.slice(0, limit ?? 5), changelog: CHANGELOG_URL };
}
