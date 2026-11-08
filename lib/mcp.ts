// MCP server (Model Context Protocol) for Claude, ChatGPT and other AI
// clients. Every call acts as the person behind the personal API token, with
// exactly their rights: reads go through requirePage, the journal lock and
// record access; writes go through command() like an edit in the browser
// (versions, notifications, webhooks). Read tokens only get read tools.
import { isFormattedText } from "./inline-markdown";
import { aliasList } from "./aliases";
import * as Y from "yjs";
import { z } from "zod";
import { Node as PMNode } from "@tiptap/pm/model";
import { updateYFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import { all, one } from "./db";
import { HttpError, appUrl } from "./auth";
import { pageRole, requireMember, requirePage, spaceRole } from "./permissions";
import { command, database, rows } from "./api";
import { visibleRows } from "./row-access";
import { relatedData } from "./related-data";
import { computedCells, queryRows } from "./database";
import { cellText } from "./cell-text";
import { exportMarkdown } from "./markdown-export";
import { htmlToMarkdown, type MarkdownContext } from "./markdown";
import { markdownToHtml } from "./markdown-import";
import { cleanHtml, htmlState, htmlJson } from "./document-server";
import { documentSchema } from "./document-schema";
import { searchWorkspace, MARK_START, MARK_END } from "./search-index";
import { listCollections, runCollection } from "./collections";
import { myTasks } from "./doc-tasks";
import { lockedPageIds, requireUnlocked } from "./journal-extras";
import { validateCellPatch } from "./database-operations";
import { readableDatabase, stripHiddenCells } from "./field-access";
import { requireRow } from "./row-documents";
import { localizedMessage } from "./i18n-errors";
import { contentLocale } from "./content-locale";
import { buildInfo } from "./build-info";
import type { Field, Identity, Page, Row, Space, View } from "./types";
import { filterAsync, flatMapAsync, mapAsync } from "./each-async";
import { workflowTools } from "./workflows/mcp-tools";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// Answers longer than this are cut, so one call cannot flood the client.
const MAX_TEXT = 200_000;
const uuid = z.uuid();

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type Tool = {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  write: boolean;
  run: (user: Identity, args: never) => unknown;
};

function clip(text: string) {
  return text.length > MAX_TEXT
    ? `${text.slice(0, MAX_TEXT)}\n\n[… cut after ${MAX_TEXT} characters]`
    : text;
}
const json = (value: unknown) => clip(JSON.stringify(value, null, 2));
const pageLink = (id: string) => `${appUrl().replace(/\/$/, "")}/#page=${id}`;

// ---- Reading ----

async function workspaces(user: Identity) {
  return await mapAsync(await all<{ id: string; name: string; role: string; guest: number }>(
    `SELECT w.id,w.name,m.role,EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=w.id AND g.user_id=m.user_id) guest
     FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at`,
    user.id,
  ), async (w) => {
    const visible = new Set((await readablePages(user, w.id)).map((p) => p.space_id));
    return {
      id: w.id,
      name: w.name,
      role: w.role,
      guest: !!w.guest,
      spaces: await mapAsync(await filterAsync(await all<Space>(
        "SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NULL ORDER BY lower(name)",
        w.id,
      ), async (s) => await spaceRole(user, s) || visible.has(s.id)), async (s) => ({
          id: s.id,
          name: s.name,
          visibility: s.visibility,
          role: await spaceRole(user, s) || "viewer",
        })),
    };
  });
}
async function readablePages(user: Identity, workspaceId: string) {
  return await filterAsync(await all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND synced=0 ORDER BY position,id",
    workspaceId,
  ), async (p) => await pageRole(user, p));
}
async function listPages(
  user: Identity,
  args: { workspaceId: string; spaceId?: string; parentId?: string },
) {
  await requireMember(user, args.workspaceId);
  // Like resources/list: no titles from a journal behind a PIN (or an
  // encrypted space) until it is unlocked.
  const locked = await lockedPageIds(user, args.workspaceId);
  const pages = (await readablePages(user, args.workspaceId)).filter(
    (p) =>
      !locked.has(p.id) &&
      (!args.spaceId || p.space_id === args.spaceId) &&
      (args.parentId === undefined || p.parent_id === args.parentId),
  );
  return {
    pages: pages.slice(0, 500).map((p) => ({
      id: p.id,
      title: p.title,
      kind: p.kind,
      spaceId: p.space_id,
      parentId: p.parent_id,
      journalDate: p.journal_date || undefined,
      updatedAt: p.updated_at,
      url: pageLink(p.id),
    })),
    truncated: pages.length > 500,
  };
}
async function readable(user: Identity, pageId: string) {
  const page = await requirePage(user, pageId);
  await requireUnlocked(user, page);
  return page;
}
// Code blocks highlight every language Shiki bundles (lib/code-languages.ts).
const CODE_FENCES =
  "Code blocks: fenced with a language id as in VS Code/Shiki (```python, ```typescript, ```terraform, ```svelte …; aliases such as js, ts, py, sh, yml are understood). After the language: {3-5} highlights lines, showLineNumbers and startLine=10 number them, view=preview|split shows the rendering of html, svg, markdown, mermaid, latex and typst blocks (```mermaid shows its diagram by default), collapsed folds a long block.";

