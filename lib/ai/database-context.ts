// Records of databases the person refers to, as data for a prompt (#80).
//
// Without this the AI actions, the writing assistant and "Ask" only knew a
// database's title and properties – asked for "documentation from the Server
// table", the model wrote a template with placeholders. Now a database the
// person clearly refers to comes with its records:
//   - named in the instruction (its title, case-insensitive, also in quotes;
//     whole words first, a title at the start of a longer word – "Server" in
//     "Servertabelle" – only when no title matches as a whole word),
//   - linked in the instruction or in other text the request carries
//     (`#page=<id>` links, embedded database views),
//   - linked in the open document when the instruction speaks of a table or
//     database ("die verlinkte Tabelle"),
//   - the open page or a source given by the caller (Ask scope, Ask sources).
// At most DATABASE_CONTEXT_LIMITS.databases databases.
//
// What goes in: only databases and records the AI may read for this person
// (aiFilter: page permissions, private records, trash, journals with a PIN,
// "Für KI gesperrt", end-to-end encryption, the person's own AI rules), only
// properties the person sees (visibleFields / visibleRows strip the others),
// without links, computed values and files (recordLines), in database order.
// At most DATABASE_CONTEXT_LIMITS.records records and `maxChars` characters
// per request; the block says how many records were left out.
import { all, one } from "../db";
import { database, rows as databaseRows } from "../api";
import { visibleFields } from "../field-access";
import { visibleRows } from "../row-access";
import type { Field, Identity, Page } from "../types";
import { aiFilter } from "./access";
import type { DatabaseNote } from "./database-note";
import { cellPlain, nameLookup, recordLines, SKIPPED } from "./sources";

export const DATABASE_CONTEXT_LIMITS = {
  databases: 3,
  records: 200,
  chars: 40_000,
  // One property value.
  value: 500,
} as const;

export type DatabaseData = DatabaseNote & {
  // The records as lines (without the wrapper).
  body: string;
  // The body wrapped as data: <daten datenbank="…" einträge="…">…</daten>.
  block: string;
};

