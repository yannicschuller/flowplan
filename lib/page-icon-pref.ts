import { z } from "zod";

// "Seitensymbol" (#214, Settings → Appearance & language): where a page's
// icon sits in the page header.
//   above  – the large icon above the title (the default, as before #214)
//   inline – a small icon to the left of the title, on its first line, like
//            a classic document; less space above the text
// Stored per person on the server (users.page_icon, NULL = the default), so
// the choice follows the person to every device. Only how the reader sees
// the page – the page, its title and its icon stay as they are, and
// published pages keep the default for their visitors.
export const PAGE_ICON_PREFS = ["above", "inline"] as const;
export type PageIconPref = (typeof PAGE_ICON_PREFS)[number];
export const DEFAULT_PAGE_ICON_PREF: PageIconPref = "above";
export const pageIconPrefSchema = z.enum(PAGE_ICON_PREFS);

// What a stored value means: anything unknown is the default.
export function pageIconPrefOf(value: unknown): PageIconPref {
  return (PAGE_ICON_PREFS as readonly unknown[]).includes(value) ? (value as PageIconPref) : DEFAULT_PAGE_ICON_PREF;
}
