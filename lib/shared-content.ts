import { createHash } from "node:crypto";
import { z } from "zod";
import * as Y from "yjs";
import { all, one, run, id, transaction, audit } from "./db";
import { HttpError } from "./auth";
import { publicPage, publicFile, publishedHtml } from "./publication";
import { cleanHtml, htmlState, stateHtml } from "./document-server";
import { ensureRowDocument } from "./row-documents";
import type { Field, Row } from "./types";

export const publicField = (f: Field) =>
  ![
    "person",
    "created_by",
    "updated_by",
    "relation",
    "files",
    "formula",
    "rollup",
  ].includes(f.type);
export const writablePublicField = (f: Field) =>
  publicField(f) && !["created_at", "updated_at"].includes(f.type);
export type SharedComment = {
  id: string;
  name: string;
  body: string;
  resolved: number;
  created_at: string;
};
function source(token: string, pageId?: string, rowId?: string) {
  const context = publicPage(token, pageId);
  const { page } = context;
  const row = rowId
    ? one<Row>("SELECT * FROM rows WHERE id=? AND page_id=?", rowId, page.id)
    : undefined;
  if (rowId && !row) throw new HttpError(404, "Datensatz nicht gefunden.");
  const doc = row
    ? ensureRowDocument(row)
    : one<{ html: string; state: Uint8Array | null; generation: string }>(
        "SELECT * FROM documents WHERE page_id=?",
        page.id,
      );
  const fields: Field[] =
    page.kind === "database"
      ? JSON.parse(
          String(
            one("SELECT fields FROM databases WHERE page_id=?", page.id)
              ?.fields || "[]",
          ),
        )
      : [];
  const cells: Record<string, unknown> = row
    ? JSON.parse(String(row.cells))
    : {};
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        page.title,
        doc?.html,
        doc?.generation,
        row?.version,
        cells,
        fields,
      ]),
    )
    .digest("hex");
  return { ...context, row, doc, fields, cells, version };
}
export function sharedContent(token: string, pageId?: string, rowId?: string) {
  const s = source(token, pageId, rowId);
  const fields = s.fields.filter(publicField);
  return {
    pageId: s.page.id,
    rowId,
    role: s.role,
    locked: !!s.page.locked,
    title: s.page.title,
    html: publishedHtml(s.doc?.html || "", token, s.pages),
    version: s.version,
    canEditContent: s.page.kind === "document" || !!s.row,
    // Guests with edit rights may add records named by the title property.
    titleField:
      s.page.kind === "database" &&
      !s.row &&
      s.fields[0] &&
      writablePublicField(s.fields[0])
        ? s.fields[0].id
        : undefined,
    fields: s.row ? fields : [],
    cells: s.row
      ? Object.fromEntries(fields.map((f) => [f.id, s.cells[f.id] ?? null]))
      : {},
    comments: all<SharedComment>(
      "SELECT id,name,body,resolved,created_at FROM shared_comments WHERE page_id=? AND row_id IS ? ORDER BY created_at,id LIMIT 500",
      s.page.id,
      rowId || null,
    ),
  };
}
function validatedCells(
  input: unknown,
  fields: Field[],
  current: Record<string, unknown>,
) {
  const patch = z.record(z.string(), z.unknown()).parse(input);
  const cells = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const f = fields.find((f) => f.id === key && writablePublicField(f));
    if (!f)
      throw new HttpError(
        403,
        "Diese Eigenschaft kann über diesen Link nicht geändert werden.",
      );
    if (f.type === "number")
      cells[key] = z.number().finite().nullable().parse(value);
    else if (f.type === "checkbox") cells[key] = z.boolean().parse(value);
    else if (f.type === "multiselect") {
      const values = z.array(z.string()).max(100).parse(value);
      if (values.some((v) => !f.options?.includes(v)))
        throw new HttpError(400, "Ungültige Auswahl.");
      cells[key] = values;
    } else if (f.type === "checklist")
      cells[key] = z
        .array(z.object({ text: z.string().max(500), done: z.boolean() }))
        .max(100)
        .parse(value);
    else {
      const text = z
        .string()
        .max(10000)
        .parse(value ?? "");
      if (f.type === "select" && text && !f.options?.includes(text))
        throw new HttpError(400, "Ungültige Auswahl.");
      cells[key] = text;
    }
  }
  return cells;
}
function writableHtml(
  html: string,
  token: string,
  pages: { id: string }[],
  original: string,
) {
  const linked = new Map<string, Record<string, string>>();
  cleanHtml(original, (tagName, attribs) => {
    if (attribs["data-linked-database"])
      linked.set(attribs["data-linked-database"], attribs);
    return { tagName, attribs };
  });
  const seen = new Set<string>();
  return cleanHtml(html, (tagName, attribs) => {
    let attrs = { ...attribs };
    if (attrs["data-linked-database"]) {
      const id = attrs["data-linked-database"];
      if (!linked.has(id) || seen.has(id))
        throw new HttpError(403, "Einbettung nicht freigegeben.");
      seen.add(id);
      attrs = { ...linked.get(id)! };
    }
    delete attrs["data-mention"];
    for (const attr of ["href", "src"]) {
      const value = attrs[attr];
      if (!value) continue;
      // Only this link's already published files and pages can become internal references.
      const file = new RegExp(`^/api/share/${token}/files/([\\w-]+)$`).exec(
        value,
      );
      if (file) {
        publicFile(token, file[1]);
        attrs[attr] = `/api/files/${file[1]}`;
      } else if (value.startsWith(`/share/${token}`)) {
        const target =
          value === `/share/${token}`
            ? pages[0]?.id
            : value.slice(`/share/${token}/`.length);
        if (!pages.some((p) => p.id === target))
          throw new HttpError(403, "Seitenlink nicht freigegeben.");
        attrs[attr] = `/#page=${target}`;
      } else if (!/^(https?:|mailto:)/i.test(value)) {
        throw new HttpError(403, "Interner Link nicht freigegeben.");
      }
    }
    return { tagName, attribs: attrs };
  });
}
// At most 30 guest writes per link and minute.
export function limitShareRequests(token: string) {
  run("DELETE FROM share_requests WHERE created_at<?", Date.now() - 60000);
  if (
    (one<{ n: number }>(
      "SELECT count(*) n FROM share_requests WHERE token=?",
      token,
    )?.n || 0) >= 30
  )
    throw new HttpError(429, "Zu viele Anfragen. Bitte warte eine Minute.");
  run("INSERT INTO share_requests VALUES(?,?)", token, Date.now());
}
export function mutateSharedContent(token: string, input: unknown) {
  const b = z
    .object({
      action: z.enum(["comment", "save", "create"]),
      pageId: z.string().uuid(),
      rowId: z.string().uuid().optional(),
    })
    .passthrough()
    .parse(input);
  return transaction(() => {
    const s = source(token, b.pageId, b.rowId);
    if (s.role === "viewer" || (b.action !== "comment" && s.role !== "editor"))
      throw new HttpError(403, "Dieser Link erlaubt diese Aktion nicht.");
    if (s.page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
    limitShareRequests(token);
    if (b.action === "create") {
      // New records by guests: only public, writable properties.
      if (s.page.kind !== "database" || s.row)
        throw new HttpError(400, "Neue Einträge nur in Datenbanken.");
      const cells = validatedCells(b.cells ?? {}, s.fields, {});
      const rid = id();
      run(
        "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM rows WHERE page_id=?),NULL,NULL)",
        rid,
        s.page.id,
        JSON.stringify(cells),
        s.page.id,
      );
      run(
        "UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?",
        s.page.id,
      );
      run(
        "INSERT INTO notifications(id,user_id,body,page_id) VALUES(?,?,?,?)",
        id(),
        s.page.created_by,
        `Neuer Gasteintrag in „${s.page.title}“`,
        s.page.id,
      );
      audit("guest", "share.create", s.page.id, rid);
      return { ...sharedContent(token, b.pageId), createdRowId: rid };
    }
    if (b.action === "comment") {
      const name = z.string().trim().min(1).max(80).parse(b.name);
      const body = z.string().trim().min(1).max(5000).parse(b.body);
      run(
        "INSERT INTO shared_comments(id,page_id,row_id,name,body) VALUES(?,?,?,?,?)",
        id(),
        s.page.id,
        b.rowId || null,
        name,
        body,
      );
      run(
        "INSERT INTO notifications(id,user_id,body,page_id) VALUES(?,?,?,?)",
        id(),
        s.page.created_by,
        `Neuer Gastkommentar auf „${s.page.title}“`,
        s.page.id,
      );
      audit("guest", "share.comment", s.page.id);
    } else {
      if (b.version !== s.version)
        throw new HttpError(
          409,
          "Die Seite wurde inzwischen geändert. Lade sie neu, bevor du erneut speicherst. Dein Entwurf bleibt hier erhalten.",
        );
      const title = z.string().trim().min(1).max(500).parse(b.title);
      if (s.page.kind === "document" || s.row) {
        const html = writableHtml(
          z.string().max(2_000_000).parse(b.html),
          token,
          [s.root, ...s.pages.filter((p) => p.id !== s.root.id)],
          s.doc?.html || "",
        );
        const state = htmlState(html),
          doc = new Y.Doc();
        let canonical: string;
        try {
          Y.applyUpdate(doc, state);
          canonical = stateHtml(doc);
        } finally {
          doc.destroy();
        }
        if (s.row) {
          const cells = validatedCells(b.cells ?? {}, s.fields, s.cells);
          run(
            "INSERT INTO row_snapshots(id,row_id,state,html,created_by) VALUES(?,?,?,?,?)",
            id(),
            s.row.id,
            s.doc!.state!,
            s.doc!.html,
            "guest",
          );
          run(
            "UPDATE row_documents SET state=?,html=?,generation=?,updated_at=CURRENT_TIMESTAMP WHERE row_id=?",
            state,
            canonical,
            id(),
            s.row.id,
          );
          run(
            "UPDATE rows SET cells=?,content=?,version=version+1,updated_at=CURRENT_TIMESTAMP,updated_by=NULL WHERE id=?",
            JSON.stringify(cells),
            canonical,
            s.row.id,
          );
        } else {
          run(
            "INSERT INTO snapshots(id,page_id,state,html,title,created_by) VALUES(?,?,?,?,?,?)",
            id(),
            s.page.id,
            s.doc?.state || htmlState(s.doc?.html || ""),
            s.doc?.html || "",
            s.page.title,
            "guest",
          );
          run(
            "UPDATE documents SET state=?,html=?,generation=?,updated_at=CURRENT_TIMESTAMP WHERE page_id=?",
            state,
            canonical,
            id(),
            s.page.id,
          );
        }
      }
      run(
        "UPDATE pages SET title=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
        s.row ? s.page.title : title,
        s.page.id,
      );
      audit("guest", "share.edit", s.page.id);
    }
    return sharedContent(token, b.pageId, b.rowId);
  });
}
