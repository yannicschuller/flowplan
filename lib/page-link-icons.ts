// Which icon a link to a page or record shows (#96), wherever links are
// drawn: the target's own icon (emoji, uploaded picture, symbol of the icon
// library) or the default of its kind. Pure, shared by the editor, read-only
// documents, comments, previews, search and publications.
import { parsePageLocation, type PageLocation } from "./page-location";

// Icon names of components/ui.tsx PageIcon that stand for "no own icon":
// new pages get their kind's name (lib/seed.ts), databases "file".
const KIND_DEFAULTS: Record<string, string> = {
  document: "file",
  database: "table",
  whiteboard: "whiteboard",
  journal: "journal",
  dashboard: "dashboard",
  notebook: "notebook",
  workflow: "workflow",
  record: "record",
  row: "record",
};
const GENERIC = new Set(["", "file", "table", "whiteboard", "journal", "dashboard", "notebook", "workflow", "record"]);

// The icon to draw for a page or record of `kind` whose stored icon is `icon`.
export function shownPageIcon(icon: string | null | undefined, kind?: string | null): string {
  const own = (icon || "").trim();
  const fallback = KIND_DEFAULTS[kind || "document"] || "file";
  return !own || GENERIC.has(own) ? fallback : own;
}
// Whether the target has an icon of its own (not just its kind's).
export const hasOwnIcon = (icon: string | null | undefined) => !GENERIC.has((icon || "").trim());

export type IconType = "emoji" | "image" | "library" | "named";
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|[0-9#*]️?⃣/u;
export function iconType(name: string): IconType {
  if (name.startsWith("icon:")) return "library";
  if (/^\/api\/(?:files|share\/[\w-]+\/files)\/[\w-]+$/.test(name)) return "image";
  if (name.length <= 64 && EMOJI.test(name)) return "emoji";
  return "named";
}

// The page (and record, block) a link points to: Flowplan's own links
// ("/#page=…", "https://this-host/#page=…") and, on published pages, links
// between the published pages ("/share/<token>/<page>").
export function linkLocation(href: string | null | undefined, origin?: string): PageLocation | null {
  const value = (href || "").trim();
  if (!value) return null;
  const share = /^\/share\/[\w-]+\/([0-9a-f-]{36})(?:[?#].*)?$/i.exec(value);
  if (share) return parsePageLocation(`#page=${share[1]}`);
  const hash = value.indexOf("#page=");
  if (hash < 0) return null;
  const before = value.slice(0, hash);
  // Only this app's links: relative ones or ones to this host.
  if (before && before !== "/") {
    if (!origin) return null;
    try {
      if (new URL(value).origin !== origin) return null;
    } catch {
      return null;
    }
  }
  return parsePageLocation(value.slice(hash));
}
// Key of a target in lib/link-targets.ts.
export const targetKey = (location: Pick<PageLocation, "pageId" | "rowId">) =>
  location.rowId ? `${location.pageId}:${location.rowId}` : location.pageId;
