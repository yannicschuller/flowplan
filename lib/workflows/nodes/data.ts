// The common output types of workflow nodes (docs/specs/workflows.md §6):
// record, page and person, as the person a run runs as may see them –
// properties with a read rule they may not read are left out.
import { all, one } from "../../db";
import { computedCells } from "../../database";
import { hiddenFieldsFor } from "../../field-access";
import { cellText } from "../../cell-text";
import { recordUrl } from "../../notification-events";
import { plainText } from "../placeholders";
import type { Field, Identity, Page, Row } from "../../types";

export type PersonValue = { id: string; name: string; email?: string };
export type PageRef = { id: string; title: string; url: string };
export type PageValue = PageRef & {
  link: { type: "page"; id: string; title: string; url: string };
  kind: string;
  parent: PageRef | null;
  space: { id: string; name: string } | null;
  tags: string[];
  text: string;
  createdAt: string | null;
  createdBy: PersonValue | null;
  updatedAt: string | null;
};
export type RecordValue = {
  id: string;
  url: string;
  title: string;
  number: number | null;
  database: PageRef;
  fields: Record<string, unknown>;
  createdAt: string | null;
  createdBy: PersonValue | null;
  updatedAt: string | null;
};

const iso = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return new Date(v).toISOString();
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
};

// A person; the address only for members of the workspace (as in the member list).
export async function personValue(userId: string | null | undefined, workspaceId?: string): Promise<PersonValue | null> {
  if (!userId) return null;
  const u = await one<{ id: string; name: string; email: string }>("SELECT id,name,email FROM users WHERE id=?", userId);
  if (!u) return null;
  const member = workspaceId ? await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", workspaceId, userId) : null;
  return { id: u.id, name: u.name, ...(member ? { email: u.email } : {}) };
}
export const pageRef = (p: Pick<Page, "id" | "title">): PageRef => ({ id: p.id, title: p.title || "", url: recordUrl(p.id) });

export async function databaseFields(pageId: string): Promise<Field[]> {
  const raw = await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId);
  return raw ? (JSON.parse(raw.fields) as Field[]) : [];
}

export async function pageValue(pageId: string, options: { text?: boolean } = {}): Promise<PageValue | null> {
  const p = await one<Page & { created_at?: string | null }>("SELECT * FROM pages WHERE id=?", pageId);
  if (!p) return null;
  const parent = p.parent_id ? await one<Page>("SELECT id,title FROM pages WHERE id=?", p.parent_id) : undefined;
  const space = await one<{ id: string; name: string }>("SELECT id,name FROM spaces WHERE id=?", p.space_id);
  const tags = (await all<{ name: string }>("SELECT t.name FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? ORDER BY l.position,t.name", p.id)).map((t) => t.name);
  let text = "";
  if (options.text !== false) {
    const doc = await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", p.id);
    text = plainText(doc?.html || "").slice(0, 50_000);
  }
  const ref = pageRef(p);
  return {
    ...ref,
    link: { type: "page", ...ref },
    kind: p.kind,
    parent: parent ? pageRef(parent) : null,
    space: space ? { id: space.id, name: space.name } : null,
    tags,
    text,
    createdAt: iso(p.created_at),
    createdBy: await personValue(p.created_by, p.workspace_id),
    updatedAt: iso(p.updated_at),
  };
}

// A record as `who` sees it (computed properties included, hidden ones left out).
export async function recordValue(who: Identity | null, rowId: string, override?: Record<string, unknown>): Promise<RecordValue | null> {
  const raw = await one<Row & { cells: string; number: number | null; created_at: string; updated_at: string }>("SELECT * FROM rows WHERE id=?", rowId);
  if (!raw) return null;
  const db = await one<Page>("SELECT * FROM pages WHERE id=?", raw.page_id);
  if (!db) return null;
  const fields = await databaseFields(db.id);
  const row: Row = { ...raw, cells: { ...JSON.parse(raw.cells), ...(override || {}) } };
  const cells = computedCells(row, fields);
  const hidden = who ? await hiddenFieldsFor(who, db, fields) : new Set<string>();
  const shown: Record<string, unknown> = {};
  for (const f of fields) if (!hidden.has(f.id)) shown[f.id] = cells[f.id] ?? null;
  return {
    id: row.id,
    url: recordUrl(db.id, row.id),
    title: cellText(cells[fields[0]?.id || "title"]).trim(),
    number: raw.number ?? null,
    database: pageRef(db),
    fields: shown,
    createdAt: iso(raw.created_at),
    createdBy: await personValue(raw.created_by, db.workspace_id),
    updatedAt: iso(raw.updated_at),
  };
}

// An id from a value: a text id, or an object with one (a record, a page, a person).
export function refId(value: unknown): string | null {
  if (typeof value === "string") {
    const m = /#page=([0-9a-f-]{36})(?:&row=([0-9a-f-]{36}))?/i.exec(value);
    if (m) return m[2] || m[1];
    return value.trim() || null;
  }
  if (Array.isArray(value)) return refId(value[0]);
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  return null;
}