async function pageMarkdown(user: Identity, pageId: string) {
  const page = await readable(user, pageId);
  const { bytes } = await exportMarkdown(user, {
    pageId: page.id,
    format: "markdown",
    includeSubpages: false,
  });
  return { page, markdown: bytes.toString("utf8") };
}
// Plain links only; links to other pages and files stay addresses that need
// a sign-in, nothing is resolved for the client.
const plainLinks: MarkdownContext = {
  url(raw) {
    try {
      const url = new URL(raw, appUrl());
      return ["http:", "https:", "mailto:"].includes(url.protocol) && !url.username && !url.password
        ? url.href
        : null;
    } catch {
      return null;
    }
  },
  linked: () => null,
};
async function members(workspaceId: string) {
  return await all<{ id: string; name: string; email: string }>(
    "SELECT u.id,u.name,u.email FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?",
    workspaceId,
  );
}
async function databaseOf(user: Identity, databaseId: string) {
  const page = await readable(user, databaseId);
  if (page.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  // Properties hidden from this person are left out (lib/field-access.ts).
  return { page, schema: await readableDatabase(user, page, await database(page.id)) };
}
const fieldInfo = (f: Field, _: number, fields: Field[]) => ({
  id: f.id,
  name: f.name,
  type: f.type,
  // Formatted text (#126): the value is inline Markdown.
  ...(isFormattedText(f, fields) ? { markdown: true } : {}),
  ...(f.options?.length ? { options: f.options } : {}),
  // The workspace's tags are the options; a new name creates a tag (#79).
  ...(f.tagOptions ? { tagOptions: true } : {}),
  ...(f.relationPage ? { relationDatabaseId: f.relationPage } : {}),
});
// Properties keyed by name, as an AI reads them; people by name.
function recordProperties(cells: Record<string, unknown>, fields: Field[], people: Map<string, string>) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const value = cells[f.id];
    if (value === undefined || value === "" || value === null) continue;
    out[f.name] =
      f.type === "person" && typeof value === "string"
        ? people.get(value) || value
        : typeof value === "object" && !Array.isArray(value)
          ? cellText(value)
          : value;
  }
  return out;
}
async function queryDatabase(
  user: Identity,
  args: { databaseId: string; query?: string; viewId?: string; limit?: number; offset?: number },
) {
  const { page, schema } = await databaseOf(user, args.databaseId);
  const view: View = args.viewId
    ? schema.views.find((v) => v.id === args.viewId) ||
      (() => {
        throw new HttpError(404, "Ansicht nicht gefunden.");
      })()
    : ({ id: "", name: "", type: "table", filters: [], sorts: [] } as unknown as View);
  const { related, relatedSchemas } = await relatedData(user, page);
  const found = queryRows(
    // The database's own records, as relatedData read them for relations to itself.
    related[page.id] ?? await visibleRows(user, page, await rows(page.id)),
    schema.fields,
    view,
    (args.query || "").slice(0, 200),
    related,
    relatedSchemas,
  );
  const offset = args.offset || 0,
    limit = args.limit || 50;
  const people = new Map((await members(page.workspace_id)).map((m) => [m.id, m.name]));
  return {
    database: { id: page.id, title: page.title, url: pageLink(page.id) },
    fields: schema.fields.map(fieldInfo),
    views: schema.views.map((v) => ({ id: v.id, name: v.name, type: v.type })),
    total: found.length,
    offset,
    records: found.slice(offset, offset + limit).map((r) => ({
      id: r.id,
      version: r.version,
      title: cellText(r.cells[schema.fields[0]?.id]) || "",
      properties: recordProperties(r.cells, schema.fields, people),
      updatedAt: r.updated_at,
    })),
  };
}
async function getRecord(user: Identity, args: { databaseId: string; recordId: string }) {
  const { page, row } = await requireRow(user, args.databaseId, args.recordId);
  await requireUnlocked(user, page);
  const schema = await readableDatabase(user, page, await database(page.id));
  const { related, relatedSchemas } = await relatedData(user, page);
  const [parsed] = await stripHiddenCells(user, page, [
    { ...row, cells: typeof row.cells === "string" ? JSON.parse(row.cells) : row.cells } as Row,
  ]);
  const cells = computedCells(parsed, schema.fields, related, relatedSchemas);
  const html = (await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", row.id))?.html || row.content || "";
  const people = new Map((await members(page.workspace_id)).map((m) => [m.id, m.name]));
  return {
    id: row.id,
    databaseId: page.id,
    version: row.version,
    title: cellText(cells[schema.fields[0]?.id]) || "",
    fields: schema.fields.map(fieldInfo),
    properties: recordProperties(cells, schema.fields, people),
    document: html ? htmlToMarkdown(html, plainLinks) : "",
    url: `${pageLink(page.id)}&row=${row.id}`,
  };
}
async function search(user: Identity, args: { workspaceId: string; query: string; kind?: string; spaceId?: string }) {
  await requireMember(user, args.workspaceId);
  const marks = new RegExp(`[${MARK_START}${MARK_END}]`, "g");
  return {
    results: (await searchWorkspace(user, args.workspaceId, args.query, {
      kind: args.kind as never,
      spaceId: args.spaceId,
    })).map((r) => ({
      kind: r.kind,
      pageId: r.id,
      recordId: r.rowId,
      title: r.title,
      pageTitle: r.pageTitle,
      snippet: r.snippet.replace(marks, ""),
    })),
  };
}
// Collections (#86): saved queries, run with the person's own rights.
async function collections(user: Identity, args: { workspaceId: string }) {
  await requireMember(user, args.workspaceId);
  return { collections: await listCollections(user, args.workspaceId) };
}
async function collectionResults(user: Identity, args: { collectionId: string; timeZone?: string }) {
  const result = await runCollection(user, args.collectionId, { timeZone: args.timeZone });
  return {
    collection: result.collection,
    total: result.total,
    truncated: result.truncated,
    encryptedLeftOut: result.encryptedLeftOut,
    results: result.items.map((i) => ({ ...i, url: i.rowId ? `${pageLink(i.pageId)}&row=${i.rowId}` : pageLink(i.pageId) })),
  };
}
type CollectionArgs = { workspaceId?: string; collectionId?: string; name?: string; query?: string; icon?: string; shared?: boolean };
async function saveCollection(user: Identity, args: CollectionArgs) {
  if (args.collectionId) {
    const { workspaceId: _ignored, ...rest } = args;
    return await command(user, { action: "collection.update", ...rest });
  }
  return await command(user, { action: "collection.create", ...args });
}
async function removeCollection(user: Identity, args: { collectionId: string }) {
  return await command(user, { action: "collection.delete", collectionId: args.collectionId });
}
async function tasks(user: Identity, args: { workspaceId?: string; includeDone?: boolean }) {
  const ids = args.workspaceId
    ? [args.workspaceId]
    : (await all<{ workspace_id: string }>("SELECT workspace_id FROM members WHERE user_id=?", user.id)).map(
        (m) => m.workspace_id,
      );
  return {
    tasks: await flatMapAsync(ids, async (wid) => {
      await requireMember(user, wid);
      return (await myTasks(user, wid, !!args.includeDone)).map((t) => ({
        text: t.text,
        done: t.checked,
        due: t.due,
        assignedToMe: t.assigned,
        pageId: t.pageId,
        recordId: t.rowId || undefined,
        pageTitle: t.title,
        workspaceId: t.workspaceId,
      }));
    }),
  };
}

// ---- Writing (always through command()) ----

// Markdown appended to a stored document as one change, sent like an edit
// from the editor ("document.sync"), so versions, mentions, tasks, the
// activity and webhooks behave the same.
export async function appendToPage(user: Identity, args: { pageId: string; markdown: string }) {
  return await appendHtmlToPage(user, { pageId: args.pageId, html: markdownToHtml(args.markdown) });
}
// The same for HTML (highlights from the browser extension, lib/clipper.ts).
export async function appendHtmlToPage(user: Identity, args: { pageId: string; html: string }) {
  const page = await requirePage(user, args.pageId, true);
  await requireUnlocked(user, page);
  if (page.kind !== "document") throw new HttpError(400, "Kein Dokument.");
  const stored = await one<{ state: Uint8Array | null; html: string; generation: string }>(
    "SELECT state,html,generation FROM documents WHERE page_id=?",
    page.id,
  );
  if (!stored) throw new HttpError(404, "Dokument nicht gefunden.");
  const schema = documentSchema();
  const added = PMNode.fromJSON(
    schema,
    htmlJson(cleanHtml(args.html) || "<p></p>"),
  );
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, stored.state || htmlState(stored.html));
    const before = Y.encodeStateVector(ydoc);
    const doc = PMNode.fromJSON(schema, yDocToProsemirrorJSON(ydoc, "default"));
    // An empty page starts with the new text instead of a blank line.
    const empty = doc.childCount === 1 && doc.firstChild!.type.name === "paragraph" && !doc.firstChild!.content.size;
    const next = doc.type.create(doc.attrs, empty ? added.content : doc.content.append(added.content));
    ydoc.transact(() =>
      updateYFragment(ydoc, ydoc.getXmlFragment("default"), next, { mapping: new Map(), isOMark: new Map() }),
    );
    // Without a stored state the server takes the full state, not a diff.
    const update = stored.state ? Y.encodeStateAsUpdate(ydoc, before) : Y.encodeStateAsUpdate(ydoc);
    await command(user, {
      action: "document.sync",
      pageId: page.id,
      generation: stored.generation,
      update: Buffer.from(update).toString("base64"),
    });
  } finally {
    ydoc.destroy();
  }
  return { ok: true, pageId: page.id, url: pageLink(page.id) };
}
async function createPage(
  user: Identity,
  args: { workspaceId: string; spaceId: string; parentId?: string; title: string; kind?: string; markdown?: string },
) {
  const kind = args.kind || "document";
  if (args.markdown && kind !== "document") throw new HttpError(400, "Inhalt nur für Dokumente.");
  const { id } = (await command(user, {
    action: "page.create",
    workspaceId: args.workspaceId,
    spaceId: args.spaceId,
    parentId: args.parentId,
    title: args.title,
    kind,
  })) as { id: string };
  if (args.markdown) await appendToPage(user, { pageId: id, markdown: args.markdown });
  return { id, kind, url: pageLink(id) };
}
// Properties by name or id; people by e-mail or name, lists from one value.
async function cellPatch(user: Identity, page: Page, fields: Field[], input: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  const people = await members(page.workspace_id);
  for (const [key, raw] of Object.entries(input)) {
    const f =
      fields.find((f) => f.id === key) ||
      fields.find((f) => f.name.toLocaleLowerCase() === key.toLocaleLowerCase());
    if (!f) throw new HttpError(400, `Unknown property: ${key}`);
    let value = raw ?? "";
    if (f.type === "person" && typeof value === "string" && value) {
      const wanted = value.toLocaleLowerCase();
      value =
        people.find((m) => m.id === value || m.email.toLocaleLowerCase() === wanted || m.name.toLocaleLowerCase() === wanted)
          ?.id || value;
    }
    if (f.type === "aliases" && typeof value === "string") value = aliasList(value);
    if (["multiselect", "relation", "files"].includes(f.type) && typeof value === "string")
      value = value ? [value] : [];
    if (f.type === "number" && typeof value === "string" && value.trim() && !Number.isNaN(Number(value)))
      value = Number(value);
    patch[f.id] = value;
  }
  return await validateCellPatch(user, page, fields, patch);
}
async function createRecord(user: Identity, args: { databaseId: string; properties: Record<string, unknown> }) {
  const page = await requirePage(user, args.databaseId, true);
  await requireUnlocked(user, page);
  if (page.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  const cells = await cellPatch(user, page, (await readableDatabase(user, page, await database(page.id))).fields, args.properties);
  const { id } = (await command(user, { action: "row.create", pageId: page.id, cells })) as { id: string };
  return { id, databaseId: page.id, url: `${pageLink(page.id)}&row=${id}` };
}
async function updateRecord(
  user: Identity,
  args: { databaseId: string; recordId: string; properties: Record<string, unknown>; version?: number },
) {
  const { page, row } = await requireRow(user, args.databaseId, args.recordId, true);
  await requireUnlocked(user, page);
  const cells = await cellPatch(user, page, (await readableDatabase(user, page, await database(page.id))).fields, args.properties);
  await command(user, {
    action: "row.update",
    pageId: page.id,
    rowId: row.id,
    // Without a version the current one counts (last write wins).
    version: args.version ?? row.version,
    cells,
  });
  return { ok: true, id: row.id, version: (args.version ?? row.version) + 1 };
}

// ---- Tool catalogue ----

const id = (what: string) => uuid.describe(what);
const tools: Tool[] = [
  {
    name: "list_workspaces",
    title: "List workspaces and spaces",
    description:
      "Lists the Flowplan workspaces you are a member of, with your role and the spaces you can see. Start here to find workspace and space IDs.",
    input: z.object({}),
    write: false,
    run: async (user) => ({ workspaces: await workspaces(user) }),
  },
  {
    name: "list_pages",
    title: "List pages",
    description:
      "Lists the pages (documents, databases, whiteboards, journals) you can read in a workspace, optionally only in one space or below one parent page.",
    input: z.object({
      workspaceId: id("Workspace ID from list_workspaces"),
      spaceId: id("Only pages in this space").optional(),
      parentId: id("Only direct sub-pages of this page").optional(),
    }),
    write: false,
    run: listPages as Tool["run"],
  },
  {
    name: "search",
    title: "Search",
    description:
      "Full-text search across pages, database records, comments and file contents in a workspace. Returns page and record IDs with a snippet. Understands #tag, -#tag, Property:value, OR, NOT/-, parentheses, created_by:/updated_by: (name or me), created:/updated: (-7d, this-week, 2026-03, >2026-01-01), type:document|database|whiteboard|record, in:\"Space\" and title:. Tags and page properties may belong to one space (#tag names every tag of that name you may see, one per space).",
    input: z.object({
      workspaceId: id("Workspace ID"),
      query: z.string().min(1).max(500).describe("Search words and filters"),
      kind: z.enum(["all", "document", "database", "whiteboard", "row", "comment", "file"]).optional(),
      spaceId: id("Only in this space").optional(),
    }),
    write: false,
    run: search as Tool["run"],
  },
  {
    name: "list_collections",
    title: "List collections",
    description:
      "The saved collections of a workspace (own ones and those shared with the workspace) with their query in the search language: words, #tag, -#tag, Property:value, OR, NOT, parentheses, created_by:, updated_by:, created:/updated: (-7d, this-week, 2026-03 …), type:, in:, title:.",
    input: z.object({ workspaceId: id("Workspace ID") }),
    write: false,
    run: collections as Tool["run"],
  },
  {
    name: "run_collection",
    title: "Run a collection",
    description: "The pages and database records that match a collection now, as this person may read them (latest change first, at most 500).",
    input: z.object({
      collectionId: id("Collection ID from list_collections"),
      timeZone: z.string().max(100).optional().describe("IANA time zone for relative dates (default UTC)"),
    }),
    write: false,
    run: collectionResults as Tool["run"],
  },
  {
    name: "save_collection",
    title: "Create or change a collection",
    description:
      "Without collectionId: a new collection in the workspace (private unless shared). With collectionId: changes its name, query, icon or sharing (its creator; workspace owners for shared ones).",
    input: z.object({
      workspaceId: id("Workspace ID (for a new collection)").optional(),
      collectionId: id("Collection ID to change").optional(),
      name: z.string().trim().min(1).max(120).optional(),
      query: z.string().trim().min(1).max(1000).optional().describe("e.g. created_by:me #project -#done updated:-7d"),
      icon: z.string().max(16).optional(),
      shared: z.boolean().optional().describe("Share with all members of the workspace"),
    }),
    write: true,
    run: saveCollection as Tool["run"],
  },
  {
    name: "delete_collection",
    title: "Delete a collection",
    description: "Moves a collection to the trash (its creator; workspace owners for shared ones).",
    input: z.object({ collectionId: id("Collection ID") }),
    write: true,
    run: removeCollection as Tool["run"],
  },
  {
    name: "read_page",
    title: "Read a page as Markdown",
    description:
      "Returns a page as Markdown: documents with their text, databases with their records and properties.",
    input: z.object({ pageId: id("Page ID") }),
    write: false,
    run: (async (user: Identity, args: { pageId: string }) => (await pageMarkdown(user, args.pageId)).markdown) as Tool["run"],
  },
  {
    name: "query_database",
    title: "Query a database",
    description:
      "Lists records of a database with their properties (by name), the property definitions and views. Optional text filter, a saved view (its filters and sorting) and paging.",
    input: z.object({
      databaseId: id("Page ID of the database"),
      query: z.string().max(200).optional().describe("Only records containing this text"),
      viewId: z.string().max(100).optional().describe("Apply the filters and sorting of this view"),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
      offset: z.number().int().min(0).max(100000).optional(),
    }),
    write: false,
    run: queryDatabase as Tool["run"],
  },
  {
    name: "get_record",
    title: "Read a database record",
    description: "Returns one database record with all properties and its record document as Markdown.",
    input: z.object({ databaseId: id("Page ID of the database"), recordId: id("Record ID") }),
    write: false,
    run: getRecord as Tool["run"],
  },
  {
    name: "my_tasks",
    title: "My tasks",
    description:
      "Tasks in documents and records that are assigned to you or that you wrote, with due dates. Across all workspaces unless one is given.",
    input: z.object({
      workspaceId: id("Only this workspace").optional(),
      includeDone: z.boolean().optional().describe("Also completed tasks"),
    }),
    write: false,
    run: tasks as Tool["run"],
  },
  {
    name: "create_page",
    title: "Create a page",
    description:
      "Creates a page in a space, optionally below a parent page. Documents can start with Markdown content. Needs editor rights on the space.",
    input: z.object({
      workspaceId: id("Workspace ID"),
      spaceId: id("Space ID from list_workspaces"),
      parentId: id("Parent page ID").optional(),
      title: z.string().trim().min(1).max(500),
      kind: z.enum(["document", "database", "whiteboard"]).optional().describe("Default: document"),
      markdown: z.string().max(1_000_000).optional().describe(`Initial content (documents only). ${CODE_FENCES}`),
    }),
    write: true,
    run: createPage as Tool["run"],
  },
  {
    name: "append_to_page",
    title: "Append to a page",
    description:
      "Appends Markdown (headings, lists, task lists, tables, code) to the end of a document. Earlier content stays untouched and a version is kept. " + CODE_FENCES,
    input: z.object({
      pageId: id("Page ID of a document"),
      markdown: z.string().min(1).max(1_000_000),
    }),
    write: true,
    run: appendToPage as Tool["run"],
  },
  {
    name: "create_record",
    title: "Create a database record",
    description:
      "Adds a record to a database. Properties by name (or ID): text, number, date (YYYY-MM-DD), select option, list of options (for a property with tagOptions: tag names, a new name creates the tag), true/false, person (e-mail or name), relation (record IDs). Text properties with `markdown: true` take inline Markdown (**bold**, _italic_, ~~strike~~, `code`, [label](https://…), \\n for a line break; a backslash keeps * _ ~ ` [ ] \\ literal); the title is plain text.",
    input: z.object({
      databaseId: id("Page ID of the database"),
      properties: z.record(z.string().max(200), z.unknown()).describe("e.g. {\"Name\": \"Call Anna\", \"Status\": \"Open\"}"),
    }),
    write: true,
    run: createRecord as Tool["run"],
  },
  {
    name: "update_record",
    title: "Update record properties",
    description:
      "Changes properties of an existing record; properties not named stay as they are. Text properties with `markdown: true` take inline Markdown as in create_record. Pass the version from get_record or query_database to avoid overwriting a newer change.",
    input: z.object({
      databaseId: id("Page ID of the database"),
      recordId: id("Record ID"),
      properties: z.record(z.string().max(200), z.unknown()),
      version: z.number().int().min(0).optional(),
    }),
    write: true,
    run: updateRecord as Tool["run"],
  },
  // Workflows (#168, lib/workflows/mcp-tools.ts): no activation, no approvals.
  ...workflowTools,
];

// ---- Protocol ----

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const may = (user: Identity, tool: Tool) => !tool.write || user.apiScope === "write";
const message = (e: unknown) =>
  e instanceof z.ZodError
    ? `Invalid arguments: ${e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`
    : e instanceof HttpError
      ? localizedMessage(e.message, contentLocale())
      : "The request could not be processed.";

async function callTool(user: Identity, name: unknown, args: unknown): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
  if (!may(user, tool))
    return { isError: true, content: [{ type: "text", text: "This token may only read. Create a write token in Flowplan to change content." }] };
  try {
    const value = await tool.run(user, tool.input.parse(args ?? {}) as never);
    return { content: [{ type: "text", text: typeof value === "string" ? clip(value) : json(value) }] };
  } catch (e) {
    if (!(e instanceof HttpError) && !(e instanceof z.ZodError)) console.error("MCP tool failed", e);
    return { isError: true, content: [{ type: "text", text: message(e) }] };
  }
}
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
const PAGE_URI = /^flowplan:\/\/page\/([0-9a-f-]{36})$/i;
const prompts = [
  {
    name: "summarize_page",
    title: "Summarize a page",
    description: "Summarizes a Flowplan page with its key points and open tasks.",
    arguments: [{ name: "pageId", description: "Page ID", required: true }],
  },
  {
    name: "plan_my_day",
    title: "Plan my day",
    description: "Builds a plan for today from your open Flowplan tasks.",
    arguments: [],
  },
];

