// What a page or a record says, as text chunks for the AI ("ask" and the
// semantic index). This module only reads; whether the AI may read a source
// is decided elsewhere (lib/ai/access.ts) – callers check before using it.
import { all, one } from "../db";
import { ticketId } from "../ticket-ids";
import type { Field } from "../types";
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
const SKIPPED: Field["type"][] = ["relation", "rollup", "formula", "files", "progress", "time", "sprint"];

const checkboxText = (v: unknown) => (v === true ? "ja" : "nein");
// A property value as people read it (persons by name).
export function cellPlain(field: Field, value: unknown, row: { number?: number | null; created_at?: string; updated_at?: string; created_by?: string | null; updated_by?: string | null }, names: (id: string) => string): string {
  switch (field.type) {
    case "id":
      return ticketId(field, row.number);
    case "created_at":
      return String(row.created_at || "").slice(0, 16);
    case "updated_at":
      return String(row.updated_at || "").slice(0, 16);
    case "created_by":
      return row.created_by ? names(row.created_by) : "";
    case "updated_by":
      return row.updated_by ? names(row.updated_by) : "";
    case "checkbox":
      return value === undefined || value === null ? "" : checkboxText(value);
    case "person":
      return (Array.isArray(value) ? value : value ? [value] : []).map((v) => names(String(v))).filter(Boolean).join(", ");
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
  return (id: string) => {
    if (!cache.has(id)) cache.set(id, one<{ name: string }>("SELECT name FROM users WHERE id=?", id)?.name || "");
    return cache.get(id)!;
  };
}

type RowData = { id: string; page_id: string; cells: string; content: string | null; number: number | null; created_at: string; updated_at: string; created_by: string | null; updated_by: string | null; html: string | null };

// The properties of a record as "Name: value" lines.
export function recordLines(fields: Field[], cells: Record<string, unknown>, row: Omit<RowData, "cells" | "html" | "content" | "id" | "page_id">, names = nameLookup()) {
  return fields
    .slice(1)
    .filter((f) => !SKIPPED.includes(f.type))
    .map((f) => {
      const text = cellPlain(f, cells[f.id], row, names);
      return text ? `${f.name}: ${text.slice(0, 2000)}` : "";
    })
    .filter(Boolean);
}

export const recordTitle = (fields: Field[], cells: Record<string, unknown>) => {
  const v = fields[0] ? cells[fields[0].id] : "";
  return (typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v)).slice(0, 300) || "Ohne Titel";
};

const fieldsCache = new Map<string, { at: number; fields: Field[] }>();
function databaseFields(pageId: string): Field[] {
  const hit = fieldsCache.get(pageId);
  if (hit && Date.now() - hit.at < 2000) return hit.fields;
  const stored = one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId);
  const fields = stored ? (JSON.parse(stored.fields) as Field[]) : [];
  fieldsCache.set(pageId, { at: Date.now(), fields });
  if (fieldsCache.size > 500) fieldsCache.clear();
  return fields;
}

// Text chunks of a page (rowId empty) or of one record, or null when it is
// gone. Whiteboards contribute their title only.
export function sourceText(pageId: string, rowId?: string | null, names = nameLookup()): SourceText | null {
  const page = one<{ id: string; title: string; kind: SourceText["kind"]; deleted_at: string | null }>("SELECT id,title,kind,deleted_at FROM pages WHERE id=?", pageId);
  if (!page || page.deleted_at) return null;
  if (!rowId) {
    if (page.kind === "database") {
      const fields = databaseFields(pageId);
      const count = Number(one<{ n: number }>("SELECT count(*) n FROM rows WHERE page_id=?", pageId)?.n || 0);
      return {
        pageId,
        rowId: null,
        title: page.title,
        kind: "database",
        chunks: [`Datenbank „${page.title}“ mit ${count} Einträgen und den Eigenschaften: ${fields.map((f) => f.name).join(", ")}`],
      };
    }
    if (page.kind === "whiteboard") return { pageId, rowId: null, title: page.title, kind: "whiteboard", chunks: [] };
    const html = one<{ html: string | null }>("SELECT html FROM documents WHERE page_id=?", pageId)?.html || "";
    return { pageId, rowId: null, title: page.title, kind: page.kind, chunks: chunkHtml(html) };
  }
  const row = one<RowData>(
    "SELECT r.id,r.page_id,r.cells,r.content,r.number,r.created_at,r.updated_at,r.created_by,r.updated_by,d.html FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.id=? AND r.page_id=?",
    rowId,
    pageId,
  );
  if (!row) return null;
  const fields = databaseFields(pageId);
  let cells: Record<string, unknown> = {};
  try {
    cells = JSON.parse(row.cells);
  } catch {}
  const lines = recordLines(fields, cells, row, names);
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
export function recordContent(rowId: string, max = 6000): string {
  const row = one<{ content: string | null; html: string | null }>("SELECT r.content,d.html FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.id=?", rowId);
  const content = row?.html ?? row?.content ?? "";
  return (content.startsWith("<") ? htmlText(content) : content.trim()).slice(0, max);
}

// All pages below (and including) a page.
export function pageSubtree(pageId: string, limit = 5000): string[] {
  return all<{ id: string }>(
    "WITH RECURSIVE tree(id,depth) AS (SELECT id,0 FROM pages WHERE id=? UNION ALL SELECT p.id,t.depth+1 FROM pages p JOIN tree t ON p.parent_id=t.id WHERE t.depth<64) SELECT id FROM tree LIMIT ?",
    pageId,
    limit,
  ).map((r) => r.id);
}
