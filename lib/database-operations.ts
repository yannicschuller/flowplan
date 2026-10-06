import { numberCell } from "./field-format";
import {
  fileIdOf,
  fileRefSchema,
  fileUrls,
  MAX_CELL_FILES,
} from "./file-cells";
import { maintainRowOrders } from "./row-order-server";
import { trashRow } from "./row-trash";
import { validDateValue } from "./date-values";
import { z } from "zod";
import { all, one, run, id } from "./db";
import { requirePage } from "./permissions";
import { rowGrants, rowRoleResolver } from "./row-access";
import { HttpError } from "./auth";
import { replaceRowDocument } from "./row-documents";
import { relationPairs } from "./relation-sync";
import type { Identity, Field, Page, Row } from "./types";
const computed = [
  "formula",
  "rollup",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "id",
];
export function validateCellPatch(
  user: Identity,
  page: Page,
  fields: Field[],
  input: unknown,
) {
  const patch = z.record(z.string(), z.unknown()).parse(input),
    result: Record<string, unknown> = {};
  if (!Object.keys(patch).length)
    throw new HttpError(400, "Mindestens eine Eigenschaft wählen.");
  for (const [key, value] of Object.entries(patch)) {
    const f = fields.find((f) => f.id === key);
    if (!f || computed.includes(f.type))
      throw new HttpError(400, "Eigenschaft kann nicht bearbeitet werden.");
    if (f.type === "number") {
      try {
        result[key] = numberCell(f, value);
      } catch (e) {
        throw new HttpError(400, `${f.name}: ${(e as Error).message}`);
      }
    } else if (f.type === "checkbox") result[key] = z.boolean().parse(value);
    else if (f.type === "multiselect") {
      const values = z.array(z.string()).max(100).parse(value);
      if (values.some((v) => !f.options?.includes(v)))
        throw new HttpError(400, "Unbekannte Auswahl.");
      result[key] = [...new Set(values)];
    } else if (f.type === "checklist")
      result[key] = z
        .array(z.object({ text: z.string().max(500), done: z.boolean() }))
        .max(100)
        .parse(value);
    else if (f.type === "files") {
      const urls = z
        .union([
          z.literal(""),
          fileRefSchema,
          z.array(fileRefSchema).max(MAX_CELL_FILES),
        ])
        .parse(value);
      const list = [...new Set(fileUrls(urls))];
      for (const url of list) {
        const fid = fileIdOf(url);
        if (
          fid &&
          !one("SELECT id FROM files WHERE id=? AND page_id=?", fid, page.id)
        )
          throw new HttpError(400, "Datei gehört nicht zu dieser Datenbank.");
      }
      result[key] = list;
    } else if (f.type === "relation") {
      const ids = z.array(z.string().uuid()).max(500).parse(value);
      if (!f.relationPage && ids.length)
        throw new HttpError(400, "Relationsziel fehlt.");
      if (f.relationPage) {
        requirePage(user, f.relationPage);
        for (const rid of ids)
          if (
            !one(
              "SELECT id FROM rows WHERE id=? AND page_id=?",
              rid,
              f.relationPage,
            )
          )
            throw new HttpError(400, "Verknüpfter Eintrag fehlt.");
      }
      result[key] = [...new Set(ids)];
    } else {
      const text = z.string().max(10000).parse(value);
      if (f.type === "select" && text && !f.options?.includes(text))
        throw new HttpError(400, "Unbekannte Auswahl.");
      if (
        f.type === "person" &&
        text &&
        !one(
          "SELECT user_id FROM members WHERE workspace_id=? AND user_id=?",
          page.workspace_id,
          text,
        )
      )
        throw new HttpError(400, "Mitglied fehlt.");
      if (f.type === "date" && text && !validDateValue(text))
        throw new HttpError(400, "Ungültiges Datum.");
      result[key] = text;
    }
  }
  if (JSON.stringify(result).length > 200000)
    throw new HttpError(413, "Änderung zu groß.");
  return result;
}
// Automatic database version at the start of an editing session: the first
// edit after 10 quiet minutes keeps the previous state.
export function autoDatabaseSnapshot(user: Identity, page: Page) {
  const recent = one(
    `SELECT 1 WHERE EXISTS(SELECT 1 FROM snapshots WHERE page_id=? AND created_at>datetime('now','-10 minutes'))
       OR EXISTS(SELECT 1 FROM pages WHERE id=? AND updated_at>datetime('now','-10 minutes'))
       OR EXISTS(SELECT 1 FROM rows WHERE page_id=? AND updated_at>datetime('now','-10 minutes'))`,
    page.id,
    page.id,
    page.id,
  );
  if (!recent) databaseSnapshot(user, page);
}
export function databaseSnapshot(user: Identity, page: Page) {
  const db = one<{ fields: string; views: string; record_layout: string }>(
    "SELECT fields,views,record_layout FROM databases WHERE page_id=?",
    page.id,
  )!;
  const rows = all<Row & { cells: string }>(
    "SELECT * FROM rows WHERE page_id=? ORDER BY position",
    page.id,
  ).map((r) => ({
    ...r,
    cells: JSON.parse(r.cells),
    ...(r.access && r.access !== "inherit" ? { grants: rowGrants(r.id) } : {}),
  }));
  const snapshotId = id();
  run(
    "INSERT INTO snapshots(id,page_id,html,title,created_by) VALUES(?,?,?,?,?)",
    snapshotId,
    page.id,
    JSON.stringify({
      database: {
        fields: JSON.parse(db.fields),
        views: JSON.parse(db.views),
        recordLayout: JSON.parse(db.record_layout || "{}"),
      },
      relationPairs: relationPairs(page.id),
      rows,
      comments: all("SELECT * FROM comments WHERE page_id=?", page.id),
      inlineThreads: exportInlineComments(page.id),
      rowTemplates: all<{
        name: string;
        cells: string;
        html: string;
        is_default: number;
      }>(
        "SELECT name,cells,html,is_default FROM row_templates WHERE page_id=?",
        page.id,
      ).map((t) => ({ ...t, cells: JSON.parse(t.cells) })),
      formConfig: JSON.parse(
        String(
          one("SELECT config FROM forms WHERE page_id=?", page.id)?.config ||
            "{}",
        ),
      ),
    }),
    page.title,
    user.id,
  );
  return snapshotId;
}
export function bulkRows(
  user: Identity,
  pageId: string,
  input: Record<string, unknown>,
) {
  const page = requirePage(user, pageId, true);
  if (page.locked) throw new HttpError(409, "Datenbank ist gesperrt.");
  if (page.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  const operation = z
      .enum(["update", "duplicate", "delete"])
      .parse(input.operation),
    selected = z
      .array(
        z.object({ id: z.string().uuid(), version: z.number().int().min(1) }),
      )
      .min(1)
      .max(500)
      .parse(input.rows);
  if (new Set(selected.map((r) => r.id)).size !== selected.length)
    throw new HttpError(400, "Doppelte Einträge in der Auswahl.");
  const access = rowRoleResolver(user, page);
  const source = selected.map((selection) => {
    const row = one<Row & { cells: string }>(
      "SELECT * FROM rows WHERE id=? AND page_id=?",
      selection.id,
      pageId,
    );
    const role = row && access(row);
    if (!row || !role) throw new HttpError(404, "Eintrag nicht gefunden.");
    if (operation !== "duplicate" && role === "viewer")
      throw new HttpError(
        403,
        "Mindestens ein ausgewählter Eintrag ist für dich schreibgeschützt.",
      );
    if (row.version !== selection.version)
      throw new HttpError(
        409,
        "Mindestens ein ausgewählter Eintrag wurde geändert. Bitte Auswahl erneuern.",
      );
    return row;
  });
  const db = one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      pageId,
    )!,
    fields: Field[] = JSON.parse(db.fields);
  const patch =
    operation === "update"
      ? validateCellPatch(user, page, fields, input.cells)
      : null;
  const snapshotId = databaseSnapshot(user, page),
    mapping = new Map(source.map((r) => [r.id, id()]));
  for (const row of source) {
    if (operation === "update") {
      const cells = { ...JSON.parse(row.cells), ...patch };
      if (JSON.stringify(cells).length > 200000)
        throw new HttpError(413, "Datensatz zu groß.");
      run(
        "UPDATE rows SET cells=?,updated_at=CURRENT_TIMESTAMP,updated_by=?,version=version+1 WHERE id=?",
        JSON.stringify(cells),
        user.id,
        row.id,
      );
    } else if (operation === "delete") {
      trashRow(user, page, row.id);
    } else {
      const cells = JSON.parse(row.cells);
      for (const f of fields)
        if (f.type === "relation" && Array.isArray(cells[f.id]))
          cells[f.id] = cells[f.id].map(
            (rid: string) => mapping.get(rid) || rid,
          );
      const rid = mapping.get(row.id)!;
      run(
        "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,icon,cover,recurrence,access) VALUES(?,?,?,?,?,?,?,?,?,?)",
        rid,
        pageId,
        JSON.stringify(cells),
        row.position + 0.5,
        user.id,
        user.id,
        row.icon || "",
        row.cover || "",
        row.recurrence || "",
        row.access || "inherit",
      );
      // Copies keep the record permissions of their original.
      run(
        "INSERT INTO row_grants(row_id,user_id,group_id,role) SELECT ?,user_id,group_id,role FROM row_grants WHERE row_id=?",
        rid,
        row.id,
      );
      const html = String(
        one("SELECT html FROM row_documents WHERE row_id=?", row.id)?.html ||
          row.content ||
          "",
      );
      replaceRowDocument(rid, html, user.id);
    }
  }
  run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", pageId);
  if (operation !== "update")
    maintainRowOrders(pageId, operation === "duplicate" ? mapping : undefined);
  return {
    count: source.length,
    snapshotId,
    ...(operation === "duplicate" ? { ids: [...mapping.values()] } : {}),
  };
}
import { exportInlineComments } from "./inline-comment-archive";