export type DatabaseRefInput = {
  workspaceId: string;
  // The person's instruction or question: titles and links count.
  instruction: string;
  // Further text of the request (a selection, an answer): links count.
  texts?: (string | null | undefined)[];
  // The open document (HTML or Markdown): its links count when the
  // instruction speaks of a table or database.
  document?: string | null;
  // Databases given directly (open page, scope, sources); others are ignored.
  pageIds?: (string | null | undefined)[];
  // Only databases among these pages (Ask limited to a page or space).
  within?: Set<string> | null;
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// A page link (not a record link) and an embedded database view.
const PAGE_LINK = new RegExp(`#page=(${UUID})(?!(?:&|&amp;|%26)row=)`, "gi");
const LINKED_VIEW = new RegExp(`data-linked-source=["'](${UUID})["']`, "gi");
// Words for "table" or "database" in the languages of the interface.
const GENERIC = /(?<![\p{L}\p{N}])(tabelle|datenbank|table|database|base de données|base de donnees|tableau|einträge|eintraege|records|enregistrements)/iu;

export function linkedPageIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const ids: string[] = [];
  for (const match of text.matchAll(PAGE_LINK)) ids.push(match[1].toLowerCase());
  for (const match of text.matchAll(LINKED_VIEW)) ids.push(match[1].toLowerCase());
  return [...new Set(ids)];
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LETTER = "[\\p{L}\\p{N}]";

// Databases whose title the text names, in the order they are named. A title
// inside a longer named title ("Server" in "Server Wartung") does not count
// on its own there.
export function namedDatabases<T extends { id: string; title: string }>(text: string, candidates: T[]): T[] {
  type Hit = { item: T; start: number; end: number };
  const find = (prefix: boolean) => {
    const hits: Hit[] = [];
    for (const item of candidates) {
      const title = item.title.trim();
      if (title.length < (prefix ? 4 : 2)) continue;
      const pattern = new RegExp(`(?<!${LETTER})${escapeRegex(title)}${prefix ? "" : `(?!${LETTER})`}`, "giu");
      for (const match of text.matchAll(pattern)) hits.push({ item, start: match.index!, end: match.index! + match[0].length });
    }
    return hits;
  };
  let hits = find(false);
  if (!hits.length) hits = find(true);
  // Longer titles first: a shorter title only where no longer one matched.
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken: Hit[] = [];
  for (const hit of hits) if (!taken.some((t) => t.item.title.trim().toLowerCase() !== hit.item.title.trim().toLowerCase() && hit.start >= t.start && hit.end <= t.end)) taken.push(hit);
  const first = new Map<string, { item: T; start: number }>();
  for (const hit of taken) if (!first.has(hit.item.id) || first.get(hit.item.id)!.start > hit.start) first.set(hit.item.id, { item: hit.item, start: hit.start });
  return [...first.values()].sort((a, b) => a.start - b.start).map((h) => h.item);
}

// The databases a request refers to (ids, at most `limit`), each readable
// for the AI.
export function referencedDatabases(user: Identity, input: DatabaseRefInput, limit: number = DATABASE_CONTEXT_LIMITS.databases): string[] {
  const candidates = all<{ id: string; title: string }>(
    "SELECT id,title FROM pages WHERE workspace_id=? AND kind='database' AND deleted_at IS NULL ORDER BY updated_at DESC",
    input.workspaceId,
  );
  const known = new Set(candidates.map((c) => c.id));
  const ordered: string[] = [];
  const add = (ids: (string | null | undefined)[]) => {
    for (const id of ids) if (id && known.has(id) && !ordered.includes(id) && (!input.within || input.within.has(id))) ordered.push(id);
  };
  add(namedDatabases(input.instruction, candidates).map((c) => c.id));
  add(linkedPageIds(input.instruction));
  for (const text of input.texts || []) add(linkedPageIds(text));
  add(input.pageIds || []);
  if (input.document && GENERIC.test(input.instruction)) add(linkedPageIds(input.document));
  if (!ordered.length) return [];
  return aiFilter(
    user,
    ordered.map((pageId) => ({ pageId })),
  )
    .slice(0, limit)
    .map((p) => p.pageId);
}

const escapeAttr = (text: string) => text.replace(/["<>\n\r]/g, " ").slice(0, 200);
// Data never closes its own wrapper (nor an Ask source around it).
const escapeBody = (text: string) => text.replace(/<\/(daten|quelle)/gi, "</ $1");
const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DATABASE_CONTEXT_LIMITS.value ? flat.slice(0, DATABASE_CONTEXT_LIMITS.value) + " …" : flat;
};

// One database's records as data, within `maxChars` and `maxRecords`.
export function databaseRecords(user: Identity, pageId: string, limits: { maxChars: number; maxRecords: number }): DatabaseData | null {
  const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", pageId);
  if (!page || page.kind !== "database") return null;
  // Checked again here: callers may pass ids from anywhere.
  if (!aiFilter(user, [{ pageId }]).length) return null;
  const fields = visibleFields(user, page, database(page.id).fields as Field[]);
  const titleField = fields[0];
  const visible = visibleRows(user, page, databaseRows(page.id));
  const readable = aiFilter(
    user,
    visible.map((row) => ({ pageId: page.id, rowId: row.id, row })),
  ).map((item) => item.row);
  const names = nameLookup();
  const header = fields.length ? `Eigenschaften: ${fields.filter((f, i) => i === 0 || !SKIPPED.includes(f.type)).map((f) => f.name).join(", ")}` : "";
  const lines: string[] = [];
  let size = header.length;
  for (const row of readable) {
    if (lines.length >= limits.maxRecords) break;
    const title = titleField ? oneLine(cellPlain(titleField, row.cells[titleField.id], row, names)) || "–" : "–";
    const values = recordLines(fields, row.cells, { ...row, number: row.number ?? null }, names).map(oneLine);
    const line = `- ${[`${titleField?.name || "Titel"}: ${title}`, ...values].join(" | ")}`;
    if (size + line.length + 1 > limits.maxChars) break;
    lines.push(line);
    size += line.length + 1;
  }
  const rest = readable.length - lines.length;
  const body = escapeBody(
    [header, ...lines, ...(rest > 0 ? [`… und ${rest} weitere Einträge (nicht enthalten, Grenze erreicht)`] : []), ...(readable.length ? [] : ["(keine Einträge)"])]
      .filter(Boolean)
      .join("\n"),
  );
  const note: DatabaseNote = { pageId: page.id, title: page.title, included: lines.length, total: readable.length };
  return {
    ...note,
    body,
    block: `<daten datenbank="${escapeAttr(page.title)}" einträge="${readable.length}"${rest > 0 ? ` enthalten="${lines.length}"` : ""}>\n${body}\n</daten>`,
  };
}

// The records of every database the request refers to, sharing one budget.
export function databaseContext(
  user: Identity,
  input: DatabaseRefInput & { maxChars?: number; maxRecords?: number },
): DatabaseData[] {
  let chars = Math.min(input.maxChars ?? DATABASE_CONTEXT_LIMITS.chars, DATABASE_CONTEXT_LIMITS.chars);
  let records = Math.min(input.maxRecords ?? DATABASE_CONTEXT_LIMITS.records, DATABASE_CONTEXT_LIMITS.records);
  if (chars < 200) return [];
  const result: DatabaseData[] = [];
  for (const pageId of referencedDatabases(user, input)) {
    if (chars < 200 || records <= 0) break;
    const data = databaseRecords(user, pageId, { maxChars: chars, maxRecords: records });
    if (!data) continue;
    result.push(data);
    chars -= data.block.length;
    records -= data.included;
  }
  return result;
}

export const databaseNotes = (list: DatabaseData[]): DatabaseNote[] => list.map(({ pageId, title, included, total }) => ({ pageId, title, included, total }));
