import { mapFileCell } from "./file-cells";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { all, one, run, id, onTransactionRollback } from "./db";
import { requirePage } from "./permissions";
import { cleanHtml } from "./document-server";
import { HttpError } from "./auth";
import type { Identity, Field } from "./types";

type Payload = {
  appearance?: { cover: string; coverPosition: number };
  html?: string;
  database?: { fields: Field[] };
  rows?: { cells: Record<string, unknown>; content?: string }[];
  rowTemplates?: { cells: Record<string, unknown>; html: string }[];
};
const fileId = (url: string) =>
  /^\/api\/files\/([0-9a-f-]{36})(?:[?#].*)?$/i.exec(url)?.[1];
// Visit only rendered HTML attributes and file properties, never arbitrary text.
export function mapTemplateFiles(
  payload: string,
  map: (url: string) => string,
) {
  const data = JSON.parse(payload) as Payload;
  const html = (value: string) =>
    cleanHtml(value, (tagName, attribs) => {
      const attrs = { ...attribs };
      for (const key of ["href", "src"])
        if (attrs[key]) attrs[key] = map(attrs[key]);
      return { tagName, attribs: attrs };
    });
  const cells = (values: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        data.database?.fields.find((f) => f.id === key)?.type === "files"
          ? mapFileCell(value, map)
          : value,
      ]),
    );
  if (data.appearance) data.appearance.cover = map(data.appearance.cover);
  if (typeof data.html === "string") data.html = html(data.html);
  for (const row of data.rows || []) {
    row.content = html(row.content || "");
    row.cells = cells(row.cells);
  }
  for (const row of data.rowTemplates || []) {
    row.html = html(row.html);
    row.cells = cells(row.cells);
  }
  return JSON.stringify(data);
}
export function captureTemplateFiles(
  user: Identity,
  templateId: string,
  payload: string,
) {
  const references = new Set<string>();
  mapTemplateFiles(payload, (url) => {
    const fid = fileId(url);
    if (fid) references.add(fid);
    return url;
  });
  if (references.size > 200)
    throw new HttpError(413, "Höchstens 200 Anhänge je Vorlage.");
  let total = 0;
  for (const fid of references) {
    const file = one<{ page_id: string; name: string; mime: string }>(
      "SELECT * FROM files WHERE id=?",
      fid,
    );
    if (!file) throw new HttpError(409, "Ein Vorlagenanhang fehlt.");
    requirePage(user, file.page_id);
    let bytes: Buffer;
    try {
      bytes = readFileSync(
        resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads", fid),
      );
    } catch {
      throw new HttpError(409, `Anhang „${file.name}“ fehlt auf dem Server.`);
    }
    total += bytes.length;
    if (bytes.length > 10 * 1024 * 1024 || total > 100 * 1024 * 1024)
      throw new HttpError(
        413,
        "Vorlagenanhänge überschreiten 10 MB je Datei oder 100 MB insgesamt.",
      );
    run(
      "INSERT INTO template_files(id,template_id,original_id,name,mime,data) VALUES(?,?,?,?,?,?)",
      id(),
      templateId,
      fid,
      file.name,
      file.mime,
      bytes,
    );
  }
}
export function instantiateTemplateFiles(
  user: Identity,
  pageId: string,
  templateId: string,
  payload: string,
) {
  const files = all<{
    original_id: string;
    name: string;
    mime: string;
    data: Uint8Array;
  }>(
    "SELECT original_id,name,mime,data FROM template_files WHERE template_id=?",
    templateId,
  );
  const mapping = new Map<string, string>();
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
  if (files.length) mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const fid = id(),
      path = resolve(dir, fid);
    // Register before writing so a partial filesystem write is cleaned as well.
    onTransactionRollback(() => {
      try {
        unlinkSync(path);
      } catch {}
    });
    writeFileSync(path, file.data, { flag: "wx" });
    run(
      "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
      fid,
      pageId,
      file.name,
      file.mime,
      file.data.length,
      user.id,
    );
    mapping.set(file.original_id, fid);
  }
  return mapTemplateFiles(payload, (url) => {
    const original = fileId(url);
    return original && mapping.has(original)
      ? url.replace(original, mapping.get(original)!)
      : url;
  });
}
