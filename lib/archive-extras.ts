// Parts of a workspace archive (lib/archive.ts) beyond pages, records and
// files: database settings (done rule, workflow, automations, sprints),
// record access modes, time entries and the status log behind burndown
// charts, journal settings and the trackers of each day, the ink on PDF
// files, the synced-block flag, the exporter's start page and the page
// references inside blocks (embedded whiteboards, synced blocks, metrics,
// drawing blocks). All of them are optional in the manifest, so older
// archives import as before and older servers skip what they do not know.
import { z } from "zod";
import { all, id, one, run } from "./db";
import { settingsSchema, type DatabaseSettings } from "./database-settings-schema";
import { rowAccessModes } from "./row-access-modes";
import { journalOptionsSchema, trackerSchema } from "./journal-extras";
import { parseLayout, layoutBytes, MAX_LAYOUT_BYTES } from "./home-layout-schema";
import { parseInk, serializeInk, inkText, INK_LIMITS } from "./ink/model";
import { cleanRecognizedMap, parseRecognizedMap } from "./ink/recognized";
import type { Field } from "./types";

// ---- Manifest parts ----

export const rowAccessSchema = z.enum(rowAccessModes).default("inherit");
export const timeEntrySchema = z.object({
  row_id: z.string().uuid(),
  field_id: z.string().min(1).max(500),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  note: z.string().max(300).default(""),
});
export const statusEntrySchema = z.object({
  row_id: z.string().uuid(),
  done: z.number().int().min(0).max(1),
  at: z.number().int().min(0),
});
export const databaseExtrasShape = {
  // Checked again on import (settingsSchema); Git secrets never leave.
  settings: z.unknown().optional(),
  timeEntries: z.array(timeEntrySchema).max(50000).optional(),
  statusLog: z.array(statusEntrySchema).max(50000).optional(),
};
const entryValues = z.record(z.string().regex(/^[a-z0-9-]{1,40}$/), z.union([z.number().min(-1e6).max(1e6), z.boolean()]));
export const pageExtrasShape = {
  // The content of a synced block (not listed in the page tree).
  synced: z.number().int().min(0).max(1).optional(),
  // Journals: template, trackers and what the bar above each day shows.
  journal: z
    .object({
      template: z.string().max(50_000).default(""),
      trackers: z.array(trackerSchema).max(12).default([]),
      options: journalOptionsSchema.optional(),
    })
    .optional(),
  // Journal days: the tracker values and the place (no coordinates).
  journalEntry: z.object({ values: entryValues.default({}), place: z.string().max(120).default("") }).optional(),
};
export const fileInkSchema = z.object({ data: z.string().max(6_500_000), recognized: z.string().max(200_000).optional() });

// ---- Export ----

export function exportDatabaseExtras(pageId: string, visibleRows: Set<string>) {
  const raw = one<{ settings: string }>("SELECT settings FROM databases WHERE page_id=?", pageId)?.settings;
  let settings: DatabaseSettings | undefined;
  try {
    const parsed = settingsSchema.parse(JSON.parse(raw || "{}"));
    // Credentials of the Git connection and who set up a rule stay here.
    delete parsed.git;
    parsed.automations = parsed.automations?.map(({ createdBy: _by, since: _since, ...a }) => a);
    if (!parsed.automations?.length) delete parsed.automations;
    settings = Object.keys(parsed).length ? parsed : undefined;
  } catch {}
  const timeEntries = all<z.infer<typeof timeEntrySchema>>(
    "SELECT row_id,field_id,start,end,note FROM time_entries WHERE page_id=? AND end IS NOT NULL ORDER BY start",
    pageId,
  ).filter((e) => visibleRows.has(e.row_id));
  const statusLog = all<z.infer<typeof statusEntrySchema>>("SELECT row_id,done,at FROM row_status_log WHERE page_id=? ORDER BY at", pageId).filter((e) =>
    visibleRows.has(e.row_id),
  );
  return {
    ...(settings ? { settings } : {}),
    ...(timeEntries.length ? { timeEntries } : {}),
    ...(statusLog.length ? { statusLog } : {}),
  };
}

export function exportPageExtras(page: { id: string; kind: string; synced?: number; journal_date?: string | null; parent_id: string | null }) {
  const out: { synced?: number; journal?: unknown; journalEntry?: unknown } = {};
  if (page.synced) out.synced = 1;
  if (page.kind === "journal") {
    const row = one<{ template: string; trackers: string; options: string }>("SELECT template,trackers,options FROM journal_settings WHERE page_id=?", page.id);
    if (row)
      out.journal = {
        template: row.template || "",
        trackers: z.array(trackerSchema).max(12).catch([]).parse(safeJson(row.trackers, [])),
        options: journalOptionsSchema.catch({ place: true, events: true, create: "auto" }).parse(safeJson(row.options, {})),
      };
  }
  if (page.journal_date) {
    const entry = one<{ data: string; place: string }>("SELECT data,place FROM journal_entries WHERE page_id=?", page.id);
    if (entry) out.journalEntry = { values: entryValues.catch({}).parse(safeJson(entry.data, {})), place: entry.place || "" };
  }
  return out;
}

