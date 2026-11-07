// Where a person's start page layout comes from and where it is stored
// (table home_layouts, schema 62 in lib/db.ts). The layout of a workspace
// is, in this order: the one the person set up for this workspace, their
// own default for all workspaces, the default the workspace's owners chose
// for their members, the built-in default (lib/home-layout-schema.ts).
// Sent with the bootstrap, so every device shows the same start page;
// changed with the commands home.save, home.reset, home.note, home.config,
// home.default.
import { z } from "zod";
import { one, run } from "./db";
import { HttpError } from "./auth";
import { requireMember } from "./permissions";
import {
  defaultLayout,
  inlineConfigs,
  layoutBytes,
  MAX_LAYOUT_BYTES,
  MAX_NOTE_LENGTH,
  parseLayout,
  saveSchema,
  type HomeLayout,
  type InlineKind,
} from "./home-layout-schema";
import type { Identity } from "./types";

// Where the layout shown came from (the editor offers what fits).
export type HomeSource = "workspace" | "personal" | "team" | "builtin";
export type HomeState = {
  layout: HomeLayout;
  source: HomeSource;
  // What "Reset" leads to: the layout below this one.
  fallback: HomeLayout;
  fallbackSource: Exclude<HomeSource, "workspace">;
  // The workspace has a default for its members (owners can change it).
  teamDefault: boolean;
  updatedAt: number | null;
};

const stored = async (userId: string, workspaceId: string) =>
  await one<{ layout: string; updated_at: number }>("SELECT layout,updated_at FROM home_layouts WHERE user_id=? AND workspace_id=?", userId, workspaceId);
const teamStored = async (workspaceId: string) =>
  await one<{ layout: string; updated_at: number }>("SELECT layout,updated_at FROM home_defaults WHERE workspace_id=?", workspaceId);

export async function homeLayout(user: Pick<Identity, "id">, workspaceId: string): Promise<HomeState> {
  const own = await stored(user.id, workspaceId);
  const personal = await stored(user.id, "");
  const team = await teamStored(workspaceId);
  const below: { layout: HomeLayout; source: Exclude<HomeSource, "workspace">; at: number | null } = personal
    ? { layout: parseLayout(personal.layout), source: "personal", at: personal.updated_at }
    : team
      ? { layout: parseLayout(team.layout), source: "team", at: team.updated_at }
      : { layout: defaultLayout(), source: "builtin", at: null };
  if (own)
    return {
      layout: parseLayout(own.layout),
      source: "workspace",
      fallback: below.layout,
      fallbackSource: below.source,
      teamDefault: !!team,
      updatedAt: own.updated_at,
    };
  // Without an own layout, "Reset" goes one step further down.
  const next = below.source === "personal" ? (team ? { layout: parseLayout(team.layout), source: "team" as const } : { layout: defaultLayout(), source: "builtin" as const }) : below.source === "team" ? { layout: defaultLayout(), source: "builtin" as const } : below;
  return { layout: below.layout, source: below.source, fallback: next.layout, fallbackSource: next.source, teamDefault: !!team, updatedAt: below.at };
}

function checkedJson(layout: HomeLayout) {
  // Stored as parsed: unknown keys never reach the database.
  const clean = parseLayout(layout);
  if (layoutBytes(clean) > MAX_LAYOUT_BYTES) throw new HttpError(413, "Die Startseite ist zu groß – bitte weniger Inhalte.");
  return JSON.stringify(clean);
}
async function write(userId: string, workspaceId: string, json: string) {
  await run(
    `INSERT INTO home_layouts(user_id,workspace_id,layout,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(user_id,workspace_id) DO UPDATE SET layout=excluded.layout,updated_at=excluded.updated_at`,
    userId,
    workspaceId,
    json,
    Date.now(),
  );
}

// Saves the edited layout for this workspace, or as the person's default
// (then this workspace follows that default again).
export async function saveHomeLayout(user: Identity, body: unknown): Promise<HomeState> {
  const input = saveSchema.parse(body);
  await requireMember(user, input.workspaceId);
  const json = checkedJson(input.layout as HomeLayout);
  if (input.scope === "personal") {
    await write(user.id, "", json);
    await run("DELETE FROM home_layouts WHERE user_id=? AND workspace_id=?", user.id, input.workspaceId);
  } else await write(user.id, input.workspaceId, json);
  return await homeLayout(user, input.workspaceId);
}

