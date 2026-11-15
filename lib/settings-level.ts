import { z } from "zod";
import type { OnboardingGoal } from "./getting-started-items";
import type { SectionMeta, SettingsEntry } from "./settings-sections";

// Settings levels per person (#294, like PrusaSlicer's modes): Einsteiger /
// Normal / Experte. Every personal setting carries a level
// (lib/settings-sections.ts); a person sees the settings up to their own
// level, the search still finds everything. Administration settings are not
// levelled.
//   users.settings_level  the person's level, NULL: none of their own – the
//                         instance's default (settingsLevelDefault,
//                         Administration → Instanz; "Instanz-Standard" in
//                         Administration → Benutzer)
// Accounts from before #294 got "expert" once (lib/data-steps.ts), so
// nothing they knew disappears; new accounts follow the default ("normal").
export const SETTINGS_LEVELS = ["beginner", "normal", "expert"] as const;
export type SettingsLevel = (typeof SETTINGS_LEVELS)[number];
export const DEFAULT_SETTINGS_LEVEL: SettingsLevel = "normal";
// What a section without a level of its own has.
export const BASE_SETTINGS_LEVEL: SettingsLevel = "beginner";
export const settingsLevelSchema = z.enum(SETTINGS_LEVELS);

export const isSettingsLevel = (value: unknown): value is SettingsLevel => (SETTINGS_LEVELS as readonly unknown[]).includes(value);
// What a stored value means: anything unknown is the default.
export const settingsLevelOf = (value: unknown): SettingsLevel => (isSettingsLevel(value) ? value : DEFAULT_SETTINGS_LEVEL);
export const levelRank = (level: SettingsLevel) => SETTINGS_LEVELS.indexOf(level);
// An item of `item`'s level is shown at the person's level `level`.
export const withinLevel = (item: SettingsLevel, level: SettingsLevel) => levelRank(item) <= levelRank(level);
export const higherLevel = (a: SettingsLevel, b: SettingsLevel) => (levelRank(a) >= levelRank(b) ? a : b);

// Inheritance: a section without a level is "beginner", an entry without
// one has its section's level.
export const sectionLevel = (section: Pick<SectionMeta, "level">): SettingsLevel => section.level ?? BASE_SETTINGS_LEVEL;
export const entryLevel = (section: Pick<SectionMeta, "level">, entry: Pick<SettingsEntry, "level">): SettingsLevel => entry.level ?? sectionLevel(section);

// The lowest level at which the section has something: with entries the
// lowest of theirs, else its own. Above the person's level the section is
// left out of the overview and the side navigation (the search finds it).
export function sectionMinLevel(section: Pick<SectionMeta, "level" | "entries">): SettingsLevel {
  const levels = section.entries?.length ? section.entries.map((e) => entryLevel(section, e)) : [sectionLevel(section)];
  return SETTINGS_LEVELS.find((l) => levels.includes(l)) ?? sectionLevel(section);
}
export const sectionVisible = (section: Pick<SectionMeta, "level" | "entries" | "area">, level: SettingsLevel) =>
  section.area === "admin" || withinLevel(sectionMinLevel(section), level);

// The level of what `anchor` points to in the section: the entry with that
// anchor (several share one: the lowest), else null.
export function anchorLevel(section: Pick<SectionMeta, "level" | "entries">, anchor: string | null | undefined): SettingsLevel | null {
  if (!anchor) return null;
  const levels = (section.entries || []).filter((e) => e.anchor === anchor).map((e) => entryLevel(section, e));
  return levels.length ? SETTINGS_LEVELS.find((l) => levels.includes(l))! : null;
}

// How many entries of the section a person at `level` does not see.
export const hiddenEntries = (section: Pick<SectionMeta, "level" | "entries">, level: SettingsLevel) =>
  (section.entries || []).filter((e) => !withinLevel(entryLevel(section, e), level)).length;

// The level that suits what someone told the introduction they use
// Flowplan for (onboarding's goal question, lib/getting-started-items.ts):
// for themselves – Einsteiger; with a team, for projects, studying or
// writing – Normal. Expert is always one's own choice.
export function suggestedLevel(role: OnboardingGoal | "writing" | string | null | undefined): SettingsLevel {
  switch (role) {
    case "personal":
      return "beginner";
    case "team":
    case "projects":
    case "study":
    case "writing":
      return "normal";
    default:
      return DEFAULT_SETTINGS_LEVEL;
  }
}

// What the bootstrap carries: the level that applies and whether it is the
// person's own (false: the instance's default).
export type SettingsLevelBoot = { level: SettingsLevel; own: boolean };
