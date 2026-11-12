import { z } from "zod";

// "Symbol bei externen Links" (#217, Settings → Appearance & language):
// whether links to the web show the small outward arrow after them
// (app/globals.css, "References vs. links"). On by default, as before #217.
// When off, a class on <html> hides the arrow in the editor, comments and
// read mode; the links keep their colour and underline. Stored per person on
// the server (users.external_link_icon: NULL = the default, 0 = off, 1 = on),
// so the choice follows the person to every device. Published pages keep the
// default for their visitors, and the arrow is never printed (print shows
// the address instead).
export const DEFAULT_EXTERNAL_LINK_ICON = true;
export const externalLinkIconSchema = z.boolean();
export const HIDE_EXTERNAL_LINK_ICON_CLASS = "hide-external-link-icon";

// What a stored value means: only an explicit "off" turns the arrow off.
export function externalLinkIconOf(value: unknown): boolean {
  return !(value === false || value === 0 || value === "0");
}