// Back one step: the workspace's own layout goes (then the personal or the
// team default shows); with scope "personal" the personal default goes too.
export async function resetHomeLayout(user: Identity, body: unknown): Promise<HomeState> {
  const input = z.object({ workspaceId: z.uuid(), scope: z.enum(["workspace", "personal"]).default("workspace") }).parse(body);
  await requireMember(user, input.workspaceId);
  const own = await stored(user.id, input.workspaceId);
  if (own) await run("DELETE FROM home_layouts WHERE user_id=? AND workspace_id=?", user.id, input.workspaceId);
  if (input.scope === "personal" || !own) await run("DELETE FROM home_layouts WHERE user_id=? AND workspace_id=''", user.id);
  return await homeLayout(user, input.workspaceId);
}

// The text of a note widget, saved while typing: only that widget changes,
// so a layout edited on another device meanwhile stays as it is.
export async function saveHomeNote(user: Identity, body: unknown): Promise<{ ok: true; updatedAt: number }> {
  const input = z
    .object({ workspaceId: z.uuid(), widgetId: z.string().regex(/^[a-z0-9-]{1,40}$/i), text: z.string().max(MAX_NOTE_LENGTH) })
    .parse(body);
  await requireMember(user, input.workspaceId);
  const state = await homeLayout(user, input.workspaceId);
  const widget = state.layout.widgets.find((w) => w.id === input.widgetId && w.kind === "notes");
  if (!widget) throw new HttpError(404, "Dieses Widget gibt es nicht mehr.");
  (widget.config as { text: string }).text = input.text;
  const json = checkedJson(state.layout);
  // Stored where the shown layout comes from; a team or built-in layout
  // becomes the person's own for this workspace.
  await write(user.id, state.source === "personal" ? "" : input.workspaceId, json);
  return { ok: true, updatedAt: Date.now() };
}

// A setting changed on the widget itself (the period of "My activity"):
// like a note, only that widget changes, and only the keys of inlineConfigs.
export async function saveHomeConfig(user: Identity, body: unknown): Promise<{ ok: true; updatedAt: number }> {
  const input = z
    .object({ workspaceId: z.uuid(), widgetId: z.string().regex(/^[a-z0-9-]{1,40}$/i), config: z.record(z.string(), z.unknown()) })
    .parse(body);
  await requireMember(user, input.workspaceId);
  const state = await homeLayout(user, input.workspaceId);
  const widget = state.layout.widgets.find((w) => w.id === input.widgetId && w.kind in inlineConfigs);
  if (!widget) throw new HttpError(404, "Dieses Widget gibt es nicht mehr.");
  Object.assign(widget.config, inlineConfigs[widget.kind as InlineKind].parse(input.config));
  await write(user.id, state.source === "personal" ? "" : input.workspaceId, checkedJson(state.layout));
  return { ok: true, updatedAt: Date.now() };
}

// Owners: the layout new members (and everyone without an own one) see;
// null removes it.
export async function setTeamDefault(user: Identity, body: unknown): Promise<HomeState> {
  const input = z.object({ workspaceId: z.uuid(), layout: z.unknown().nullable() }).parse(body);
  await requireMember(user, input.workspaceId, "owner");
  if (input.layout === null) await run("DELETE FROM home_defaults WHERE workspace_id=?", input.workspaceId);
  else {
    const layout = saveSchema.shape.layout.parse(input.layout) as HomeLayout;
    // Personal notes stay personal.
    for (const w of layout.widgets) if (w.kind === "notes") (w.config as { text: string }).text = "";
    await run(
      `INSERT INTO home_defaults(workspace_id,layout,updated_by,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(workspace_id) DO UPDATE SET layout=excluded.layout,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
      input.workspaceId,
      checkedJson(layout),
      user.id,
      Date.now(),
    );
  }
  return await homeLayout(user, input.workspaceId);
}
