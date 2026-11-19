// The colours of a widget answer (POST /api/mobile/widgets/data): the accent
// of the workspace the widget's content belongs to, for light and dark, with
// the text colour on it – derived exactly as the web app derives them
// (lib/workspace-theme.ts derivePalette: contrast-checked, WCAG AA). A
// workspace without its own accent, a person who chose Flowplan's own look
// (users.plain_look) or no workspace at all: Flowplan's accent
// (app/globals.css --blue / --on-accent). The app uses it when a widget's
// colour setting is "accent" (the default); older apps ignore it.
import { all, one } from "./db";
import { derivePalette, parseTheme } from "./workspace-theme";
import type { Identity } from "./types";

export type WidgetTheme = { workspaceId: string | null; accent: string; accentDark: string; onAccent: string; onAccentDark: string };
export const FLOWPLAN_THEME = { accent: "#3b3fd8", accentDark: "#959bff", onAccent: "#ffffff", onAccentDark: "#121117" } as const;

export function themeOf(workspaceId: string | null, raw: unknown, plain: boolean): WidgetTheme {
  const theme = plain ? null : parseTheme(raw);
  if (!theme?.accent) return { workspaceId, ...FLOWPLAN_THEME };
  const light = derivePalette(theme.accent, "light", theme.background ?? "standard"),
    dark = derivePalette(theme.accent, "dark", theme.background ?? "standard");
  return { workspaceId, accent: light.blue, accentDark: dark.blue, onAccent: light.onAccent, onAccentDark: dark.onAccent };
}

// Which page a widget's configuration is about (unparsed: a widget whose
// configuration does not parse still gets the person's colours).
function configPage(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const c = config as Record<string, unknown>;
  for (const key of ["pageId", "dashboardId", "targetId", "journalId", "habitsId"]) if (typeof c[key] === "string") return c[key] as string;
  const first = (list: unknown) => (Array.isArray(list) ? list[0] : undefined);
  const source = first(c.sources) as { pageId?: unknown } | undefined;
  if (typeof source?.pageId === "string") return source.pageId;
  const calendar = first(c.calendars);
  if (typeof calendar === "string") return calendar.split(":")[0];
  const deck = first(c.pageIds);
  return typeof deck === "string" ? deck : null;
}

// One per data request: the person's look, their workspaces and the
// workspace they used last (workspace_activity), read once.
export async function widgetThemes(user: Identity) {
  const plain = !!Number((await one<{ plain_look: number | null }>("SELECT plain_look FROM users WHERE id=?", user.id))?.plain_look);
  const workspaces = new Map(
    (await all<{ id: string; theme: string | null }>(
      "SELECT w.id,w.theme FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at,w.id",
      user.id,
    )).map((w) => [w.id, w.theme]),
  );
  const last = (await all<{ workspace_id: string }>("SELECT workspace_id FROM workspace_activity WHERE user_id=? ORDER BY at DESC LIMIT 20", user.id)).find((w) =>
    workspaces.has(w.workspace_id),
  )?.workspace_id;
  const fallback = last ?? workspaces.keys().next().value ?? null;
  const pages = new Map<string, string | null>();
  return async (config: unknown): Promise<WidgetTheme> => {
    const pageId = configPage(config);
    let workspaceId: string | null = null;
    if (pageId) {
      if (!pages.has(pageId)) pages.set(pageId, (await one<{ workspace_id: string }>("SELECT workspace_id FROM pages WHERE id=? AND deleted_at IS NULL", pageId))?.workspace_id ?? null);
      workspaceId = pages.get(pageId)!;
    }
    // Only a workspace of the person's (no colours of others' pages).
    if (!workspaceId || !workspaces.has(workspaceId)) workspaceId = fallback;
    return themeOf(workspaceId, workspaceId ? workspaces.get(workspaceId) : null, plain);
  };
}