export function exportFileInk(fileId: string) {
  const row = one<{ data: string; recognized: string }>("SELECT data,recognized FROM file_ink WHERE file_id=?", fileId);
  if (!row) return {};
  const doc = parseInk(row.data);
  if (!Object.values(doc.pages).some((items) => items.length)) return {};
  const recognized = parseRecognizedMap(row.recognized);
  return { ink: { data: serializeInk(doc), ...(Object.keys(recognized).length ? { recognized: JSON.stringify(recognized) } : {}) } };
}

// The exporter's own start page of this workspace, if they set one up.
export function exportHomeLayout(userId: string, workspaceId: string) {
  const row = one<{ layout: string }>("SELECT layout FROM home_layouts WHERE user_id=? AND workspace_id=?", userId, workspaceId);
  return row ? { home: parseLayout(row.layout) } : {};
}

// ---- Import ----

type Maps = { pages: Map<string, string>; rows: Map<string, string>; spaces: Map<string, string>; rewriteUrl: (value: string) => string };

// Page references inside block attributes that the link rewriting does not
// cover; unknown references stay as they are (they show as missing).
export function remapBlockAttributes(attrs: Record<string, string>, pages: Map<string, string>) {
  for (const key of ["data-whiteboard", "data-synced-block", "data-ink-page"])
    if (attrs[key] && pages.has(attrs[key])) attrs[key] = pages.get(attrs[key])!;
  if (attrs["data-ink-from"]) {
    const [page, block] = attrs["data-ink-from"].split("/");
    if (pages.has(page)) attrs["data-ink-from"] = `${pages.get(page)}/${block}`;
  }
  if (attrs["data-metric"]) {
    const metric = safeJson<Record<string, unknown>>(attrs["data-metric"], {});
    if (typeof metric.source === "string" && pages.has(metric.source)) attrs["data-metric"] = JSON.stringify({ ...metric, source: pages.get(metric.source) });
  }
  return attrs;
}

// Settings of an imported database: rules act for the person importing,
// people who are not members become "whoever triggered the rule".
export function importDatabaseSettings(
  pageId: string,
  raw: unknown,
  ctx: { user: string; fields: Field[]; members: Set<string>; templates: Map<string, string>; person: (value: string) => string },
) {
  if (raw === undefined) return;
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) return;
  const settings = parsed.data;
  delete settings.git;
  const known = new Set(ctx.fields.map((f) => f.id));
  const person = new Set(ctx.fields.filter((f) => f.type === "person").map((f) => f.id));
  const since = new Date().toISOString();
  const outsider = (value: unknown) => typeof value === "string" && !value.startsWith("@") && !ctx.members.has(value);
  // A person in a rule: a member (the exporter becomes the importer) or "@actor".
  const who = (value: unknown) => (outsider(value) ? "@actor" : typeof value === "string" ? ctx.person(value) : value);
  if (settings.done && !known.has(settings.done.field)) delete settings.done;
  if (settings.workflow && !known.has(settings.workflow.field)) delete settings.workflow;
  if (settings.pointsField && !known.has(settings.pointsField)) delete settings.pointsField;
  settings.automations = settings.automations?.map((a) => ({
    ...a,
    createdBy: ctx.user,
    since,
    actions: a.actions.map((action) => {
      if (action.type === "notify" && !action.to.startsWith("field:")) return { ...action, to: String(who(action.to)) };
      if (action.type === "set" && person.has(action.field)) return { ...action, value: who(action.value) };
      if (action.type === "create")
        return {
          ...action,
          template: ctx.templates.get(action.template) || "",
          cells: Object.fromEntries(Object.entries(action.cells).map(([k, v]) => [k, person.has(k) ? who(v) : v])),
        };
      return action;
    }),
  }));
  run("UPDATE databases SET settings=? WHERE page_id=?", JSON.stringify(settings), pageId);
}

