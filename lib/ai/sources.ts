// What a page or a record says, as text chunks for the AI ("ask" and the
// semantic index). This module only reads; whether the AI may read a source
// is decided elsewhere (lib/ai/access.ts) – callers check before using it.
import { mapAsync } from "../each-async";
import { pageMetaSearchText } from "../page-properties-server";
import { notebookText } from "../notebook";
import { all, one } from "../db";
import { publicHiddenFieldIds } from "../field-access";
import { ct } from "../content-locale";
import { ticketId } from "../ticket-ids";
import type { Field, Page } from "../types";
import { whiteboardSnapshotItems } from "../whiteboard";
import { racksText } from "../whiteboard-rack";
import { chunkHtml, chunkPlain, chunkParagraphs } from "./chunks";
import { htmlText } from "./content";

export type SourceText = {
  pageId: string;
  rowId: string | null;
  title: string;
  // Records: the title of their database.
  pageTitle?: string;
  kind: "document" | "database" | "whiteboard" | "journal" | "row";
  chunks: string[];
};

// Property types whose value is no text of the record itself: links to
// other records, computed values and files (their text is indexed apart).
export const SKIPPED: Field["type"][] = ["relation", "rollup", "formula", "files", "progress", "time", "sprint"];

const checkboxText = (v: unknown) => (v === true ? "ja" : "nein");
// A property value as people read it (persons by name).
export async function cellPlain(
  field: Field,
  value: unknown,
  row: { number?: number | null; created_at?: string; updated_at?: string; created_by?: string | null; updated_by?: string | null },
  names: (id: string) => string | Promise<string>,
): Promise<string> {
  switch (field.type) {
    case "id":
      return ticketId(field, row.number);
    case "created_at":
      return String(row.created_at || "").slice(0, 16);
    case "updated_at":
      return String(row.updated_at || "").slice(0, 16);
    case "created_by":
      return row.created_by ? (await names(row.created_by)) : "";
    case "updated_by":
      return row.updated_by ? (await names(row.updated_by)) : "";
    case "checkbox":
      return value === undefined || value === null ? "" : checkboxText(value);
    case "person":
      return (await mapAsync(Array.isArray(value) ? value : value ? [value] : [], async (v) => await names(String(v)))).filter(Boolean).join(", ");
    case "checklist":
      return Array.isArray(value)
        ? value
            .map((item) => (item && typeof item === "object" ? `${(item as { done?: boolean }).done ? "[x]" : "[ ]"} ${String((item as { text?: unknown }).text ?? "")}` : ""))
            .filter(Boolean)
            .join("; ")
        : "";
  }
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.map((v) => (typeof v === "object" ? "" : String(v))).filter(Boolean).join(", ");
  if (typeof value === "object") return "";
  return String(value);
}

export function nameLookup() {
  const cache = new Map<string, string>();
  return async (id: string) => {
    if (!cache.has(id)) cache.set(id, (await one<{ name: string }>("SELECT name FROM users WHERE id=?", id))?.name || "");
    return cache.get(id)!;
  };
}

type RowData = { id: string; page_id: string; cells: string; content: string | null; number: number | null; created_at: string; updated_at: string; created_by: string | null; updated_by: string | null; html: string | null };

// The properties of a record as "Name: value" lines.
export async function recordLines(fields: Field[], cells: Record<string, unknown>, row: Omit<RowData, "cells" | "html" | "content" | "id" | "page_id">, names = nameLookup()) {
  return (await mapAsync(fields
    .slice(1)
    .filter((f) => !SKIPPED.includes(f.type)), async (f) => {
      const text = await cellPlain(f, cells[f.id], row, names);
      return text ? `${f.name}: ${text.slice(0, 2000)}` : "";
    }))
    .filter(Boolean);
}

export const recordTitle = (fields: Field[], cells: Record<string, unknown>) => {
  const v = fields[0] ? cells[fields[0].id] : "";
  return (typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v)).slice(0, 300) || ct("Ohne Titel", "Untitled");
};