async function dispatch(user: Identity, method: string, params: Record<string, unknown>) {
  switch (method) {
    case "initialize": {
      const asked = String(params.protocolVersion || "");
      return {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: "flowplan", title: "Flowplan", version: buildInfo().version || "dev" },
        instructions:
          `Flowplan workspace of ${user.name}. You only see and change what this person may see and change. ` +
          "IDs are UUIDs: start with list_workspaces, then list_pages or search. " +
          (user.apiScope === "write" ? "Write tools create versions and notify followers like an edit in the browser." : "This connection is read-only."),
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: tools
          .filter((t) => may(user, t))
          .map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: (({ $schema: _, ...schema }) => schema)(z.toJSONSchema(t.input, { io: "input" })),
            annotations: { title: t.title, readOnlyHint: !t.write, destructiveHint: false, openWorldHint: false },
          })),
      };
    case "tools/call":
      return callTool(user, params.name, params.arguments);
    case "resources/list":
      return {
        resources: (await filterAsync(await all<Page>(
          "SELECT p.* FROM favorites f JOIN pages p ON p.id=f.page_id WHERE f.user_id=? AND p.deleted_at IS NULL LIMIT 100",
          user.id,
        ), async (p) => await pageRole(user, p) && !(await lockedPageIds(user, p.workspace_id)).has(p.id)))
          .map((p) => ({ uri: `flowplan://page/${p.id}`, name: p.title || "Untitled", mimeType: "text/markdown" })),
      };
    case "resources/templates/list":
      return {
        resourceTemplates: [
          { uriTemplate: "flowplan://page/{pageId}", name: "Flowplan page", description: "A page as Markdown", mimeType: "text/markdown" },
        ],
      };
    case "resources/read": {
      const match = PAGE_URI.exec(String(params.uri || ""));
      if (!match) throw new RpcError(-32002, "Resource not found.");
      try {
        const { markdown } = await pageMarkdown(user, match[1]);
        return { contents: [{ uri: params.uri, mimeType: "text/markdown", text: clip(markdown) }] };
      } catch (e) {
        throw new RpcError(-32002, message(e));
      }
    }
    case "prompts/list":
      return { prompts };
    case "prompts/get": {
      const args = (params.arguments || {}) as Record<string, string>;
      if (params.name === "summarize_page") {
        const pageId = uuid.parse(args.pageId);
        return {
          description: "Summarize a page",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Read the Flowplan page ${pageId} with the read_page tool and summarize it: the key points, decisions and open tasks.`,
              },
            },
          ],
        };
      }
      if (params.name === "plan_my_day")
        return {
          description: "Plan my day",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: "Use the my_tasks tool to load my open Flowplan tasks. Build a realistic plan for today: overdue and due tasks first, then the most important rest. Keep it short.",
              },
            },
          ],
        };
      throw new RpcError(-32602, "Unknown prompt.");
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

// One JSON-RPC message; null for notifications (no answer).
export async function handleMcpMessage(user: Identity, input: unknown) {
  // The demo never reaches this (tokens are refused there), but stay strict.
  if (user.demo || !user.apiScope) throw new HttpError(403, "MCP needs a personal API token.");
  const msg = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Message;
  const respond = (body: Record<string, unknown>) => ({ jsonrpc: "2.0", id: msg.id ?? null, ...body });
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return respond({ error: { code: -32600, message: "Invalid request." } });
  if (msg.id === undefined) return null;
  try {
    const params = msg.params && typeof msg.params === "object" ? msg.params : {};
    return respond({ result: await dispatch(user, msg.method, params) });
  } catch (e) {
    if (e instanceof RpcError) return respond({ error: { code: e.code, message: e.message } });
    if (e instanceof z.ZodError || e instanceof HttpError)
      return respond({ error: { code: -32602, message: message(e) } });
    console.error("MCP request failed", e);
    return respond({ error: { code: -32603, message: "Internal error." } });
  }
}
export const mcpToolNames = (user: Identity) => tools.filter((t) => may(user, t)).map((t) => t.name);
// Whether a message calls a tool that changes content (refused while the
// instance moves, lib/instance-read-only.ts).
export function mcpChanges(input: unknown) {
  const msg = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Message;
  if (msg.method !== "tools/call") return false;
  const name = msg.params && typeof msg.params === "object" ? msg.params.name : undefined;
  return !!tools.find((t) => t.name === name)?.write;
}