export function importDatabaseHistory(
  pageId: string,
  data: { timeEntries?: z.infer<typeof timeEntrySchema>[]; statusLog?: z.infer<typeof statusEntrySchema>[] },
  ctx: { user: string; rows: Map<string, string>; fields: Field[] },
) {
  const timeFields = new Set(ctx.fields.filter((f) => f.type === "time").map((f) => f.id));
  for (const e of data.timeEntries || [])
    if (ctx.rows.has(e.row_id) && timeFields.has(e.field_id) && e.end >= e.start)
      run(
        "INSERT INTO time_entries(id,page_id,row_id,field_id,user_id,start,end,note) VALUES(?,?,?,?,?,?,?,?)",
        id(),
        pageId,
        ctx.rows.get(e.row_id)!,
        e.field_id,
        ctx.user,
        e.start,
        e.end,
        e.note,
      );
  for (const e of data.statusLog || [])
    if (ctx.rows.has(e.row_id))
      run("INSERT INTO row_status_log(id,page_id,row_id,done,at) VALUES(?,?,?,?,?)", id(), pageId, ctx.rows.get(e.row_id)!, e.done, e.at);
}

export function importPageExtras(
  pageId: string,
  p: { synced?: number; journal?: { template: string; trackers: z.infer<typeof trackerSchema>[]; options?: z.infer<typeof journalOptionsSchema> }; journalEntry?: { values: Record<string, number | boolean>; place: string } },
  rewriteHtml: (html: string) => string,
) {
  if (p.synced) run("UPDATE pages SET synced=1 WHERE id=?", pageId);
  if (p.journal) {
    if (new Set(p.journal.trackers.map((t) => t.id)).size !== p.journal.trackers.length) return;
    run(
      "INSERT INTO journal_settings(page_id,template,trackers,options) VALUES(?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET template=excluded.template,trackers=excluded.trackers,options=excluded.options",
      pageId,
      p.journal.template ? rewriteHtml(p.journal.template) : "",
      JSON.stringify(p.journal.trackers),
      JSON.stringify(p.journal.options || { place: true, events: true }),
    );
  }
  if (p.journalEntry)
    run(
      "INSERT INTO journal_entries(page_id,data,place,updated_at) VALUES(?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET data=excluded.data,place=excluded.place",
      pageId,
      JSON.stringify(p.journalEntry.values),
      p.journalEntry.place,
      Date.now(),
    );
}

export function importFileInk(fileId: string, ink: z.infer<typeof fileInkSchema> | undefined, user: string) {
  if (!ink) return;
  const doc = parseInk(ink.data);
  const data = serializeInk(doc);
  if (!Object.values(doc.pages).some((items) => items.length) || data.length > INK_LIMITS.bytes) return;
  const recognized = cleanRecognizedMap(safeJson(ink.recognized || "{}", {}));
  for (const key of Object.keys(recognized)) if (!doc.pages[key]?.length) delete recognized[key];
  const now = Date.now();
  run(
    "INSERT INTO file_ink(file_id,data,text,recognized,version,updated_by,updated_at) VALUES(?,?,?,?,1,?,?)",
    fileId,
    data,
    inkText(doc).slice(0, 100000),
    JSON.stringify(recognized),
    user,
    now,
  );
  run("INSERT INTO file_ink_versions(file_id,version,data,created_by,created_at) VALUES(?,1,?,?,?)", fileId, data, user, now);
}

// The start page comes along only for someone who has not set one up yet
// (neither for this workspace nor as their own default); "Reset" undoes it.
export function importHomeLayout(user: string, workspaceId: string, raw: unknown, maps: Maps) {
  if (raw === undefined) return;
  if (one("SELECT 1 FROM home_layouts WHERE user_id=? AND workspace_id IN (?, '')", user, workspaceId)) return;
  const layout = parseLayout(raw);
  const pageKeys = ["pageId", "journalId", "targetId"];
  layout.widgets = layout.widgets.flatMap((w) => {
    const config = { ...(w.config as Record<string, unknown>) };
    for (const key of pageKeys)
      if (typeof config[key] === "string") {
        if (!maps.pages.has(config[key] as string)) return [];
        config[key] = maps.pages.get(config[key] as string);
      }
    if (typeof config.spaceId === "string") {
      if (!maps.spaces.has(config.spaceId)) delete config.spaceId;
      else config.spaceId = maps.spaces.get(config.spaceId);
    }
    if (Array.isArray(config.sources))
      config.sources = (config.sources as { pageId: string; viewId?: string }[])
        .filter((s) => maps.pages.has(s.pageId))
        .map((s) => ({ ...s, pageId: maps.pages.get(s.pageId)! }));
    return [{ ...w, config } as typeof w];
  });
  if (layout.appearance.header.type === "image") {
    const value = maps.rewriteUrl(layout.appearance.header.value);
    layout.appearance.header = value === layout.appearance.header.value ? { type: "none", value: "", position: 50 } : { ...layout.appearance.header, value };
  }
  const clean = parseLayout(layout);
  if (layoutBytes(clean) > MAX_LAYOUT_BYTES) return;
  run("INSERT INTO home_layouts(user_id,workspace_id,layout,updated_at) VALUES(?,?,?,?)", user, workspaceId, JSON.stringify(clean), Date.now());
}

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}
