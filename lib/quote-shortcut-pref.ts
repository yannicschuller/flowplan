import { z } from "zod";

// "`>` erzeugt" (#230, Settings → Appearance & language → Editor): what
// typing "> " at the start of an empty line creates – a toggle (the
// default) or a quote, as in Markdown. Only that typing shortcut: pasted
// and imported Markdown "> text" stays a quote, '" ' always makes a quote.
// Stored per person on the server (users.quote_shortcut: NULL = the
// default), so the choice follows the person to every device.
export const QUOTE_SHORTCUTS = ["toggle", "quote"] as const;
export type QuoteShortcutPref = (typeof QUOTE_SHORTCUTS)[number];
export const DEFAULT_QUOTE_SHORTCUT: QuoteShortcutPref = "toggle";
export const quoteShortcutSchema = z.enum(QUOTE_SHORTCUTS);

export function quoteShortcutOf(value: unknown): QuoteShortcutPref {
  return value === "quote" ? "quote" : DEFAULT_QUOTE_SHORTCUT;
}
