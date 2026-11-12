import { z } from "zod";

// "Neuigkeiten nach Updates" (#223, Settings → Appearance & language): after
// the server was updated, the "Neu in Flowplan" dialog lists what changed
// since the version the person last saw (components/whats-new.tsx).
//   all      – every version with curated notes (the default)
//   breaking – only when one of the skipped versions has breaking changes,
//              and then only those
//   never    – no dialog; "Was ist neu" in the menu still shows the notes
// Stored per person on the server (users.update_notes, NULL = the default);
// administrators choose what new accounts start with (instance setting
// updateNotesDefault, lib/instance-settings.ts).
export const UPDATE_NOTES_LEVELS = ["all", "breaking", "never"] as const;
export type UpdateNotesLevel = (typeof UPDATE_NOTES_LEVELS)[number];
export const DEFAULT_UPDATE_NOTES_LEVEL: UpdateNotesLevel = "all";
export const updateNotesLevelSchema = z.enum(UPDATE_NOTES_LEVELS);

// What a stored value means: anything unknown is the default.
export function updateNotesLevelOf(value: unknown): UpdateNotesLevel {
  return (UPDATE_NOTES_LEVELS as readonly unknown[]).includes(value) ? (value as UpdateNotesLevel) : DEFAULT_UPDATE_NOTES_LEVEL;
}

// The sections of a release's curated notes (release-notes/<version>.json),
// in the order they are shown.
export const RELEASE_NOTE_SECTIONS = ["breaking", "security", "features", "improvements", "fixes"] as const;
export type ReleaseNoteSection = (typeof RELEASE_NOTE_SECTIONS)[number];
// One line of the notes: German and English always, French and Chinese
// optional (English stands in for them), and the issues it closes.
export type ReleaseNoteItem = { de: string; en: string; fr?: string; zh?: string; issues?: number[] };
export type ReleaseNotes = { version: string; date?: string } & Partial<Record<ReleaseNoteSection, ReleaseNoteItem[]>>;

// What the bootstrap carries (lib/user-update-notes.ts): the person's level
// and, once after an update, the versions to show.
export type UpdateNotesBoot = { level: UpdateNotesLevel; pending?: ReleaseNotes[]; changelog?: string };

// The item's text in the reader's language (fr, zh fall back to English).
export function noteText(item: ReleaseNoteItem, locale: string): string {
  const lang = locale.split("-")[0];
  if (lang === "de") return item.de;
  if (lang === "fr" && item.fr) return item.fr;
  if (lang === "zh" && item.zh) return item.zh;
  return item.en;
}
