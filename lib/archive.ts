import { parseRecurrence } from "./recurrence";
import { quotaCheckpoint } from "./instance-ops";
import { mapFileCell } from "./file-cells";
import { spaceColorSchema } from "./space-appearance";
import {
  archivedThreadsSchema,
  exportInlineComments,
  importInlineComments,
} from "./inline-comment-archive";
import {
  appearanceSchema,
  coverSchema,
  pageIconSchema,
} from "./page-appearance";
import { validateCover, validateIcon } from "./page-covers";
import { remapViewReferences } from "./view-references";
import { remapLinkedAttributes } from "./linked-view-references";
import {
  savedRowTemplateSchema,
  savedDatabaseTemplateSchema,
} from "./page-templates";
import {
  relationPairSchema,
  relationPairs,
  insertRelationPair,
  validateRelationGraph,
} from "./relation-sync";
import { formConfigSchema } from "./form-settings";
import { fromBuffer, type Entry } from "yauzl";
import { ZipFile } from "yazl";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { all, one, run, id, transaction, audit } from "./db";
import { requireMember, pageRole, spaceRole } from "./permissions";
import { HttpError } from "./auth";
import { field, view } from "./database-schema";
import { cleanHtml, htmlState } from "./document-server";
import type { Identity, Page, Field, Space } from "./types";

export const ARCHIVE_LIMIT = 100 * 1024 * 1024;
const EXPANDED_LIMIT = 250 * 1024 * 1024,
  MANIFEST_LIMIT = 30 * 1024 * 1024;
const str = z.string().max(500),
  uid = z.string().uuid(),
  html = z.string().max(2_000_000);
