import { z } from "zod";

// "Symbole unten in der Seitenleiste" (#589, Settings → Darstellung &
// Sprache → Seitenleiste): which of the less used places in the sidebar's
// bottom row of symbols (components/sidebar-tools.tsx) a person keeps
// there. A hidden one stays reachable through the quick search and its
// keyboard shortcut; on phones the "Mehr" sheet leaves it out too, but
// always keeps Settings, and on wider windows a hidden Settings moves into
// the workspace menu at the top of the sidebar – so Settings, where the
// choice is undone, is never out of reach. A workspace hiding Study or
// Graph for everyone (#564, lib/workspace-navigation.ts) still applies on
// top of this.
// Stored per person on the server (users.sidebar_tools: NULL = every
// symbol shown, otherwise the hidden ones as JSON), delivered with the
// bootstrap, so it is the same on every device.
// Pure: no React, no DOM, no database (lib/user-sidebar-tools.ts stores it).

// The symbols of the row, in their order.
export const SIDEBAR_TOOL_IDS = ["templates", "media", "study", "tags", "graph", "trash", "settings", "shortcuts"] as const;
export type SidebarToolId = (typeof SIDEBAR_TOOL_IDS)[number];
// The place every hidden symbol is shown again from: never left out of
// the phone's "Mehr" sheet.
export const SETTINGS_TOOL: SidebarToolId = "settings";

export const isSidebarToolId = (value: unknown): value is SidebarToolId => typeof value === "string" && (SIDEBAR_TOOL_IDS as readonly string[]).includes(value);

// The hidden symbols as sent: known ids only (repeats are dropped when
// stored, hiddenSidebarToolsOf).
export const hiddenSidebarToolsSchema = z.array(z.enum(SIDEBAR_TOOL_IDS)).max(SIDEBAR_TOOL_IDS.length * 2);

// In the row's order, without repeats.
function normalizeHidden(ids: readonly string[]): SidebarToolId[] {
  return SIDEBAR_TOOL_IDS.filter((id) => ids.includes(id));
}

// What a stored or delivered value means: a JSON array or an array of ids;
// unknown ids (from a newer version) and anything broken are left out.
export function hiddenSidebarToolsOf(value: unknown): SidebarToolId[] {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? normalizeHidden(raw.filter(isSidebarToolId)) : [];
}

export const sameHiddenSidebarTools = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

// One symbol shown or hidden.
export function setSidebarToolShown(hidden: readonly SidebarToolId[], id: SidebarToolId, shown: boolean): SidebarToolId[] {
  return normalizeHidden(shown ? hidden.filter((h) => h !== id) : [...hidden, id]);
}

// The row of symbols: what the person did not hide.
export function toolRowOf<T extends { id: string }>(tools: readonly T[], hidden: readonly string[]): T[] {
  return tools.filter((tool) => !hidden.includes(tool.id));
}
// The phone's "Mehr" sheet: the same, but Settings always stays.
export function moreSheetOf<T extends { id: string }>(tools: readonly T[], hidden: readonly string[]): T[] {
  return tools.filter((tool) => tool.id === SETTINGS_TOOL || !hidden.includes(tool.id));
}
// Whether the workspace menu at the top needs its own "Einstellungen"
// entry (wider windows): only while the row does not show it.
export const settingsInMenu = (hidden: readonly string[]) => hidden.includes(SETTINGS_TOOL);
