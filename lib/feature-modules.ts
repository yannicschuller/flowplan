import type { PageKind, View } from "./types";
import type { HomeWidgetKind } from "./home-layout-schema";

// Features a person can switch off for a calmer interface (#378, Settings →
// Darstellung & Sprache → Funktionen). Off only takes away the ways to
// *make* something of that kind – the tile in "Neue Seite", the entries of
// the "/" menu and the formatting toolbar, the quick search's commands,
// sidebar places, home widgets, view types. What exists stays as it was:
// pages of a hidden kind (one's own or someone else's) still show in the
// tree, in search and behind links, and open and work as always. Nothing
// changes on the server's side (permissions, API).
//
//   users.modules  the hidden features as a JSON array, NULL: none of their
//                  own – the instance's default (modulesDefault,
//                  Administration → Instanz)
// Accounts from before #378 got "[]" once (lib/data-steps.ts), so nothing
// they knew disappears when an administrator changes the default; new
// accounts follow the default until they choose themselves. "Allen
// bestehenden Konten zuweisen" sets every account back to NULL.
//
// A feature a later version adds is not in anyone's list: it shows.
export const FEATURE_MODULES = [
  "flashcards",
  "whiteboards",
  "notebooks",
  "journal",
  "dashboards",
  "workflows",
  "drawio",
  "ai",
  "views",
  "forms",
  "meetings",
] as const;
export type FeatureModule = (typeof FEATURE_MODULES)[number];

const known = new Set<string>(FEATURE_MODULES);
export const isFeatureModule = (value: unknown): value is FeatureModule => typeof value === "string" && known.has(value);

// What the server accepts: lib/feature-modules-schema.ts.

// A stored or sent value read leniently: a JSON string or an array; unknown
// entries (a feature a later version dropped) are left out, the order is
// the list's above. Anything else is "nothing hidden".
export function hiddenModulesOf(value: unknown): FeatureModule[] {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const chosen = new Set(list.filter(isFeatureModule));
  return FEATURE_MODULES.filter((m) => chosen.has(m));
}
export const sameModules = (a: readonly FeatureModule[], b: readonly FeatureModule[]) => a.length === b.length && a.every((m, i) => m === b[i]);

// What the bootstrap carries: the hidden features that apply, whether they
// are the person's own choice and the instance's default (what "Standard"
// goes back to).
export type FeatureModulesBoot = { hidden: FeatureModule[]; own: boolean; standard: FeatureModule[] };

// ---- Where a feature has its entry points ----

// The kinds of page in "Neue Seite" and the quick search's "Neu …".
export const PAGE_KIND_MODULE: Partial<Record<PageKind, FeatureModule>> = {
  whiteboard: "whiteboards",
  notebook: "notebooks",
  journal: "journal",
  dashboard: "dashboards",
  workflow: "workflows",
};
// Entries of the "/" menu (components/editor.tsx, by id) – and with them
// their buttons in the formatting toolbar ("block:" + id).
export const SLASH_MODULE: Record<string, FeatureModule> = {
  ai: "ai",
  drawio: "drawio",
  whiteboard: "whiteboards",
  dashboard: "dashboards",
  "workflow-button": "workflows",
  cloze: "flashcards",
  meet: "meetings",
};
// View types of a database ("Ansicht hinzufügen"). Table and list always
// stay; "views" covers the other display types in one switch.
export const VIEW_MODULE: Partial<Record<View["type"], FeatureModule>> = {
  study: "flashcards",
  form: "forms",
  board: "views",
  calendar: "views",
  timeline: "views",
  gallery: "views",
  chart: "views",
  feed: "views",
  sprint: "views",
};
// Widgets of the start page (the gallery, and placed widgets are skipped).
export const HOME_WIDGET_MODULE: Partial<Record<HomeWidgetKind, FeatureModule>> = {
  study: "flashcards",
  journal: "journal",
};
// The quick starts of the "Was hast du heute vor?" widget.
export const QUICK_ACTION_MODULE: Partial<Record<string, FeatureModule>> = {
  journal: "journal",
  whiteboard: "whiteboards",
};

// Whether an entry point belonging to `module` (none: always) shows.
export const moduleShownIn = (hidden: readonly FeatureModule[], module: FeatureModule | undefined) => !module || !hidden.includes(module);
