// Copying or moving records into another database of the workspace.
// Properties are matched by name (and the first property, the title, always
// with the title); values are converted where the types fit (text ↔ e-mail,
// select ↔ multi-select, number → text …), missing choices are added to the
// target, and properties the target lacks can be created. A copy gets new
// records with their content and files; a move keeps the record itself –
// content, comments, versions, time and Git links travel with it – and
// gives it a number in the new database.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { assertRowAccess } from "./row-access";
import { replaceRowDocument } from "./row-documents";
import { maintainRowOrders } from "./row-order-server";
import { rowCreated } from "./automations";
import { cellText } from "./cell-text";
import type { Field, Identity, Page, Row } from "./types";

const input = z.object({
  rowIds: z.array(z.uuid()).min(1).max(500),
  targetPageId: z.uuid(),
  mode: z.enum(["copy", "move"]),
  // Create properties the target does not have yet (same name and type).
  addMissing: z.boolean().default(true),
});

const NOT_COPIED = new Set<Field["type"]>(["formula", "rollup", "created_at", "updated_at", "created_by", "updated_by", "id", "progress", "sprint"]);
const TEXTLIKE = new Set<Field["type"]>(["text", "url", "email", "phone"]);
const fieldsOf = (pageId: string) => JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)!.fields) as Field[];
const dataDir = () => resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
const FILE_URL = /\/api\/files\/([0-9a-f-]{36})/gi;

// Where a source property goes in the target (or null).
function match(source: Field, target: Field[], isTitle: boolean) {
  if (isTitle) return target[0];
  const same = target.filter((f) => f.name.trim().toLowerCase() === source.name.trim().toLowerCase() && !NOT_COPIED.has(f.type) && !f.parent);
  return same.find((f) => f.type === source.type) || same.find((f) => compatible(source.type, f.type)) || null;
}
function compatible(from: Field["type"], to: Field["type"]) {
  if (from === to) return true;
  if (to === "text") return TEXTLIKE.has(from) || ["number", "select", "multiselect", "date", "checkbox"].includes(from);
  if (TEXTLIKE.has(from) && TEXTLIKE.has(to)) return false;
  if ((from === "select" && to === "multiselect") || (from === "multiselect" && to === "select")) return true;
  if (from === "text" && to === "number") return true;
  return false;
}
// The value for the target property; options missing there are collected.
function convert(value: unknown, from: Field, to: Field, addOption: (f: Field, o: string) => void): unknown {
  if (value === undefined || value === null || value === "") return undefined;
  const options = (list: string[]) => list.forEach((o) => !to.options?.includes(o) && addOption(to, o));
  switch (to.type) {
    case "select": {
      const v = Array.isArray(value) ? String(value[0] ?? "") : String(value);
      if (!v) return undefined;
      options([v]);
      return v;
    }
    case "multiselect": {
      const list = (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
      options(list);
      return list;
    }
    case "text":
      return from.type === "checkbox" ? (value ? "✓" : "") : cellText(value);
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
      return Number.isFinite(n) ? n : undefined;
    }
    case "relation":
      // Same target database only; parents of subtasks do not carry over.
      return from.relationPage === to.relationPage && !from.parent && !to.parent && Array.isArray(value) ? value : undefined;
    default:
      return value;
  }
}

function nextNumber(pageId: string) {
  run(
    "INSERT INTO row_counters(page_id,last) VALUES(?,(SELECT COALESCE(MAX(number),0) FROM rows WHERE page_id=?)) ON CONFLICT(page_id) DO NOTHING",
    pageId,
    pageId,
  );
  run("UPDATE row_counters SET last=last+1 WHERE page_id=?", pageId);
  return one<{ last: number }>("SELECT last FROM row_counters WHERE page_id=?", pageId)!.last;
}

// Duplicates a file for the target database (a copy must not depend on the
// source's permissions); without the local file the reference stays.
function copyFile(fileId: string, target: Page, userId: string) {
  const file = one<{ id: string; name: string; mime: string; size: number }>("SELECT id,name,mime,size FROM files WHERE id=?", fileId);
  const from = resolve(dataDir(), fileId);
  if (!file || !existsSync(from)) return fileId;
  const fresh = id();
  mkdirSync(dataDir(), { recursive: true });
  copyFileSync(from, resolve(dataDir(), fresh));
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fresh, target.id, file.name, file.mime, file.size, userId);
  return fresh;
}

