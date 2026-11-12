// The curated release notes (#223): one file per version in release-notes/
// (release-notes/0.9.4.json), written before a release and read by the
// release workflow (scripts/release-notes.mjs: GitHub release and
// CHANGELOG.md) and by the server for the "Neu in Flowplan" dialog. The
// files are part of the build (next.config.ts traces them into the image), so
// the server never asks the internet what changed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { compareVersions } from "./update-check";
import { RELEASE_NOTE_SECTIONS, type ReleaseNoteItem, type ReleaseNotes, type UpdateNotesLevel } from "./update-notes-pref";

// "0.9.4", "1.0.0-beta.1" – what a file name may be.
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const isVersion = (value: unknown): value is string => typeof value === "string" && VERSION_PATTERN.test(value);
const isPreRelease = (version: string) => version.includes("-");

// One short line for people using Flowplan: no Markdown, no line breaks.
const text = z
  .string()
  .trim()
  .min(3)
  .max(300)
  .refine((s) => !/[\r\n]/.test(s), "one line");
export const releaseNoteItemSchema = z
  .object({
    de: text,
    en: text,
    fr: text.optional(),
    zh: text.optional(),
    issues: z.array(z.number().int().positive()).max(10).optional(),
  })
  .strict();
const section = z.array(releaseNoteItemSchema).max(60).optional();
export const releaseNotesFileSchema = z
  .object({
    // For editors that read it; not used otherwise.
    $schema: z.string().optional(),
    // The release day, filled in afterwards for older releases.
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    breaking: section,
    security: section,
    features: section,
    improvements: section,
    fixes: section,
  })
  .strict()
  .refine((notes) => RELEASE_NOTE_SECTIONS.some((s) => (notes[s]?.length ?? 0) > 0), "at least one item");

export const RELEASE_NOTES_DIR = join(process.cwd(), "release-notes");

// Every valid file of the folder, newest first. A broken file is left out
// (and reported once) rather than taking the dialog down; the tests check
// every file of the repository.
const cache = new Map<string, ReleaseNotes[]>();
export function loadReleaseNotes(dir = RELEASE_NOTES_DIR): ReleaseNotes[] {
  const known = cache.get(dir);
  if (known) return known;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {}
  const list: ReleaseNotes[] = [];
  for (const name of names) {
    const version = name.slice(0, -".json".length);
    if (!isVersion(version)) continue;
    try {
      const parsed = releaseNotesFileSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      const notes: ReleaseNotes = { version, ...(parsed.date ? { date: parsed.date } : {}) };
      for (const s of RELEASE_NOTE_SECTIONS) if (parsed[s]?.length) notes[s] = parsed[s] as ReleaseNoteItem[];
      list.push(notes);
    } catch (e) {
      console.warn(`release-notes/${name} is not valid and is left out: ${(e as Error).message}`);
    }
  }
  list.sort((a, b) => compareVersions(b.version, a.version));
  // The image's files never change; while developing, edits show at once.
  if (process.env.NODE_ENV === "production") cache.set(dir, list);
  return list;
}

// The versions up to the running one, newest first, after `seen` (null: from
// the start). A release build leaves out notes of pre-releases (its own notes
// cover them); a pre-release build shows the pre-releases up to itself.
// Notes of versions later than the running one – the next release, written
// ahead – never show.
export function notesBetween(all: ReleaseNotes[], seen: string | null, current: string): ReleaseNotes[] {
  if (!isVersion(current)) return [];
  const pre = isPreRelease(current);
  return all.filter(
    (n) =>
      compareVersions(n.version, current) <= 0 &&
      (!seen || !isVersion(seen) || compareVersions(n.version, seen) > 0) &&
      (pre || !isPreRelease(n.version)),
  );
}

// What a level lets through: everything, only the breaking changes (and only
// versions that have some), or nothing.
export function notesForLevel(list: ReleaseNotes[], level: UpdateNotesLevel): ReleaseNotes[] {
  if (level === "never") return [];
  if (level === "all") return list;
  return list.filter((n) => n.breaking?.length).map((n) => ({ version: n.version, ...(n.date ? { date: n.date } : {}), breaking: n.breaking }));
}

// The full changelog on GitHub (the dialog's link).
export const CHANGELOG_URL = "https://github.com/yannicschuller/flowplan/blob/main/CHANGELOG.md";
