import type { HomeWidgetKind } from "./home-layout-schema";

// A workspace as a library (#564, e.g. an office handbook): Settings →
// Arbeitsbereich → Allgemein → Bibliothek, owners only. Two things, kept
// in workspaces.navigation (JSON, NULL: neither; lib/db.ts schema 140):
//
//   library  every space of the workspace shows as a library (shelves of
//            books, lib/library.ts) – spaces created later as well. The
//            spaces' own "Als Bibliothek anzeigen" stays as it is: off
//            again, each space shows as it did before.
//   hidden   places of the sidebar the workspace does without (My tasks,
//            journal, study, graph) – for every member, like the personal
//            feature switches (lib/feature-modules.ts): the sidebar entry,
//            the quick search's commands, the shortcut and the start
//            page's widgets go, nothing is deleted and links still open.
//
// Plain data and pure functions: the browser and the server
// (lib/workspace-navigation-server.ts) read it alike.
export const WORKSPACE_PLACES = ["tasks", "journal", "study", "graph"] as const;
export type WorkspacePlace = (typeof WORKSPACE_PLACES)[number];
export type WorkspaceNavigation = { library: boolean; hidden: WorkspacePlace[] };
export const NO_NAVIGATION: WorkspaceNavigation = { library: false, hidden: [] };
// Offered ticked when the library mode is switched on: a handbook has no
// tasks of one's own and no diary. The person can change it.
export const LIBRARY_SUGGESTED_HIDDEN: readonly WorkspacePlace[] = ["tasks", "journal"];

const known = new Set<string>(WORKSPACE_PLACES);
export const isWorkspacePlace = (value: unknown): value is WorkspacePlace => typeof value === "string" && known.has(value);
// Known places, each once, in the list's order.
export const placesOf = (list: unknown): WorkspacePlace[] => {
  if (!Array.isArray(list)) return [];
  const chosen = new Set(list.filter(isWorkspacePlace));
  return WORKSPACE_PLACES.filter((p) => chosen.has(p));
};

// The stored value read leniently: a JSON string or an object; anything
// else (NULL, broken JSON) is neither. Unknown places (dropped by a later
// version) are left out.
export function navigationOf(value: unknown): WorkspaceNavigation {
  let data = value;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return { ...NO_NAVIGATION, hidden: [] };
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ...NO_NAVIGATION, hidden: [] };
  const d = data as { library?: unknown; hidden?: unknown };
  return { library: d.library === true, hidden: placesOf(d.hidden) };
}
export const isDefaultNavigation = (nav: WorkspaceNavigation) => !nav.library && !nav.hidden.length;

// Whether an entry belonging to `place` (none: always) shows.
export const placeShownIn = (nav: Pick<WorkspaceNavigation, "hidden"> | null | undefined, place: WorkspacePlace | undefined) =>
  !place || !nav?.hidden.includes(place);

// The spaces as they show: with the workspace as a library every space is
// one (`library: 1`), its own choice kept in `own_library` for the space's
// settings; otherwise the spaces as they are.
export type NavigationSpace = { library?: number | boolean | null; own_library?: number };
export function spacesAsShown<S extends NavigationSpace>(spaces: S[], nav: Pick<WorkspaceNavigation, "library"> | null | undefined): S[] {
  if (!nav?.library) return spaces;
  return spaces.map((s) => ({ ...s, library: 1, own_library: s.library ? 1 : 0 }));
}
// A space's own "Als Bibliothek anzeigen", whether or not the workspace
// shows every space as a library.
export const ownLibrary = (space: NavigationSpace) => !!(space.own_library ?? space.library);

// Widgets of the start page that belong to a place: not offered in the
// gallery and skipped where placed. A tasks widget only with "My tasks" as
// its source – one over a database view stays.
export const HOME_WIDGET_PLACE: Partial<Record<HomeWidgetKind, WorkspacePlace>> = {
  tasks: "tasks",
  journal: "journal",
  study: "study",
};
export function widgetPlace(widget: { kind: HomeWidgetKind; config?: unknown }): WorkspacePlace | undefined {
  if (widget.kind === "tasks" && (widget.config as { source?: unknown } | undefined)?.source === "view") return undefined;
  return HOME_WIDGET_PLACE[widget.kind];
}
