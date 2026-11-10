import { isTagField } from "./page-properties";
import { parseAliases } from "./page-aliases";
import {
  applyHtml,
  liveKey,
  loadLive,
  newProjection,
  saveLive,
} from "./shared-live";
import { numberCell } from "./field-format";
import { createHash } from "node:crypto";
import { z } from "zod";
import * as Y from "yjs";
import { all, one, run, id, transaction, audit, nowText } from "./db";
import { noteDangerousHtml } from "./security-events";
import { HttpError } from "./auth";
import { publicPage, publicFile, publishedHtml } from "./publication";
import { cleanHtml, cleanHtmlAsync, htmlState, stateHtml } from "./document-server";
import { ensureRowDocument } from "./row-documents";
import type { Field, Row } from "./types";
import { formulaReferences } from "./formula";
import { publicHiddenFieldIds, readRestricted, stripCells, writeRestricted } from "./field-access";
import { cellText } from "./cell-text";
import {
  fileIdOf,
  fileRefSchema,
  fileUrls,
  MAX_CELL_FILES,
} from "./file-cells";
import { documentChanged } from "./document-live";
import { rowChanged, rowCreated } from "./automations";
import { GUEST_LIVE_MB, takeAnonymousBudget } from "./anonymous-budget";
import { flatMapAsync, mapAsync } from "./each-async";

// Properties with a read rule are never public (lib/field-access.ts).
export const publicField = (f: Field) =>
  !readRestricted(f) &&
  ![
    "person",
    "created_by",
    "updated_by",
    "relation",
    "files",
    "formula",
    "rollup",
  ].includes(f.type);
// Properties a publication may show. Formulas count when every property
// they read is public as well (no relations, people or dynamic prop()).
// Never one the field rules hide from public readers (an AI, progress or
// time property that reads a property with a read rule).
export function publicFieldIds(fields: Field[]) {
  const hiddenByRule = publicHiddenFieldIds(fields);
  const result = new Map<string, boolean>();
  const visit = (field: Field, trail: Set<string>): boolean => {
    if (result.has(field.id)) return result.get(field.id)!;
    let ok: boolean;
    if (field.type !== "formula") ok = publicField(field);
    else if (trail.has(field.id)) ok = false;
    else {
      const refs = formulaReferences(field.formula || "");
      const next = new Set(trail).add(field.id);
      ok =
        !!refs &&
        !refs.dynamic &&
        refs.names.every((name) => {
          const target =
            fields.find((f) => f.id === name) ||
            fields.findLast((f) => f.name === name);
          return !!target && visit(target, next);
        });
    }
    result.set(field.id, ok);
    return ok;
  };
  return new Set(fields.filter((f) => !hiddenByRule.has(f.id) && visit(f, new Set())).map((f) => f.id));
}
export const publicFieldsOf = (fields: Field[]) => {
  const ids = publicFieldIds(fields);
  return (field: Field) => ids.has(field.id);
};
// Properties a share link shows and, with edit rights, changes: the public
// ones plus relations into databases of the same share and files.
export function guestFields(fields: Field[], pages: { id: string }[]) {
  const visible = publicFieldsOf(fields),
    hiddenByRule = publicHiddenFieldIds(fields),
    published = new Set(pages.map((p) => p.id));
  return fields.filter(
    (f) =>
      visible(f) ||
      (!hiddenByRule.has(f.id) &&
        !readRestricted(f) &&
        (f.type === "files" ||
          (f.type === "relation" &&
            !!f.relationPage &&
            published.has(f.relationPage)))),
  );
}
const guestWritable = (f: Field, pages: { id: string }[], fields: Field[]) =>
  !publicHiddenFieldIds(fields).has(f.id) &&
  (writablePublicField(f) ||
  (!readRestricted(f) &&
    !writeRestricted(f) &&
    (f.type === "files" ||
      (f.type === "relation" &&
        !!f.relationPage &&
        pages.some((p) => p.id === f.relationPage)))));
export const writablePublicField = (f: Field) =>
  publicField(f) &&
  !writeRestricted(f) &&
  !["created_at", "updated_at"].includes(f.type);
