// What of a page, record or database view goes into a prompt – loaded on the
// server, after the AI read check (lib/ai/access.ts), never taken from the
// browser. Pages and records come as Markdown (the Markdown export), records
// of a database view as a compact list of their properties.
import { visibleFields } from "../field-access";
import { HttpError } from "../auth";
import { all, one } from "../db";
import { exportMarkdown, computedTypes } from "../markdown-export";
import { database, rows as databaseRows } from "../api";
import { visibleRows } from "../row-access";
import { cellText } from "../cell-text";
import type { Field, Identity, Page, Row } from "../types";
import { aiFilter, requireAiRead } from "./access";

// A page (without its title heading) or one record of a database
// (properties as frontmatter, then the document) as Markdown.
export async function aiPageMarkdown(user: Identity, page: Page, rowId?: string | null) {
  requireAiRead(user, page.id, rowId);
  const { bytes } = await exportMarkdown(user, {
    pageId: page.id,
    ...(rowId ? { rowId } : {}),
    format: "markdown",
    includeSubpages: false,
    forAi: true,
  });
  const markdown = Buffer.from(bytes as Uint8Array).toString("utf8").trim();
  // A page's title heading goes separately (prompts name it).
  return rowId ? markdown : markdown.replace(/^# [^\n]*(?:\n|$)/, "").trim();
}

// Plain text of stored document HTML (record documents in a database
// summary): blocks on lines of their own.
export function htmlText(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<li[^>]*data-checked="true"[^>]*>/gi, "\n- [x] ")
    .replace(/<li[^>]*data-checked="false"[^>]*>/gi, "\n- [ ] ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|h[1-6]|div|blockquote|pre|tr|aside|details)>|<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type DatabaseText = {
  text: string;
  // Records in the prompt / records asked for (the view) / readable for
  // the AI among them.
  included: number;
  total: number;
  readable: number;
};

// Records of a database view: the ids in the view's order (filters and
// sorting as the person sees them), or every visible record. Only records
// the person may see and the AI may read; at most `maxRecords` and about
// `maxChars` characters.
export function aiDatabaseText(
  user: Identity,
  page: Page,
  rowIds: string[] | undefined,
  limits: { maxRecords: number; maxChars: number; documentChars: number },
): DatabaseText {
  requireAiRead(user, page.id);
  if (page.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  const fields = visibleFields(user, page, database(page.id).fields as Field[]);
  const visible = visibleRows(user, page, databaseRows(page.id));
  const byId = new Map(visible.map((row) => [row.id, row]));
  const asked: Row[] = rowIds ? [...new Set(rowIds)].flatMap((id) => byId.get(id) || []) : visible;
  const readable = aiFilter(
    user,
    asked.map((row) => ({ pageId: page.id, rowId: row.id, row })),
  ).map((item) => item.row);
  const members = new Map(
    all<{ id: string; name: string }>(
      "SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?",
      page.workspace_id,
    ).map((m) => [m.id, m.name]),
  );
  const titleField = fields[0];
  const shown = fields.filter((field, i) => i > 0 && !computedTypes.includes(field.type) && field.type !== "files" && field.type !== "sprint");
  // Titles of related records – only those the AI may read as well.
  const references: { pageId: string; rowId: string }[] = [];
  for (const row of readable.slice(0, limits.maxRecords))
    for (const field of shown)
      if (field.type === "relation" && field.relationPage)
        for (const id of [row.cells[field.id]].flat())
          if (typeof id === "string" && id) references.push({ pageId: field.relationPage, rowId: id });
  const relatedTitles = new Map<string, string>();
  for (const ref of aiFilter(user, references.slice(0, 5000))) {
    if (relatedTitles.has(ref.rowId)) continue;
    const target = one<{ cells: string }>("SELECT cells FROM rows WHERE id=? AND page_id=?", ref.rowId, ref.pageId);
    const targetFields = one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", ref.pageId);
    if (!target || !targetFields) continue;
    const first = (JSON.parse(targetFields.fields) as Field[])[0];
    relatedTitles.set(ref.rowId, cellText(JSON.parse(target.cells)[first?.id || "title"]) || "–");
  }
  const value = (row: Row, field: Field) => {
    const raw = row.cells[field.id];
    if (raw === null || raw === undefined || raw === "" || raw === "#ACCESS" || (Array.isArray(raw) && !raw.length)) return "";
    if (field.type === "checkbox") return raw ? "yes" : "no";
    if (field.type === "person") return [raw].flat().map((id) => members.get(String(id)) || "").filter(Boolean).join(", ");
    if (field.type === "relation") return [raw].flat().map((id) => relatedTitles.get(String(id)) || "").filter(Boolean).join(", ");
    return cellText(raw).replace(/\s+/g, " ").slice(0, 500);
  };
  const documents = new Map<string, string>();
  const ids = readable.slice(0, limits.maxRecords).map((row) => row.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const doc of all<{ row_id: string; html: string }>(
      `SELECT row_id,html FROM row_documents WHERE row_id IN (${chunk.map(() => "?").join(",")})`,
      ...chunk,
    ))
      documents.set(doc.row_id, doc.html);
  }
  const parts: string[] = [];
  let size = 0;
  for (const row of readable.slice(0, limits.maxRecords)) {
    const lines = [`### ${cellText(row.cells[titleField?.id || "title"]).replace(/\s+/g, " ").trim() || "–"}`];
    for (const field of shown) {
      const text = value(row, field);
      if (text) lines.push(`- ${field.name}: ${text}`);
    }
    const body = htmlText(documents.get(row.id) ?? row.content ?? "");
    if (body) lines.push(body.length > limits.documentChars ? body.slice(0, limits.documentChars) + " …" : body);
    const part = lines.join("\n");
    if (parts.length && size + part.length > limits.maxChars) break;
    parts.push(part);
    size += part.length + 2;
  }
  return { text: parts.join("\n\n"), included: parts.length, total: asked.length, readable: readable.length };
}