const cells = z.record(z.string().max(500), z.unknown());
const snapshot = z.object({
  appearance: appearanceSchema.nullable().optional(),
  html: z.string().max(20_000_000),
  title: z.string().max(500).default(""),
  created_at: str,
});
const rowSchema = z.object({
  id: uid,
  cells,
  content: html.default(""),
  position: z.number().finite().default(0),
  icon: pageIconSchema.default(""),
  cover: coverSchema.default(""),
  recurrence: z
    .string()
    .max(500)
    .default("")
    .refine((v) => !v || !!parseRecurrence(v), "Ungültige Wiederholung."),
  created_at: str,
  updated_at: str,
  snapshots: z
    .array(snapshot.omit({ title: true }))
    .max(1000)
    .default([]),
});
const databaseSchema = z.object({
  fields: z.array(field).min(1).max(80),
  views: z.array(view).min(1).max(30),
  rows: z.array(rowSchema).max(5000),
  templates: z
    .array(
      z.object({
        name: str,
        cells,
        html,
        is_default: z.number().int().min(0).max(1),
      }),
    )
    .max(500)
    .default([]),
});
export const archiveSchema = z.object({
  format: z.literal("flowplan-2"),
  relationPairs: z.array(relationPairSchema).max(20000).default([]),
  exportedAt: str,
  workspace: z.object({ name: str, icon: str }),
  favorites: z.array(uid).max(500).default([]),
  templates: z
    .array(
      z.object({
        name: str,
        kind: z.enum(["document", "database"]),
        payload: z.string().max(20_000_000),
        deleted_at: str.nullable().optional(),
        files: z
          .array(
            z.object({
              id: uid,
              original_id: uid,
              name: str,
              mime: str,
              size: z
                .number()
                .int()
                .min(0)
                .max(10 * 1024 * 1024),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            }),
          )
          .max(200)
          .default([]),
      }),
    )
    .max(500)
    .default([]),
  spaces: z
    .array(
      z.object({
        id: uid,
        name: str,
        icon: str,
        icon_color: spaceColorSchema.default("none"),
        visibility: z.enum(["team", "private"]),
      }),
    )
    .max(500),
  pages: z
    .array(
      z.object({
        id: uid,
        space_id: uid,
        parent_id: uid.nullable(),
        title: str,
        icon: pageIconSchema,
        cover: coverSchema,
        cover_position: z.number().finite().min(0).max(100).default(50),
        kind: z.enum(["document", "database"]),
        position: z.number().finite(),
        deleted_at: str.nullable(),
        updated_at: str,
        locked: z.number().int().min(0).max(1),
        full_width: z.number().int().min(0).max(1),
        font: z.enum(["sans", "serif", "mono"]),
        html: html.optional(),
        database: databaseSchema.optional(),
        form: z
          .object({
            internal: z.number().int().min(0).max(1),
            anonymous: z.number().int().min(0).max(1),
            config: formConfigSchema.optional(),
          })
          .nullable()
          .optional(),
        snapshots: z.array(snapshot).max(1000).default([]),
        inlineThreads: archivedThreadsSchema.default([]),
        comments: z
          .array(
            z.object({
              row_id: uid.nullable(),
              author: str,
              body: z.string().max(20000),
              resolved: z.number().int().min(0).max(1),
              created_at: str,
            }),
          )
          .max(10000)
          .default([]),
      }),
    )
    .max(500),
  files: z
    .array(
      z.object({
        id: uid,
        page_id: uid,
        name: str,
        mime: str,
        size: z
          .number()
          .int()
          .min(0)
          .max(10 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(2000),
});
export type ContentArchive = z.infer<typeof archiveSchema>;
function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
function snapshotFor(user: Identity, wid: string) {
  requireMember(user, wid);
  const pages = all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? ORDER BY position",
    wid,
  ).filter((p) => pageRole(user, p));
  const pageIds = new Set(pages.map((p) => p.id));
  const spaceIds = new Set(pages.map((p) => p.space_id));
  const binaries = new Map<string, Buffer>();
  let bytes = 0;
  const manifest = {
    format: "flowplan-2",
    relationPairs: relationPairs().filter(
      (p) => pageIds.has(p.left_page) && pageIds.has(p.right_page),
    ),
    exportedAt: new Date().toISOString(),
    workspace: one("SELECT name,icon FROM workspaces WHERE id=?", wid),
    favorites: all<{ page_id: string }>(
      "SELECT page_id FROM favorites WHERE user_id=?",
      user.id,
    )
      .filter((f) => pageIds.has(f.page_id))
      .map((f) => f.page_id),
    templates: all<{
      id: string;
      name: string;
      kind: string;
      payload: string;
      deleted_at: string | null;
    }>(
      "SELECT id,name,kind,payload,deleted_at FROM templates WHERE workspace_id=? AND (visibility='workspace' OR created_by=?)",
      wid,
      user.id,
    ).map((t) => ({
      ...t,
      files: all<{
        id: string;
        original_id: string;
        name: string;
        mime: string;
        data: Uint8Array;
      }>("SELECT * FROM template_files WHERE template_id=?", t.id).map((f) => {
        const data = Buffer.from(f.data);
        bytes += data.length;
        if (bytes > EXPANDED_LIMIT)
          throw new HttpError(
            413,
            "Dateien überschreiten 250 MB pro Inhaltsarchiv.",
          );
        binaries.set(`template-files/${f.id}`, data);
        return {
          id: f.id,
          original_id: f.original_id,
          name: f.name,
          mime: f.mime,
          size: data.length,
          sha256: digest(data),
        };
      }),
    })),
    spaces: all<Space>("SELECT * FROM spaces WHERE workspace_id=?", wid)
      .filter((s) => spaceRole(user, s) || spaceIds.has(s.id))
      .map((s) => ({
        id: s.id,
        name: s.name,
        icon: s.icon,
        icon_color: s.icon_color || "none",
        visibility: s.visibility,
      })),
    pages: pages.map((p) => {
      const db =
        p.kind === "database"
          ? one<{ fields: string; views: string }>(
              "SELECT fields,views FROM databases WHERE page_id=?",
              p.id,
            )
          : null;
      return {
        id: p.id,
        space_id: p.space_id,
        parent_id: p.parent_id && pageIds.has(p.parent_id) ? p.parent_id : null,
        title: p.title,
        icon: p.icon,
        cover: p.cover,
        cover_position: p.cover_position ?? 50,
        kind: p.kind,
        position: p.position,
        deleted_at: p.deleted_at,
        updated_at: p.updated_at,
        locked: p.locked,
        full_width: p.full_width,
        font: p.font,
        form: (() => {
          const form = one<{
            internal: number;
            anonymous: number;
            config: string;
          }>(
            "SELECT internal,anonymous,config FROM forms WHERE page_id=?",
            p.id,
          );
          return form
            ? {
                ...form,
                config: formConfigSchema.parse(JSON.parse(form.config)),
              }
            : null;
        })(),
        ...(db
          ? {
              database: {
                fields: JSON.parse(db.fields),
                views: JSON.parse(db.views),
                rows: all<{
                  id: string;
                  cells: string;
                  content: string;
                  position: number;
                  created_at: string;
                  updated_at: string;
                }>(
                  "SELECT id,cells,content,position,icon,cover,recurrence,created_at,updated_at FROM rows WHERE page_id=? ORDER BY position",
                  p.id,
                ).map((r) => ({
                  ...r,
                  cells: JSON.parse(r.cells),
                  snapshots: all(
                    "SELECT html,created_at FROM row_snapshots WHERE row_id=? ORDER BY created_at",
                    r.id,
                  ),
                })),
                templates: all<{
                  name: string;
                  cells: string;
                  html: string;
                  is_default: number;
                }>(
                  "SELECT name,cells,html,is_default FROM row_templates WHERE page_id=?",
                  p.id,
                ).map((t) => ({ ...t, cells: JSON.parse(t.cells) })),
              },
            }
          : {
              html:
                one("SELECT html FROM documents WHERE page_id=?", p.id)?.html ||
                "",
            }),
        snapshots: all(
          "SELECT html,title,created_at,appearance FROM snapshots WHERE page_id=? ORDER BY created_at",
          p.id,
        ).map((s) => ({
          ...s,
          title: s.title || "",
          appearance: s.appearance ? JSON.parse(String(s.appearance)) : null,
        })),
        inlineThreads: exportInlineComments(p.id),
        comments: all(
          `SELECT c.row_id,COALESCE(u.name,'Unbekannt') author,c.body,c.resolved,c.created_at FROM comments c LEFT JOIN users u ON u.id=c.author_id WHERE c.page_id=?
           UNION ALL SELECT row_id,name || ' (Gast)' author,body,resolved,created_at FROM shared_comments WHERE page_id=? ORDER BY created_at`,
          p.id,
          p.id,
        ),
      };
    }),
    files: pages.flatMap((p) =>
      all<{
        id: string;
        page_id: string;
        name: string;
        mime: string;
        size: number;
      }>(
        "SELECT id,page_id,name,mime,size FROM files WHERE page_id=?",
        p.id,
      ).map((f) => {
        let data: Buffer;
        try {
          data = readFileSync(
            resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads", f.id),
          );
        } catch {
          throw new HttpError(
            409,
            `Datei „${f.name}“ fehlt auf dem Server. Sicherung abgebrochen.`,
          );
        }
        bytes += data.length;
        if (bytes > EXPANDED_LIMIT)
          throw new HttpError(
            413,
            "Dateien überschreiten 250 MB pro Inhaltsarchiv.",
          );
        binaries.set(`files/${f.id}`, data);
        return { ...f, size: data.length, sha256: digest(data) };
      }),
    ),
  };
  if (binaries.size > 2000)
    throw new HttpError(413, "Höchstens 2.000 Dateien pro Inhaltsarchiv.");
  const validated = archiveSchema.parse(manifest);
  const encoded = Buffer.from(JSON.stringify(validated));
  if (
    encoded.length > MANIFEST_LIMIT ||
    encoded.length + bytes > EXPANDED_LIMIT
  )
    throw new HttpError(413, "Inhaltsarchiv zu groß.");
  binaries.set("flowplan.json", encoded);
  return binaries;
}
export async function writeZip(entries: Map<string, Buffer>) {
  const zip = new ZipFile();
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    zip.outputStream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > ARCHIVE_LIMIT) {
        (zip.outputStream as Readable).destroy(
          new HttpError(413, "ZIP überschreitet 100 MB."),
        );
        return;
      }
      chunks.push(chunk);
    });
    zip.outputStream.once("error", reject);
    zip.once("error", reject);
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const [name, bytes] of entries) zip.addBuffer(bytes, name);
  zip.end();
  return result;
}
export async function exportArchive(user: Identity, wid: string) {
  const entries = transaction(() => snapshotFor(user, wid));
  const bytes = await writeZip(entries);
  audit(user.id, "workspace.archive.export", wid);
  return bytes;
}
// Foreign exports (Notion, AppFlowy, Markdown) use arbitrary names; they only
// skip folders and macOS metadata instead of rejecting unknown entries.
export type ZipOptions = { foreign?: boolean; maxEntries?: number };
export async function readZip(
  bytes: Buffer,
  options: ZipOptions = {},
): Promise<Map<string, Buffer>> {
  if (bytes.length > ARCHIVE_LIMIT)
    throw new HttpError(413, "ZIP darf maximal 100 MB groß sein.");
  return new Promise((resolve, reject) =>
    fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error) {
          reject(new HttpError(400, "Ungültige ZIP-Datei."));
          return;
        }
        let total = 0,
          count = 0,
          failed = false;
        const result = new Map<string, Buffer>();
        const fail = (e: unknown) => {
          if (failed) return;
          failed = true;
          zip.close();
          reject(
            e instanceof HttpError
              ? e
              : new HttpError(400, "Beschädigtes ZIP-Archiv."),
          );
        };
        zip.on("error", fail);
        zip.on("end", () => {
          if (!failed) resolve(result);
        });
        zip.on("entry", (entry: Entry) => {
          if (failed) return;
          if (
            options.foreign &&
            (entry.fileName.endsWith("/") ||
              /(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(entry.fileName))
          ) {
            zip.readEntry();
            return;
          }
          count++;
          if (
            count > (options.maxEntries ?? 2001) ||
            entry.isEncrypted() ||
            result.has(entry.fileName) ||
            (!options.foreign &&
              !/^flowplan\.json$|^(?:files|template-files)\/[a-f0-9-]{36}$/.test(
                entry.fileName,
              ))
          ) {
            fail(
              new HttpError(
                400,
                "ZIP enthält unbekannte, doppelte oder verschlüsselte Einträge.",
              ),
            );
            return;
          }
          const max =
            entry.fileName === "flowplan.json"
              ? MANIFEST_LIMIT
              : 10 * 1024 * 1024;
          if (
            entry.uncompressedSize > max ||
            total + entry.uncompressedSize > EXPANDED_LIMIT
          ) {
            fail(
              new HttpError(
                413,
                "Entpacktes Archiv überschreitet das Größenlimit.",
              ),
            );
            return;
          }
          zip.openReadStream(entry, (err, stream) => {
            if (err) {
              fail(err);
              return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            stream.on("error", fail);
            stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              total += chunk.length;
              if (size > max || total > EXPANDED_LIMIT) {
                stream.destroy();
                fail(
                  new HttpError(
                    413,
                    "Entpacktes Archiv überschreitet das Größenlimit.",
                  ),
                );
                return;
              }
              chunks.push(chunk);
            });
            stream.once("end", () => {
              if (failed) return;
              result.set(entry.fileName, Buffer.concat(chunks));
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    ),
  );
}
function validateArchive(input: unknown, files: Map<string, Buffer>) {
  const data = archiveSchema.parse(input),
    seen = new Set<string>(),
    pages = new Map(data.pages.map((p) => [p.id, p]));
  const check = (key: string) => {
    if (seen.has(key))
      throw new HttpError(400, "Doppelte Objekt-ID im Archiv.");
    seen.add(key);
  };
  for (const s of data.spaces) check(s.id);
  const spaces = new Set(data.spaces.map((s) => s.id));
  for (const p of data.pages) {
    check(p.id);
    if (!spaces.has(p.space_id))
      throw new HttpError(400, "Bereich fehlt im Archiv.");
    if (
      (p.kind === "database") !== !!p.database ||
      (p.kind === "document" && p.html === undefined)
    )
      throw new HttpError(400, "Seiteninhalt passt nicht zum Seitentyp.");
    const ancestors = new Set([p.id]);
    let parent = p.parent_id;
    while (parent) {
      const item = pages.get(parent);
      if (!item || item.space_id !== p.space_id || ancestors.has(parent))
        throw new HttpError(400, "Ungültiger Seitenbaum im Archiv.");
      ancestors.add(parent);
      parent = item.parent_id;
    }
    if (p.database) {
      const fieldIds = new Set<string>();
      for (const f of p.database.fields) {
        if (fieldIds.has(f.id))
          throw new HttpError(400, "Doppelte Eigenschaft.");
        fieldIds.add(f.id);
      }
      for (const r of p.database.rows) check(r.id);
      const rowIds = new Set(p.database.rows.map((r) => r.id));
      for (const c of p.comments)
        if (c.row_id && !rowIds.has(c.row_id))
          throw new HttpError(400, "Kommentar verweist auf fremden Datensatz.");
      for (const t of p.inlineThreads)
        if (!t.row_id || !rowIds.has(t.row_id))
          throw new HttpError(
            400,
            "Textkommentar verweist auf fremden Datensatz.",
          );
    } else if (
      p.comments.some((c) => c.row_id) ||
      p.inlineThreads.some((t) => t.row_id)
    )
      throw new HttpError(400, "Ungültiger Datensatzkommentar.");
  }
  for (const pair of data.relationPairs) check(pair.id);
  validateRelationGraph(
    data.relationPairs,
    new Map(
      data.pages.flatMap((p) =>
        p.database ? [[p.id, p.database] as const] : [],
      ),
    ),
  );
  for (const f of data.files) {
    check(f.id);
    const bytes = files.get(`files/${f.id}`);
    if (
      !pages.has(f.page_id) ||
      !bytes ||
      bytes.length !== f.size ||
      digest(bytes) !== f.sha256
    )
      throw new HttpError(400, "Datei fehlt oder Prüfsumme stimmt nicht.");
  }
  let templateFileCount = 0;
  for (const template of data.templates) {
    const originals = new Set<string>();
    for (const f of template.files) {
      check(f.id);
      if (originals.has(f.original_id))
        throw new HttpError(400, "Doppelter Vorlagenanhang.");
      originals.add(f.original_id);
      const bytes = files.get(`template-files/${f.id}`);
      if (!bytes || bytes.length !== f.size || digest(bytes) !== f.sha256)
        throw new HttpError(
          400,
          "Vorlagenanhang fehlt oder Prüfsumme stimmt nicht.",
        );
      templateFileCount++;
    }
  }
  if (files.size !== data.files.length + templateFileCount + 1)
    throw new HttpError(400, "Archiv enthält nicht zugeordnete Dateien.");
  return data;
}
export async function importArchive(
  user: Identity,
  wid: string,
  bytes: Buffer,
) {
  requireMember(user, wid, "editor");
  const entries = await readZip(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(entries.get("flowplan.json")?.toString("utf8") || "");
  } catch {
    throw new HttpError(400, "flowplan.json fehlt oder ist beschädigt.");
  }
  const data = validateArchive(raw, entries),
    written: string[] = [];
  try {
    return transaction(() => {
      requireMember(user, wid, "editor");
      const quota = quotaCheckpoint(wid);
      const pageMap = new Map(data.pages.map((p) => [p.id, id()])),
        rowMap = new Map(
          data.pages.flatMap(
            (p) => p.database?.rows.map((r) => [r.id, id()] as const) || [],
          ),
        ),
        fileMap = new Map(data.files.map((f) => [f.id, id()])),
        spaceMap = new Map(data.spaces.map((s) => [s.id, id()]));
      const pairIds = new Map<string, string>();
      const remapPairs = (input: unknown) =>
        z
          .array(relationPairSchema)
          .max(20000)
          .parse(input)
          .filter((p) => pageMap.has(p.left_page) && pageMap.has(p.right_page))
          .map((p) => {
            if (!pairIds.has(p.id)) pairIds.set(p.id, id());
            return {
              ...p,
              id: pairIds.get(p.id)!,
              left_page: pageMap.get(p.left_page)!,
              right_page: pageMap.get(p.right_page)!,
            };
          });
      for (const p of data.pages)
        if (p.kind === "database")
          for (const snapshot of p.snapshots) {
            let payload;
            try {
              payload = z
                .object({
                  database: z.object({
                    fields: z.array(field),
                    views: z.array(view),
                  }),
                  rows: z
                    .array(
                      z.object({
                        id: uid,
                        cells,
                        position: z.number().finite().default(0),
                        content: html.optional(),
                      }),
                    )
                    .max(5000),
                })
                .parse(JSON.parse(snapshot.html));
            } catch {
              throw new HttpError(400, "Ungültige Datenbankversion im Archiv.");
            }
            for (const row of payload.rows)
              if (!rowMap.has(row.id)) rowMap.set(row.id, id());
          }
      const members = new Set(
        all<{ user_id: string }>(
          "SELECT user_id FROM members WHERE workspace_id=?",
          wid,
        ).map((m) => m.user_id),
      );
      let omittedRelations = 0;
      const rewriteUrl = (value: string) =>
        value
          .replace(/(\/api\/files\/)([\w-]+)/g, (match, prefix, fid) =>
            fileMap.has(fid) ? prefix + fileMap.get(fid) : match,
          )
          .replace(/(\/?#page=)([\w-]+)/g, (match, prefix, pid) =>
            pageMap.has(pid) ? prefix + pageMap.get(pid) : match,
          );
      const rewriteHtml = (value: string) =>
        cleanHtml(value, (tagName, attribs) => {
          const attrs = remapLinkedAttributes(
            { ...attribs },
            pageMap,
            rowMap,
            (source) => data.pages.find((p) => p.id === source)?.database,
          );
          for (const key of ["href", "src"])
            if (attrs[key]) attrs[key] = rewriteUrl(attrs[key]);
          if (attrs["data-mention"] && !members.has(attrs["data-mention"]))
            delete attrs["data-mention"];
          return { tagName, attribs: attrs };
        });
      const rewriteFields = (fields: Field[]) =>
        fields.map((f) => ({
          ...f,
          ...(f.relationPage
            ? { relationPage: pageMap.get(f.relationPage) }
            : {}),
        }));
      const rewriteCells = (values: Record<string, unknown>, fields: Field[]) =>
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => {
            const f = fields.find((f) => f.id === key);
            if (f?.type === "relation") {
              const ids = Array.isArray(value)
                ? value
                : typeof value === "string"
                  ? [value]
                  : [];
              const mapped = ids
                .map((v) => rowMap.get(String(v)))
                .filter(Boolean);
              omittedRelations += ids.length - mapped.length;
              return [key, mapped];
            }
            if (f?.type === "person")
              return [
                key,
                typeof value === "string" && members.has(value) ? value : "",
              ];
            if (f?.type === "files")
              return [key, mapFileCell(value, rewriteUrl)];
            return [key, value];
          }),
        );
      const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
      mkdirSync(dir, { recursive: true });
      for (const f of data.files) {
        const path = resolve(dir, fileMap.get(f.id)!);
        writeFileSync(path, entries.get(`files/${f.id}`)!, { flag: "wx" });
        written.push(path);
      }
      for (const s of data.spaces)
        run(
          "INSERT INTO spaces(id,workspace_id,name,icon,visibility,owner_id,icon_color) VALUES(?,?,?,?,?,?,?)",
          spaceMap.get(s.id)!,
          wid,
          `${s.name} (Import)`,
          s.icon,
          "private",
          user.id,
          s.icon_color,
        );
      for (const p of data.pages)
        run(
          "INSERT INTO pages(id,workspace_id,space_id,title,icon,cover,cover_position,kind,position,deleted_at,created_by,updated_at,locked,full_width,font) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          pageMap.get(p.id)!,
          wid,
          spaceMap.get(p.space_id)!,
          p.title,
          rewriteUrl(p.icon),
          rewriteUrl(p.cover),
          p.cover_position,
          p.kind,
          p.position,
          p.deleted_at,
          user.id,
          p.updated_at,
          p.locked,
          p.full_width,
          p.font,
        );
      for (const p of data.pages) {
        const pid = pageMap.get(p.id)!;
        if (p.form && p.kind === "database")
          run(
            "INSERT INTO forms(page_id,token,enabled,internal,anonymous,config) VALUES(?,?,0,?,?,?)",
            pid,
            id(),
            p.form.internal,
            p.form.anonymous,
            JSON.stringify(p.form.config || formConfigSchema.parse({})),
          );
        if (p.parent_id)
          run(
            "UPDATE pages SET parent_id=? WHERE id=?",
            pageMap.get(p.parent_id)!,
            pid,
          );
        if (p.database) {
          const d = p.database;
          run(
            "INSERT INTO databases(page_id,fields,views) VALUES(?,?,?)",
            pid,
            JSON.stringify(rewriteFields(d.fields)),
            JSON.stringify(
              remapViewReferences(d.views, d.fields, rowMap, d.rows),
            ),
          );
          for (const r of d.rows) {
            const rid = rowMap.get(r.id)!,
              content = rewriteHtml(r.content);
            run(
              "INSERT INTO rows(id,page_id,cells,position,created_at,updated_at,created_by,updated_by,content,icon,cover,recurrence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
              rid,
              pid,
              JSON.stringify(rewriteCells(r.cells, d.fields)),
              r.position,
              r.created_at,
              r.updated_at,
              user.id,
              user.id,
              content,
              rewriteUrl(r.icon),
              rewriteUrl(r.cover),
              r.recurrence,
            );
            run(
              "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)",
              rid,
              htmlState(content),
              content,
              id(),
            );
            for (const snap of r.snapshots) {
              const html = rewriteHtml(snap.html);
              run(
                // Restored history is kept like manually saved versions.
                "INSERT INTO row_snapshots(id,row_id,state,html,created_by,created_at,kind) VALUES(?,?,?,?,?,?,'manual')",
                id(),
                rid,
                htmlState(html),
                html,
                user.id,
                snap.created_at,
              );
            }
          }
          for (const t of d.templates)
            run(
              "INSERT INTO row_templates(id,page_id,name,cells,html,is_default,created_by) VALUES(?,?,?,?,?,?,?)",
              id(),
              pid,
              t.name,
              JSON.stringify(rewriteCells(t.cells, d.fields)),
              rewriteHtml(t.html),
              t.is_default,
              user.id,
            );
        } else {
          const html = rewriteHtml(p.html!);
          run(
            "INSERT INTO documents(page_id,state,html,generation) VALUES(?,?,?,?)",
            pid,
            htmlState(html),
            html,
            id(),
          );
        }
        importInlineComments(pid, p.inlineThreads, rowMap, user.id);
        for (const c of p.comments)
          run(
            "INSERT INTO comments(id,page_id,row_id,author_id,body,resolved,created_at) VALUES(?,?,?,?,?,?,?)",
            id(),
            pid,
            c.row_id ? rowMap.get(c.row_id)! : null,
            user.id,
            `Import · ${c.author}:\n${c.body}`,
            c.resolved,
            c.created_at,
          );
        // Database snapshots use JSON payloads; remap their rows separately from current records.
        for (const snap of p.snapshots) {
          let html = snap.html,
            state: Uint8Array | null = null;
          if (p.kind === "document") {
            html = rewriteHtml(html);
            state = htmlState(html);
          } else {
            try {
              const payload = JSON.parse(html);
              const fields = z.array(field).parse(payload.database.fields);
              payload.database.fields = rewriteFields(fields);
              payload.database.page_id = pid;
              payload.database.views = remapViewReferences(
                z.array(view).parse(payload.database.views),
                fields,
                rowMap,
                payload.rows,
              );
              const snapshotRowMap = new Map<string, string>(
                payload.rows.map((r: { id: string }) => [
                  r.id,
                  rowMap.get(r.id) || id(),
                ]),
              );
              if (payload.inlineThreads)
                payload.inlineThreads = archivedThreadsSchema
                  .parse(payload.inlineThreads)
                  .map((t) => {
                    if (!t.row_id || !snapshotRowMap.has(t.row_id))
                      throw new HttpError(
                        400,
                        "Textkommentar verweist auf fremden Datensatz.",
                      );
                    return { ...t, row_id: snapshotRowMap.get(t.row_id)! };
                  });
              payload.rows = payload.rows.map(
                (r: {
                  id: string;
                  cells: Record<string, unknown>;
                  content?: string;
                }) => ({
                  ...r,
                  id: snapshotRowMap.get(r.id)!,
                  page_id: pid,
                  cells: rewriteCells(r.cells, fields),
                  content: rewriteHtml(r.content || ""),
                }),
              );
              if (payload.relationPairs !== undefined)
                payload.relationPairs = remapPairs(payload.relationPairs);
              if (payload.rowTemplates)
                payload.rowTemplates = z
                  .array(savedRowTemplateSchema)
                  .max(500)
                  .parse(payload.rowTemplates)
                  .map((t) => ({
                    ...t,
                    cells: rewriteCells(t.cells, fields),
                    html: rewriteHtml(t.html),
                  }));
              if (payload.formConfig)
                payload.formConfig = formConfigSchema.parse(payload.formConfig);
              if (Array.isArray(payload.comments))
                payload.comments = payload.comments.map(
                  (c: Record<string, unknown>) => ({
                    id: id(),
                    page_id: pid,
                    row_id:
                      typeof c.row_id === "string"
                        ? rowMap.get(c.row_id) || null
                        : null,
                    author_id: user.id,
                    body: `Import (Versionsstand):\n${z.string().max(20000).parse(c.body)}`,
                    resolved: c.resolved === 1 ? 1 : 0,
                    created_at: z.string().max(500).parse(c.created_at),
                  }),
                );
              html = JSON.stringify(payload);
            } catch {
              throw new HttpError(400, "Ungültige Datenbankversion im Archiv.");
            }
          }
          const snapshotId = id();
          run(
            "INSERT INTO snapshots(id,page_id,state,html,title,created_by,created_at,appearance,kind) VALUES(?,?,?,?,?,?,?,?,'manual')",
            snapshotId,
            pid,
            state,
            html,
            snap.title,
            user.id,
            snap.created_at,
            snap.appearance
              ? JSON.stringify({
                  ...snap.appearance,
                  cover: rewriteUrl(snap.appearance.cover),
                })
              : null,
          );
          // Old archives did not record historical covers; do not infer one from today's page.
          if (!snap.appearance)
            run("UPDATE snapshots SET appearance=NULL WHERE id=?", snapshotId);
        }
      }
      for (const f of data.files)
        run(
          "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
          fileMap.get(f.id)!,
          pageMap.get(f.page_id)!,
          f.name,
          f.mime,
          f.size,
          user.id,
        );
      for (const p of data.pages) {
        validateCover(pageMap.get(p.id)!, rewriteUrl(p.cover));
        validateIcon(pageMap.get(p.id)!, rewriteUrl(p.icon));
        // Record images must be files of their own database page.
        for (const r of p.database?.rows || []) {
          validateIcon(pageMap.get(p.id)!, rewriteUrl(r.icon));
          validateCover(pageMap.get(p.id)!, rewriteUrl(r.cover));
        }
        for (const snap of p.snapshots)
          if (snap.appearance)
            validateCover(
              pageMap.get(p.id)!,
              rewriteUrl(snap.appearance.cover),
            );
      }
      for (const favorite of data.favorites)
        if (pageMap.has(favorite))
          run(
            "INSERT INTO favorites(user_id,page_id) VALUES(?,?)",
            user.id,
            pageMap.get(favorite)!,
          );
      for (const template of data.templates) {
        let payload;
        try {
          payload = JSON.parse(template.payload);
          const appearance = payload.appearance
            ? appearanceSchema.parse(payload.appearance)
            : undefined;
          const rewrittenAppearance = appearance
            ? { ...appearance, cover: rewriteUrl(appearance.cover) }
            : undefined;
          if (template.kind === "document")
            payload = {
              appearance: rewrittenAppearance,
              html: rewriteHtml(z.string().max(2_000_000).parse(payload.html)),
            };
          else {
            const parsed = savedDatabaseTemplateSchema.parse(payload);
            const fields = parsed.database.fields;
            validateRelationGraph(
              parsed.relationPairs,
              new Map(
                parsed.database.page_id
                  ? [[parsed.database.page_id, { fields, rows: parsed.rows }]]
                  : [],
              ),
            );
            for (const row of parsed.rows)
              if (!rowMap.has(row.id)) rowMap.set(row.id, id());
            // A template can survive its source page. Keep a virtual source ID
            // so self-relations can still be rebound when it is applied later.
            const sourcePage = parsed.database.page_id;
            const templatePage = sourcePage
              ? pageMap.get(sourcePage) || id()
              : undefined;
            const templateHtml = (value: string) =>
              cleanHtml(rewriteHtml(value), (tagName, attribs) => ({
                tagName,
                attribs:
                  sourcePage && attribs.href === `/#page=${sourcePage}`
                    ? { ...attribs, href: `/#page=${templatePage}` }
                    : attribs,
              }));
            payload = {
              appearance: rewrittenAppearance,
              database: {
                page_id: templatePage,
                fields: rewriteFields(fields).map((f, i) =>
                  fields[i].relationPage === sourcePage && sourcePage
                    ? { ...f, relationPage: templatePage }
                    : f,
                ),
                views: remapViewReferences(
                  parsed.database.views,
                  fields,
                  rowMap,
                  parsed.rows,
                ),
              },
              rows: parsed.rows.map((row) => ({
                ...row,
                id: rowMap.get(row.id),
                cells: rewriteCells(row.cells, fields),
                content: templateHtml(row.content),
              })),
              rowTemplates: parsed.rowTemplates?.map((t) => ({
                ...t,
                cells: rewriteCells(t.cells, fields),
                html: templateHtml(t.html),
              })),
              relationPairs: parsed.relationPairs.map((p) => ({
                ...p,
                id: id(),
                left_page: templatePage!,
                right_page: templatePage!,
              })),
              formConfig: parsed.formConfig,
            };
          }
        } catch {
          throw new HttpError(400, "Ungültige Seitenvorlage im Archiv.");
        }
        const templateId = id();
        run(
          "INSERT INTO templates(id,workspace_id,name,kind,payload,created_by,visibility,deleted_at) VALUES(?,?,?,?,?,?,'private',?)",
          templateId,
          wid,
          template.name,
          template.kind,
          JSON.stringify(payload),
          user.id,
          template.deleted_at || null,
        );
        for (const f of template.files)
          run(
            "INSERT INTO template_files(id,template_id,original_id,name,mime,data) VALUES(?,?,?,?,?,?)",
            id(),
            templateId,
            fileMap.get(f.original_id) || f.original_id,
            f.name,
            f.mime,
            entries.get(`template-files/${f.id}`)!,
          );
      }
      for (const pair of remapPairs(data.relationPairs))
        insertRelationPair(pair);
      audit(
        user.id,
        "workspace.archive.import",
        wid,
        `${data.pages.length} Seiten, ${data.files.length} Dateien`,
      );
      quota();
      return {
        pages: data.pages.length,
        files: data.files.length,
        spaces: [...spaceMap.values()],
        pageIds: Object.fromEntries(pageMap),
        omittedRelations,
      };
    }, user);
  } catch (error) {
    for (const path of written)
      try {
        unlinkSync(path);
      } catch {}
    throw error;
  }
}