const fieldsCache = new Map<string, { at: number; fields: Field[] }>();
async function databaseFields(pageId: string): Promise<Field[]> {
  const hit = fieldsCache.get(pageId);
  if (hit && Date.now() - hit.at < 2000) return hit.fields;
  const stored = await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId);
  const every = stored ? (JSON.parse(stored.fields) as Field[]) : [];
  // The index is shared by everyone: properties with a read rule (and what
  // is derived from them) never go in (lib/field-access.ts).
  const hidden = publicHiddenFieldIds(every);
  const fields = every.filter((f) => f.type === "rollup" || !hidden.has(f.id));
  fieldsCache.set(pageId, { at: Date.now(), fields });
  if (fieldsCache.size > 500) fieldsCache.clear();
  return fields;
}

// Text chunks of a page (rowId empty) or of one record, or null when it is
// gone. Whiteboards contribute their title only.
export async function sourceText(pageId: string, rowId?: string | null, names = nameLookup()): Promise<SourceText | null> {
  const page = await one<{ id: string; title: string; kind: SourceText["kind"] | "notebook" | "dashboard"; deleted_at: string | null }>("SELECT id,title,kind,deleted_at FROM pages WHERE id=?", pageId);
  if (!page || page.deleted_at) return null;
  if (!rowId) {
    if (page.kind === "database") {
      const fields = await databaseFields(pageId);
      const count = Number((await one<{ n: number }>("SELECT count(*) n FROM rows WHERE page_id=?", pageId))?.n || 0);
      return {
        pageId,
        rowId: null,
        title: page.title,
        kind: "database",
        chunks: [`Datenbank „${page.title}“ mit ${count} Einträgen und den Eigenschaften: ${fields.map((f) => f.name).join(", ")}`],
      };
    }
    // Whiteboards: their racks, devices, ports and cables (#90) as text.
    if (page.kind === "whiteboard") {
      const racks = racksText((await whiteboardSnapshotItems({ id: page.id } as Page)).filter((i) => !i.covered), ct);
      return { pageId, rowId: null, title: page.title, kind: "whiteboard", chunks: racks ? chunkPlain(racks) : [] };
    }
    // Notebooks: the text typed or recognised on their sheets.
    if (page.kind === "notebook") return { pageId, rowId: null, title: page.title, kind: "document", chunks: (await notebookText(page.id)).map((text) => text.slice(0, 4000)) };
    const html = (await one<{ html: string | null }>("SELECT html FROM documents WHERE page_id=?", pageId))?.html || "";
    // Tags and property values (#70) as one short chunk before the text.
    const meta = (await pageMetaSearchText(pageId)).slice(0, 1000);
    return { pageId, rowId: null, title: page.title, kind: page.kind as SourceText["kind"], chunks: [...(meta ? [meta] : []), ...chunkHtml(html)] };
  }
  const row = await one<RowData>(
    "SELECT r.id,r.page_id,r.cells,r.content,r.number,r.created_at,r.updated_at,r.created_by,r.updated_by,d.html FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.id=? AND r.page_id=?",
    rowId,
    pageId,
  );
  if (!row) return null;
  const fields = await databaseFields(pageId);
  let cells: Record<string, unknown> = {};
  try {
    cells = JSON.parse(row.cells);
  } catch {}
  const lines = await recordLines(fields, cells, row, names);
  const content = row.html ?? row.content ?? "";
  const body = content.startsWith("<") ? chunkHtml(content) : chunkPlain(content);
  return {
    pageId,
    rowId,
    title: recordTitle(fields, cells),
    pageTitle: page.title,
    kind: "row",
    chunks: [...(lines.length ? chunkParagraphs(lines.map((text) => ({ text }))) : []), ...body],
  };
}

// The record document's plain text (for prompts of AI properties).
export async function recordContent(rowId: string, max = 6000): Promise<string> {
  const row = await one<{ content: string | null; html: string | null }>("SELECT r.content,d.html FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.id=?", rowId);
  const content = row?.html ?? row?.content ?? "";
  return (content.startsWith("<") ? htmlText(content) : content.trim()).slice(0, max);
}

// All pages below (and including) a page.
export async function pageSubtree(pageId: string, limit = 5000): Promise<string[]> {
  return (await all<{ id: string }>(
    "WITH RECURSIVE tree(id,depth) AS (SELECT id,0 FROM pages WHERE id=? UNION ALL SELECT p.id,t.depth+1 FROM pages p JOIN tree t ON p.parent_id=t.id WHERE t.depth<64) SELECT id FROM tree LIMIT ?",
    pageId,
    limit,
  )).map((r) => r.id);
}