export type SharedComment = {
  id: string;
  name: string;
  body: string;
  resolved: number;
  created_at: string;
};
async function source(token: string, pageId?: string, rowId?: string) {
  const context = await publicPage(token, pageId);
  const { page } = context;
  const row = rowId
    ? (await one<Row>(
        "SELECT * FROM rows WHERE id=? AND page_id=? AND access!='private'",
        rowId,
        page.id,
      ))
    : undefined;
  if (rowId && !row) throw new HttpError(404, "Datensatz nicht gefunden.");
  const doc = row
    ? (await ensureRowDocument(row))
    : (await one<{ html: string; state: Uint8Array | null; generation: string }>(
        "SELECT * FROM documents WHERE page_id=?",
        page.id,
      ));
  const fields: Field[] =
    page.kind === "database"
      ? JSON.parse(
          String(
            (await one("SELECT fields FROM databases WHERE page_id=?", page.id))
              ?.fields || "[]",
          ),
        )
      : [];
  // As stored (merged on write) and as guests see it (shown and hashed):
  // without what the field rules hide from public readers.
  const stored: Record<string, unknown> = row
    ? JSON.parse(String(row.cells))
    : {};
  const cells = stripCells(stored, publicHiddenFieldIds(fields));
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
  return { ...context, row, doc, fields, cells, stored, version };
}
// Stored file references appear to guests as URLs of this share.
async function shareFileUrl(token: string, url: string) {
  const fid = fileIdOf(url);
  if (!fid) return url;
  try {
    await publicFile(token, fid);
    return `/api/share/${token}/files/${fid}`;
  } catch {
    return "";
  }
}
export async function sharedContent(token: string, pageId?: string, rowId?: string) {
  const s = await source(token, pageId, rowId);
  const fields = guestFields(s.fields, s.pages);
  // Choices for relations: records of shared databases (title only).
  const related: Record<string, { id: string; cells: { title: string } }[]> =
    {};
  if (s.row)
    for (const f of fields)
      if (f.type === "relation" && f.relationPage && !related[f.relationPage]) {
        const target = JSON.parse(
          String(
            (await one("SELECT fields FROM databases WHERE page_id=?", f.relationPage))
              ?.fields || "[]",
          ),
        ) as Field[];
        related[f.relationPage] = (await all<{ id: string; cells: string }>(
          "SELECT id,cells FROM rows WHERE page_id=? AND access!='private' ORDER BY position LIMIT 500",
          f.relationPage,
        )).map((r) => ({
          id: r.id,
          cells: {
            title:
              cellText(JSON.parse(r.cells)[target[0]?.id || "title"]) ||
              "Ohne Titel",
          },
        }));
      }
  const files = await flatMapAsync(await all<{ id: string; name: string; mime: string }>(
    "SELECT id,name,mime FROM files WHERE page_id=? AND deleted_at IS NULL",
    s.page.id,
  ), async (f) => {
    const url = await shareFileUrl(token, `/api/files/${f.id}`);
    return url ? [{ url, name: f.name, mime: f.mime }] : [];
  });
  return {
    pageId: s.page.id,
    rowId,
    // Read-only records take comments at most.
    role:
      s.row?.access === "readonly" && s.role === "editor"
        ? ("commenter" as const)
        : s.role,
    locked: !!s.page.locked,
    title: s.page.title,
    // Editors get placeholders for what they cannot see, so saving keeps it.
    html: await publishedHtml(
      s.doc?.html || "",
      token,
      s.pages,
      s.role === "editor" ? new Map() : undefined,
    ),
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
    // Tag-backed properties offer only the tags of this record (#79): the
    // workspace's other tags stay unknown to the link.
    fields: s.row
      ? fields.map((f) =>
          isTagField(f)
            ? { ...f, options: (f.options || []).filter((o) => Array.isArray(s.cells[f.id]) && (s.cells[f.id] as unknown[]).includes(o)) }
            : f,
        )
      : [],
    cells: s.row
      ? Object.fromEntries(
          await mapAsync(fields, async (f) => [
            f.id,
            f.type === "files"
              ? (await mapAsync(fileUrls(s.cells[f.id]), async (url) => await shareFileUrl(token, url)))
                  .filter(Boolean)
              : (s.cells[f.id] ?? null),
          ]),
        )
      : {},
    related,
    files,
    comments: await all<SharedComment>(
      "SELECT id,name,body,resolved,created_at FROM shared_comments WHERE page_id=? AND row_id IS NOT DISTINCT FROM ? ORDER BY created_at,id LIMIT 500",
      s.page.id,
      rowId || null,
    ),
  };
}
async function validatedCells(
  input: unknown,
  fields: Field[],
  current: Record<string, unknown>,
  share: { token: string; pages: { id: string }[]; pageId: string },
) {
  const patch = z.record(z.string(), z.unknown()).parse(input);
  const cells = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const f = fields.find((f) => f.id === key && guestWritable(f, share.pages, fields));
    if (!f)
      throw new HttpError(
        403,
        "Diese Eigenschaft kann über diesen Link nicht geändert werden.",
      );
    if (f.type === "relation") {
      const ids = [
        ...new Set(z.array(z.string().uuid()).max(500).parse(value)),
      ];
      for (const rid of ids)
        if (
          !(await one(
            "SELECT id FROM rows WHERE id=? AND page_id=? AND access!='private'",
            rid,
            f.relationPage!,
          ))
        )
          throw new HttpError(400, "Verknüpfter Eintrag fehlt.");
      cells[key] = ids;
    } else if (f.type === "files") {
      // Guests keep existing files, add their own uploads or web links.
      const existing = new Set(fileUrls(current[key]));
      const list: string[] = [];
      for (const url of z
        .array(z.string().max(2000))
        .max(MAX_CELL_FILES)
        .parse(value)) {
        const shared = new RegExp(
          `^/api/share/${share.token}/files/([0-9a-f-]{36})$`,
        ).exec(url);
        if (shared) {
          const file = await publicFile(share.token, shared[1]);
          if (file.page_id !== share.pageId)
            throw new HttpError(400, "Datei gehört nicht zu dieser Datenbank.");
          list.push(`/api/files/${shared[1]}`);
        } else if (
          existing.has(url) ||
          (fileRefSchema.safeParse(url).success && !fileIdOf(url))
        )
          list.push(url);
        else
          throw new HttpError(
            400,
            "Datei ist über diesen Link nicht verfügbar.",
          );
      }
      cells[key] = [...new Set(list)];
    } else if (f.type === "number") {
      try {
        cells[key] = numberCell(f, value);
      } catch (e) {
        throw new HttpError(400, `${f.name}: ${(e as Error).message}`);
      }
    } else if (f.type === "checkbox") cells[key] = z.boolean().parse(value);
    else if (f.type === "multiselect") {
      const values = z.array(z.string()).max(100).parse(value);
      // Tag-backed: only the record's own tags (removing works, new or
      // other tags do not).
      const allowed = isTagField(f) ? (Array.isArray(current[key]) ? (current[key] as unknown[]) : []) : f.options || [];
      if (values.some((v) => !allowed.includes(v)))
        throw new HttpError(400, "Ungültige Auswahl.");
      cells[key] = [...new Set(values)];
    } else if (f.type === "aliases") cells[key] = parseAliases(value);
    else if (f.type === "checklist")
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
async function writableHtml(
  html: string,
  token: string,
  pages: { id: string }[],
  original: string,
) {
  const linked = new Map<string, Record<string, string>>(),
    mentions = new Set<string>();
  cleanHtml(original, (tagName, attribs) => {
    if (attribs["data-linked-database"])
      linked.set(attribs["data-linked-database"], attribs);
    if (attribs["data-mention"]) mentions.add(attribs["data-mention"]);
    return { tagName, attribs };
  });
  // Scripts in what a guest sends are removed below; noted for the security log.
  noteDangerousHtml(html, { detail: `share link ${token.slice(0, 6)}…` });
  // Placeholders for links and files the guest cannot see map back.
  const hidden = new Map<string, string>();
  await publishedHtml(original, token, pages, hidden);
  const seen = new Set<string>();
  return cleanHtmlAsync(html, async (tagName, attribs) => {
    let attrs = { ...attribs };
    if (attrs["data-linked-database"]) {
      const id = attrs["data-linked-database"];
      if (!linked.has(id) || seen.has(id))
        throw new HttpError(403, "Einbettung nicht freigegeben.");
      seen.add(id);
      attrs = { ...linked.get(id)! };
    }
    const board = attrs["data-whiteboard"];
    if (board) {
      if (hidden.has(board)) attrs["data-whiteboard"] = hidden.get(board)!;
      else if (!pages.some((p) => p.id === board))
        throw new HttpError(403, "Whiteboard nicht freigegeben.");
    }
    // Guests keep existing mentions but cannot mention anyone new.
    if (attrs["data-mention"] && !mentions.has(attrs["data-mention"]))
      delete attrs["data-mention"];
    // The same attributes publishedHtml rewrites: a PDF block (data-pdf)
    // keeps its file, also one the guest cannot see.
    for (const attr of ["href", "src", "data-pdf"]) {
      const value = attrs[attr];
      if (!value) continue;
      if (hidden.has(value)) {
        attrs[attr] = hidden.get(value)!;
        continue;
      }
      // Only this link's already published files and pages can become internal references.
      const file = new RegExp(`^/api/share/${token}/files/([\\w-]+)$`).exec(
        value,
      );
      if (file) {
        await publicFile(token, file[1]);
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
export async function limitShareRequests(token: string) {
  await run("DELETE FROM share_requests WHERE created_at<?", Date.now() - 60000);
  if (
    ((await one<{ n: number }>(
      "SELECT count(*) n FROM share_requests WHERE token=?",
      token,
    ))?.n || 0) >= 30
  )
    throw new HttpError(429, "Zu viele Anfragen. Bitte warte eine Minute.");
  await run("INSERT INTO share_requests VALUES(?,?)", token, Date.now());
}
// What a guest may make of a document through a link: 3 MB of canonical
// HTML, and a stored projection of at most 8 MB before it is rebuilt.
export const MAX_GUEST_DOCUMENT = 3_000_000;
const MAX_LIVE_STATE = 8_000_000;
// Live edits have their own, larger budget (a change every half second).
async function limitLiveChanges(token: string) {
  await run("DELETE FROM share_live_requests WHERE created_at<?", Date.now() - 60000);
  if (
    ((await one<{ n: number }>(
      "SELECT count(*) n FROM share_live_requests WHERE token=?",
      token,
    ))?.n || 0) >= 120
  )
    throw new HttpError(429, "Zu viele Änderungen. Bitte warte kurz.");
  await run("INSERT INTO share_live_requests VALUES(?,?)", token, Date.now());
}
export async function mutateSharedContent(token: string, input: unknown) {
  const b = z
    .object({
      action: z.enum(["comment", "save", "create", "cells", "live"]),
      pageId: z.string().uuid(),
      rowId: z.string().uuid().optional(),
    })
    .passthrough()
    .parse(input);
  return await transaction(async () => {
    const s = await source(token, b.pageId, b.rowId);
    if (s.role === "viewer" || (b.action !== "comment" && s.role !== "editor"))
      throw new HttpError(403, "Dieser Link erlaubt diese Aktion nicht.");
    if (s.page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
    if (b.action !== "comment" && s.row?.access === "readonly")
      throw new HttpError(403, "Dieser Eintrag ist schreibgeschützt.");
    if (b.action === "live") return await liveSync(token, s, b);
    await limitShareRequests(token);
    if (b.action === "create") {
      // New records by guests: only public, writable properties.
      if (s.page.kind !== "database" || s.row)
        throw new HttpError(400, "Neue Einträge nur in Datenbanken.");
      const cells = await validatedCells(
        b.cells ?? {},
        s.fields,
        {},
        {
          token,
          pages: s.pages,
          pageId: s.page.id,
        },
      );
      const rid = id();
      await run(
        "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM rows WHERE page_id=?),NULL,NULL)",
        rid,
        s.page.id,
        JSON.stringify(cells),
        s.page.id,
      );
      await run(
        "UPDATE pages SET updated_at=? WHERE id=?", nowText(),
        s.page.id,
      );
      await run(
        "INSERT INTO notifications(id,user_id,body,page_id,kind) VALUES(?,?,?,?,'guest')",
        id(),
        s.page.created_by,
        `Neuer Gasteintrag in „${s.page.title}“`,
        s.page.id,
      );
      await rowCreated(null, s.page, rid);
      await audit("guest", "share.create", s.page.id, rid);
      return { ...(await sharedContent(token, b.pageId)), createdRowId: rid };
    }
    if (b.action === "cells") {
      // Single property changes, e.g. moving an entry in the calendar.
      if (!s.row) throw new HttpError(400, "Eintrag fehlt.");
      if (b.version !== s.version)
        throw new HttpError(
          409,
          "Der Eintrag wurde inzwischen geändert. Bitte neu laden.",
        );
      const cells = await validatedCells(b.cells ?? {}, s.fields, s.stored, {
        token,
        pages: s.pages,
        pageId: s.page.id,
      });
      await run(
        "UPDATE rows SET cells=?,version=version+1,updated_at=?,updated_by=NULL WHERE id=?",
        JSON.stringify(cells), nowText(),
        s.row.id,
      );
      await rowChanged(null, s.page, s.row.id, s.stored, cells, s.fields);
      await audit("guest", "share.cells", s.page.id, s.row.id);
      return await sharedContent(token, b.pageId, b.rowId);
    }
    if (b.action === "comment") {
      const name = z.string().trim().min(1).max(80).parse(b.name);
      const body = z.string().trim().min(1).max(5000).parse(b.body);
      await run(
        "INSERT INTO shared_comments(id,page_id,row_id,name,body) VALUES(?,?,?,?,?)",
        id(),
        s.page.id,
        b.rowId || null,
        name,
        body,
      );
      await run(
        "INSERT INTO notifications(id,user_id,body,page_id,kind) VALUES(?,?,?,?,'guest')",
        id(),
        s.page.created_by,
        `Neuer Gastkommentar auf „${s.page.title}“`,
        s.page.id,
      );
      await audit("guest", "share.comment", s.page.id);
    } else {
      if (b.version !== s.version)
        throw new HttpError(
          409,
          "Die Seite wurde inzwischen geändert. Lade sie neu, bevor du erneut speicherst. Dein Entwurf bleibt hier erhalten.",
        );
      const title = z.string().trim().min(1).max(500).parse(b.title);
      // Live editing saves the content continuously; saving then only
      // changes the title or the properties.
      if (b.html === undefined && s.row) {
        const cells = await validatedCells(b.cells ?? {}, s.fields, s.stored, {
          token,
          pages: s.pages,
          pageId: s.page.id,
        });
        await run(
          "UPDATE rows SET cells=?,version=version+1,updated_at=?,updated_by=NULL WHERE id=?",
          JSON.stringify(cells), nowText(),
          s.row.id,
        );
        await rowChanged(null, s.page, s.row.id, s.stored, cells, s.fields);
      } else if (
        b.html !== undefined &&
        (s.page.kind === "document" || s.row)
      ) {
        const html = await writableHtml(
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
          const cells = await validatedCells(b.cells ?? {}, s.fields, s.stored, {
            token,
            pages: s.pages,
            pageId: s.page.id,
          });
          await run(
            "INSERT INTO row_snapshots(id,row_id,state,html,created_by) VALUES(?,?,?,?,?)",
            id(),
            s.row.id,
            s.doc!.state!,
            s.doc!.html,
            "guest",
          );
          await run(
            "UPDATE row_documents SET state=?,html=?,generation=?,updated_at=? WHERE row_id=?",
            state,
            canonical,
            id(), nowText(),
            s.row.id,
          );
          documentChanged(s.page.id, s.row.id);
          await run(
            "UPDATE rows SET cells=?,content=?,version=version+1,updated_at=?,updated_by=NULL WHERE id=?",
            JSON.stringify(cells),
            canonical, nowText(),
            s.row.id,
          );
          await rowChanged(null, s.page, s.row.id, s.stored, cells, s.fields);
        } else {
          await run(
            "INSERT INTO snapshots(id,page_id,state,html,title,created_by) VALUES(?,?,?,?,?,?)",
            id(),
            s.page.id,
            s.doc?.state || htmlState(s.doc?.html || ""),
            s.doc?.html || "",
            s.page.title,
            "guest",
          );
          await run(
            "UPDATE documents SET state=?,html=?,generation=?,updated_at=? WHERE page_id=?",
            state,
            canonical,
            id(), nowText(),
            s.page.id,
          );
          documentChanged(s.page.id);
        }
      }
      await run(
        "UPDATE pages SET title=?,updated_at=? WHERE id=?",
        s.row ? s.page.title : title, nowText(),
        s.page.id,
      );
      await audit("guest", "share.edit", s.page.id);
    }
    return await sharedContent(token, b.pageId, b.rowId);
  });
}

// Live editing (see lib/shared-live.ts). Without `update` it only pulls.
async function liveSync(
  token: string,
  s: Awaited<ReturnType<typeof source>>,
  input: Record<string, unknown>,
) {
  if (s.page.kind !== "document" && !s.row)
    throw new HttpError(
      400,
      "Nur Dokumente und Einträge sind live bearbeitbar.",
    );
  const b = z
    .object({
      pgen: z.string().max(100).optional(),
      update: z.string().max(8_000_000).optional(),
      vector: z.string().max(100_000).optional(),
    })
    .parse(input);
  const pages = [s.root, ...s.pages.filter((p) => p.id !== s.root.id)];
  const member = s.row
    ? (await ensureRowDocument(s.row))
    : (() => {
        const d = s.doc!;
        return {
          state: d.state || htmlState(d.html || ""),
          html: d.html || "",
          generation: d.generation,
        };
      })();
  const key = liveKey(token, s.page.id, s.row?.id);
  const stored = await loadLive(key);
  const projected = async () => await publishedHtml(member.html, token, s.pages, new Map());
  let doc: Y.Doc, pgen: string;
  // A projection that has grown fat with the history of guest edits (Yjs
  // keeps what was deleted) starts afresh; guests simply resynchronise.
  if (!stored || stored.generation !== member.generation || stored.state.byteLength > MAX_LIVE_STATE) {
    ({ doc, pgen } = newProjection(await projected()));
  } else {
    doc = new Y.Doc();
    Y.applyUpdate(doc, stored.state);
    pgen = stored.pgen;
    // Member changes since the last exchange flow into the projection.
    if (stored.source_html !== member.html) applyHtml(doc, await projected());
  }
  let sourceHtml = member.html;
  try {
    if (b.update && b.pgen === pgen) {
      const before = stateHtml(doc);
      Y.applyUpdate(doc, Buffer.from(b.update, "base64"));
      const after = stateHtml(doc);
      if (after !== before) {
        await limitLiveChanges(token);
        // A link may grow a document only so far; what members wrote may
        // stay larger (the check is on growth, not on size).
        if (after.length > MAX_GUEST_DOCUMENT && after.length > before.length)
          throw new HttpError(413, "Das Dokument ist für die Bearbeitung über einen Link zu groß geworden.");
        await takeAnonymousBudget(`live:${token}`, Math.ceil((b.update.length * 3) / 4), GUEST_LIVE_MB);
        const safe = await writableHtml(after, token, pages, member.html);
        const real = new Y.Doc();
        try {
          Y.applyUpdate(real, member.state);
          applyHtml(real, safe);
          const html = stateHtml(real),
            state = Y.encodeStateAsUpdate(real);
          if (html !== member.html) {
            if (s.row) {
              if (
                !(await one(
                  "SELECT id FROM row_snapshots WHERE row_id=? AND created_at>?",
                  s.row.id, nowText(Date.now() - 300_000),
                ))
              )
                await run(
                  "INSERT INTO row_snapshots(id,row_id,state,html,created_by) VALUES(?,?,?,?,?)",
                  id(),
                  s.row.id,
                  member.state,
                  member.html,
                  "guest",
                );
              await run(
                "UPDATE row_documents SET state=?,html=?,updated_at=? WHERE row_id=?",
                state,
                html, nowText(),
                s.row.id,
              );
              await run(
                "UPDATE rows SET content=?,updated_at=?,updated_by=NULL WHERE id=?",
                html, nowText(),
                s.row.id,
              );
            } else {
              if (
                !(await one(
                  "SELECT id FROM snapshots WHERE page_id=? AND created_at>?",
                  s.page.id, nowText(Date.now() - 300_000),
                ))
              )
                await run(
                  "INSERT INTO snapshots(id,page_id,state,html,title,created_by) VALUES(?,?,?,?,?,?)",
                  id(),
                  s.page.id,
                  member.state,
                  member.html,
                  s.page.title,
                  "guest",
                );
              await run(
                "UPDATE documents SET state=?,html=?,updated_at=? WHERE page_id=?",
                state,
                html, nowText(),
                s.page.id,
              );
            }
            await run(
              "UPDATE pages SET updated_at=? WHERE id=?", nowText(),
              s.page.id,
            );
            // Members with the page open see the guest's change at once.
            documentChanged(s.page.id, s.row?.id);
            sourceHtml = html;
          }
        } finally {
          real.destroy();
        }
      }
    }
    await saveLive(key, {
      state: Y.encodeStateAsUpdate(doc),
      source_html: sourceHtml,
      generation: member.generation,
      pgen,
    });
    const reset = !!b.pgen && b.pgen !== pgen;
    return {
      pgen,
      reset,
      update: Buffer.from(
        Y.encodeStateAsUpdate(
          doc,
          b.vector && !reset ? Buffer.from(b.vector, "base64") : undefined,
        ),
      ).toString("base64"),
      version: (await source(token, s.page.id, s.row?.id)).version,
    };
  } finally {
    doc.destroy();
  }
}