export function transferRows(user: Identity, sourcePageId: string, raw: unknown) {
  const b = input.parse(raw);
  const source = requirePage(user, sourcePageId, b.mode === "move");
  const target = requirePage(user, b.targetPageId, true);
  if (source.kind !== "database" || target.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  if (source.id === target.id) throw new HttpError(400, "Bitte eine andere Datenbank wählen.");
  if (source.workspace_id !== target.workspace_id) throw new HttpError(400, "Nur innerhalb eines Arbeitsbereichs.");
  if (target.locked || (b.mode === "move" && source.locked)) throw new HttpError(409, "Diese Seite ist gesperrt.");
  const sourceFields = fieldsOf(source.id);
  const targetFields = fieldsOf(target.id);
  // Properties the target lacks, created on request.
  const created: string[] = [];
  const mapping = new Map<string, Field>();
  sourceFields.forEach((f, i) => {
    if (NOT_COPIED.has(f.type) || f.parent) return;
    let to = match(f, targetFields, i === 0);
    if (!to && b.addMissing && !["relation", "time"].includes(f.type) && targetFields.length < 80) {
      to = { id: `t${id().slice(0, 7)}`, name: f.name, type: f.type, ...(f.options ? { options: [...f.options] } : {}), ...(f.format ? { format: f.format } : {}), ...(f.decimals !== undefined ? { decimals: f.decimals } : {}) };
      targetFields.push(to);
      created.push(f.name);
    }
    if (to) mapping.set(f.id, to);
  });
  let optionsAdded = false;
  const addOption = (f: Field, o: string) => {
    f.options = [...(f.options || []), o].slice(0, 100);
    optionsAdded = true;
  };
  const rows = b.rowIds.map((rid) => {
    const row = one<Row & { cells: string }>("SELECT * FROM rows WHERE id=? AND page_id=?", rid, source.id);
    if (!row) throw new HttpError(404, "Eintrag nicht gefunden.");
    assertRowAccess(user, source, row, b.mode === "move");
    return row;
  });
  const results: string[] = [];
  let position = (one<{ p: number }>("SELECT COALESCE(MAX(position),0) p FROM rows WHERE page_id=?", target.id)?.p || 0) + 1;
  for (const row of rows) {
    const cells: Record<string, unknown> = {};
    const old = JSON.parse(row.cells as unknown as string) as Record<string, unknown>;
    for (const [fid, to] of mapping) {
      const from = sourceFields.find((f) => f.id === fid)!;
      const value = convert(old[fid], from, to, addOption);
      if (value !== undefined) cells[to.id] = value;
    }
    const html = String(one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", row.id)?.html ?? row.content ?? "");
    const fileIds = new Set([...JSON.stringify(cells).matchAll(FILE_URL), ...html.matchAll(FILE_URL)].map((m) => m[1].toLowerCase()));
    if (b.mode === "copy") {
      // New files for the copy, and the references changed accordingly.
      const swap = new Map([...fileIds].map((f) => [f, copyFile(f, target, user.id)]));
      const rewrite = (text: string) => text.replace(FILE_URL, (all, f: string) => `/api/files/${swap.get(f.toLowerCase()) || f}`);
      const rid = id();
      run(
        "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content,icon,cover,recurrence) VALUES(?,?,?,?,?,?,?,?,?,?)",
        rid,
        target.id,
        rewrite(JSON.stringify(cells)),
        position++,
        user.id,
        user.id,
        rewrite(html),
        row.icon || "",
        row.cover || "",
        row.recurrence || "",
      );
      if (html) replaceRowDocument(rid, rewrite(html), user.id);
      results.push(rid);
    } else {
      run(
        "UPDATE rows SET page_id=?,cells=?,position=?,number=?,version=version+1,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
        target.id,
        JSON.stringify(cells),
        position++,
        nextNumber(target.id),
        user.id,
        row.id,
      );
      // Everything that belongs to the record moves along.
      for (const table of ["comments", "notifications", "shared_comments", "inline_threads", "row_favorites", "time_entries", "git_links", "tickets", "doc_tasks"])
        run(`UPDATE ${table} SET page_id=? WHERE row_id=? AND page_id=?`, target.id, row.id, source.id);
      // Time entries follow their property, if it was carried over.
      for (const [fid, to] of mapping) run("UPDATE time_entries SET field_id=? WHERE row_id=? AND field_id=?", to.id, row.id, fid);
      for (const table of ["date_reminders", "editor_presence", "row_status_log"]) run(`DELETE FROM ${table} WHERE row_id=? AND page_id=?`, row.id, source.id);
      if (fileIds.size) run(`UPDATE files SET page_id=? WHERE page_id=? AND id IN (${[...fileIds].map(() => "?").join(",")})`, target.id, source.id, ...fileIds);
      results.push(row.id);
    }
  }
  if (created.length || optionsAdded)
    run("UPDATE databases SET fields=?,version=version+1 WHERE page_id=?", JSON.stringify(targetFields), target.id);
  run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id IN (?,?)", source.id, target.id);
  maintainRowOrders(target.id);
  if (b.mode === "move") maintainRowOrders(source.id);
  for (const rid of results) rowCreated(user, target, rid);
  return { ids: results, created, target: target.id, count: results.length };
}

// Databases a person can move or copy records into (same workspace).
export function transferTargets(user: Identity, pageId: string) {
  const page = requirePage(user, pageId);
  return all<{ id: string; title: string; icon: string }>(
    "SELECT id,title,icon FROM pages WHERE workspace_id=? AND kind='database' AND deleted_at IS NULL AND id!=? ORDER BY title",
    page.workspace_id,
    page.id,
  ).filter((p) => {
    try {
      requirePage(user, p.id, true);
      return true;
    } catch {
      return false;
    }
  });
}
