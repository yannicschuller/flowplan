import { z } from "zod";
import { DEFAULT_PAGE_ICON_PREF, pageIconPrefOf, pageIconPrefSchema, type PageIconPref } from "./page-icon-pref";
import { personalFontOf, personalFontSchema, type PersonalFont } from "./personal-font";
import { DEFAULT_STRIKE_DONE_TASKS, DONE_TASKS_PLAIN_CLASS, strikeDoneTasksOf, strikeDoneTasksSchema } from "./done-strike-pref";

// How a shared or published page looks to its visitors (#526): "What I see
// is what others get". The personal settings that change how a page's
// content looks – where the page icon sits (#214, lib/page-icon-pref.ts),
// the font (#512, lib/personal-font.ts) and whether done tasks are struck
// through (#458, lib/done-strike-pref.ts) – follow the person who shares or
// publishes, not the visitor. They are taken from that person's settings
// when the publication or link is made and stored with it
// (publications.appearance, share_links.appearance, record_shares.appearance:
// JSON, NULL for those made before #526, which use their creator's current
// settings). A publication's can be changed in the share dialog's Web tab
// without touching the person's own settings. Purely personal interface
// settings (light/dark, sidebar, toolbar, language, …) stay with the
// visitor, and so does the arrow after links (#217), which publications
// keep in a column of its own (publications.external_link_icon).
// Pure: no React, no DOM, no database.
export type PublicAppearance = {
  pageIcon: PageIconPref;
  font: PersonalFont;
  strikeDoneTasks: boolean;
};
export const DEFAULT_PUBLIC_APPEARANCE: PublicAppearance = {
  pageIcon: DEFAULT_PAGE_ICON_PREF,
  font: null,
  strikeDoneTasks: DEFAULT_STRIKE_DONE_TASKS,
};
// A change from the share dialog: only the fields given.
export const publicAppearanceSchema = z
  .object({
    pageIcon: pageIconPrefSchema.optional(),
    font: personalFontSchema.optional(),
    strikeDoneTasks: strikeDoneTasksSchema.optional(),
  })
  .strict();
export type PublicAppearanceChange = z.infer<typeof publicAppearanceSchema>;
export const PUBLIC_ICON_INLINE_CLASS = "public-icon-inline";

// What a stored value means: each known field as stored, anything missing
// or unknown from `fallback` (the creator's settings, or the default).
export function publicAppearanceOf(stored: unknown, fallback: PublicAppearance = DEFAULT_PUBLIC_APPEARANCE): PublicAppearance {
  let value: unknown = stored;
  if (typeof stored === "string") {
    try {
      value = JSON.parse(stored);
    } catch {
      value = null;
    }
  }
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    pageIcon: "pageIcon" in v ? pageIconPrefOf(v.pageIcon) : fallback.pageIcon,
    font: "font" in v ? personalFontOf(v.font) : fallback.font,
    strikeDoneTasks: "strikeDoneTasks" in v ? strikeDoneTasksOf(v.strikeDoneTasks) : fallback.strikeDoneTasks,
  };
}
// As stored: every field, so a later change of the creator's own settings
// leaves it alone.
export function publicAppearanceJson(appearance: PublicAppearance): string {
  const a = publicAppearanceOf(appearance);
  return JSON.stringify({ pageIcon: a.pageIcon, font: a.font, strikeDoneTasks: a.strikeDoneTasks });
}
// The classes on the public page's root (components/public-page.tsx,
// components/public-record.tsx; app/page-icon-inline.css, app/globals.css).
// The font is a style element (components/personal-font-style.tsx).
export function publicAppearanceClasses(appearance: PublicAppearance): string[] {
  return [appearance.pageIcon === "inline" && PUBLIC_ICON_INLINE_CLASS, !appearance.strikeDoneTasks && DONE_TASKS_PLAIN_CLASS].filter(
    (c): c is string => !!c,
  );
}
