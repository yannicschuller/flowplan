import { cellText } from "./cell-text";
import { scheduleRow } from "./row-schedule";
import { rewriteFormulaReferences } from "./formula";
import { validateCalculations } from "./database-summary";
import { spaceColorSchema, spaceIconSchema } from "./space-appearance";
import { mutateLinkedDatabase } from "./linked-databases";
import {
  manageSpace,
  duplicateSpace,
  manageWorkspace,
  canManageSpace,
  requireSpaceManager,
} from "./workspace-lifecycle";
import {
  coverSchema,
  appearanceSchema,
  pageAppearance,
  pageIconSchema,
} from "./page-appearance";
import {
  pageImages,
  pageFiles,
  validateCover,
  validateIcon,
  applyAppearance,
  snapshotAppearance,
} from "./page-covers";
import { documentPreview } from "./document-preview";
import {
  moveRow,
  maintainRowOrders,
  validateViewRowOrders,
} from "./row-order-server";
import { remapViewReferences } from "./view-references";
import { remapLinkedAttributes } from "./linked-view-references";
import { transformFilterGroup } from "./database-filters";
import type { Filter } from "./types";
import { captureTemplateFiles } from "./template-files";
import {
  requireTemplate,
  applyPageTemplate,
  databaseTemplateExtras,
  managePageTemplate,
} from "./page-templates";
import { formSettings, saveFormSubmission } from "./forms";
import { formConfigSchema } from "./form-settings";
import {
  bulkRows,
  databaseSnapshot,
  autoDatabaseSnapshot,
  validateCellPatch,
} from "./database-operations";
import { field, view } from "./database-schema";
import { publishPage, publicationSettings } from "./publication";
import { manageShareLink, listShareLinks } from "./share-links";
import { relatedData, validateDatabaseRelations } from "./related-data";
import { configureRelation } from "./two-way-relations";
import { relationPairs, restoreRelationPairs } from "./relation-sync";
import { duplicatePageTree } from "./page-tree";
import { applyStarterTemplate, starterTemplates } from "./starter-templates";
import {
  requireRow,
  rowTemplates,
  selectedRowTemplate,
  replaceRowDocument,
  syncRowDocument,
  snapshotRow,
  restoreRow,
  saveRowTemplate,
  manageRowTemplate,
} from "./row-documents";
import { z } from "zod";
import * as Y from "yjs";
import { all, one, run, id, transaction, audit } from "./db";
import { HttpError } from "./auth";
import {
  cleanHtml,
  htmlState,
  stateHtml,
  markdownHtml,
  escaped,
} from "./document-server";
import {
  requireAdmin,
  requireMember,
  requirePage,
  spaceRole,
  pageRole,
} from "./permissions";
import {
  createPage,
  createWorkspace,
  defaultFields,
  defaultViews,
} from "./seed";
import type {
  Identity,
  Page,
  Space,
  Database,
  Row,
  Field,
  View,
} from "./types";
const str = z.string().min(1).max(500),
  uuid = z.string().uuid();
export function database(pid: string): Database {
  const raw = one<{
    page_id: string;
    fields: string;
    views: string;
    version: number;
  }>("SELECT * FROM databases WHERE page_id=?", pid);
  if (!raw) throw new HttpError(404, "Datenbank nicht gefunden.");
  return {
    ...raw,
    fields: JSON.parse(raw.fields),
    views: JSON.parse(raw.views),
  };
}
export function rows(pid: string): Row[] {
  return all<Row & { cells: string }>(
    "SELECT * FROM rows WHERE page_id=? ORDER BY position",
    pid,
  ).map((r) => ({ ...r, cells: JSON.parse(r.cells) }));
}
export function bootstrap(user: Identity, wid?: string) {
  const workspaces = all<{
    id: string;
    name: string;
    icon: string;
    role: string;
  }>(
    "SELECT w.*,m.role FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at",
    user.id,
  );
  const workspace = workspaces.find((w) => w.id === wid) || workspaces[0];
  if (!workspace) throw new HttpError(404, "Kein Arbeitsbereich.");
  const pages = all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? ORDER BY position",
    workspace.id,
  ).filter((p) => pageRole(user, p));
  const visibleSpaceIds = new Set(pages.map((p) => p.space_id));
  return {
    user,
    workspaces,
    workspace,
    pages,
    spaces: all<Space>(
      "SELECT * FROM spaces WHERE workspace_id=?",
      workspace.id,
    ).filter((s) => spaceRole(user, s) || visibleSpaceIds.has(s.id)),
    trashedSpaces: all<Space>(
      "SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NOT NULL",
      workspace.id,
    ).filter((s) => canManageSpace(user, s)),
    managedSpaces: all<Space>(
      "SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NULL",
      workspace.id,
    ).filter((s) => canManageSpace(user, s)),
    favorites: all<{ page_id: string }>(
      "SELECT page_id FROM favorites WHERE user_id=?",
      user.id,
    ).map((f) => f.page_id),
    // Favourite records of readable databases in this workspace.
    favoriteRows: all<Page & { row_id: string; cells: string; fields: string }>(
      `SELECT p.*,r.id row_id,r.cells,d.fields FROM row_favorites f
       JOIN rows r ON r.id=f.row_id JOIN pages p ON p.id=f.page_id
       JOIN databases d ON d.page_id=p.id
       WHERE f.user_id=? AND p.workspace_id=? AND p.deleted_at IS NULL`,
      user.id,
      workspace.id,
    )
      .filter((p) => pageRole(user, p))
      .map((p) => ({
        pageId: p.id,
        rowId: p.row_id,
        title:
          cellText(
            JSON.parse(p.cells)[
              (JSON.parse(p.fields) as Field[])[0]?.id || "title"
            ],
          ) || "Ohne Titel",
      })),
    members: all(
      "SELECT u.id,u.name,u.email,u.disabled,m.role FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?",
      workspace.id,
    ),
    notifications: all(
      "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
      user.id,
    ),
  };
}
export function pageData(user: Identity, pid: string) {
  const p = requirePage(user, pid);
  const role = pageRole(user, p);
  const backlinks = all<Page & { html: string }>(
    "SELECT p.*,d.html FROM pages p JOIN documents d ON d.page_id=p.id WHERE p.workspace_id=? AND p.deleted_at IS NULL AND p.id!=?",
    p.workspace_id,
    p.id,
  )
    .filter((x) => pageRole(user, x) && x.html.includes("#page=" + p.id))
    .map((x) => ({ id: x.id, title: x.title, icon: x.icon }));
  const comments = all(
    `SELECT c.*,u.name FROM comments c JOIN users u ON u.id=c.author_id WHERE page_id=?
     UNION ALL SELECT id,page_id,row_id,NULL author_id,body,resolved,created_at,name || ' (Gast)' name FROM shared_comments WHERE page_id=? ORDER BY created_at`,
    pid,
    pid,
  );
  const snapshots = all(
    "SELECT id,title,created_at,kind FROM snapshots WHERE page_id=? ORDER BY created_at DESC LIMIT 50",
    pid,
  );
  const present = all(
    "SELECT u.id,u.name FROM presence p JOIN users u ON u.id=p.user_id WHERE p.page_id=? AND seen>?",
    pid,
    Date.now() - 45000,
  );
  run(
    "INSERT INTO presence VALUES(?,?,?) ON CONFLICT(page_id,user_id) DO UPDATE SET seen=excluded.seen",
    pid,
    user.id,
    Date.now(),
  );
  if (p.kind === "database") {
    const data = database(pid);
    const relations = relatedData(user, p);
    const documentHtml = new Map(
      all<{ row_id: string; html: string }>(
        "SELECT d.row_id,d.html FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE r.page_id=?",
        pid,
      ).map((d) => [d.row_id, d.html]),
    );
    return {
      page: p,
      images: pageImages(pid),
      files: pageFiles(pid),
      publication: publicationSettings(pid),
      shareLinks: role === "viewer" ? [] : listShareLinks(user, pid),
      role,
      comments,
      snapshots,
      present,
      backlinks,
      database: data,
      relationPairs: relationPairs(pid),
      rows: rows(pid).map((r) => ({
        ...r,
        preview: documentPreview(documentHtml.get(r.id) ?? r.content ?? ""),
      })),
      rowTemplates: rowTemplates(pid),
      reminders: listDateReminders(user, pid),
      ...relations,
      form: formSettings(pid),
    };
  }
  let doc = one<{ state: Uint8Array | null; html: string; generation: string }>(
    "SELECT * FROM documents WHERE page_id=?",
    pid,
  );
  if (doc && !doc.state) {
    const state = htmlState(doc.html);
    run(
      "UPDATE documents SET state=? WHERE page_id=? AND state IS NULL",
      state,
      pid,
    );
    doc = one<{ state: Uint8Array | null; html: string; generation: string }>(
      "SELECT * FROM documents WHERE page_id=?",
      pid,
    );
  }
  return {
    page: p,
    images: pageImages(pid),
    publication: publicationSettings(pid),
    shareLinks: role === "viewer" ? [] : listShareLinks(user, pid),
    role,
    comments,
    snapshots,
    present,
    backlinks,
    state: doc?.state ? Buffer.from(doc.state).toString("base64") : null,
    html: doc?.html || "",
    generation: doc?.generation || "1",
  };
}
function descendants(pid: string): string[] {
  return all<{ id: string }>(
    "WITH RECURSIVE tree(id) AS (SELECT id FROM pages WHERE id=? UNION ALL SELECT p.id FROM pages p JOIN tree t ON p.parent_id=t.id) SELECT id FROM tree",
    pid,
  ).map((p) => p.id);
}
// Snapshot images whose file was removed meanwhile are dropped, not restored.
function restorableImage(
  pageId: string,
  value: unknown,
  validate: (pageId: string, value: string) => void,
) {
  const parsed = pageIconSchema.safeParse(value);
  if (!parsed.success || !parsed.data) return "";
  try {
    validate(pageId, parsed.data);
    return parsed.data;
  } catch {
    return "";
  }
}
export function command(
  user: Identity,
  input: unknown,
  withinTransaction = false,
): unknown {
  const base = z.object({ action: str }).passthrough().parse(input);
  const action = base.action;
  const b = base as Record<string, unknown>;
  const pid = () => uuid.parse(b.pageId);
  const wid = () => uuid.parse(b.workspaceId);
  const write = () => {
    const p = requirePage(user, pid(), true);
    if (
      p.locked &&
      !["page.update", "page.delete", "page.snapshot"].includes(action)
    )
      throw new HttpError(409, "Diese Seite ist gesperrt.");
    return p;
  };
  const execute = () => {
    let result: unknown = { ok: true };
    switch (action) {
      case "workspace.create":
        result = { id: createWorkspaceInner(user.id, str.parse(b.name)) };
        break;
      case "workspace.update":
        requireMember(user, wid(), "owner");
        run(
          "UPDATE workspaces SET name=? WHERE id=?",
          str.parse(b.name),
          wid(),
        );
        break;
      case "workspace.delete":
      case "workspace.leave":
        result = manageWorkspace(user, b);
        break;
      case "space.delete":
      case "space.restore":
      case "space.purge":
        result = manageSpace(user, b);
        break;
      case "page.import": {
        requireMember(user, wid(), "editor");
        const sid = uuid.parse(b.spaceId),
          space = one<Space>(
            "SELECT * FROM spaces WHERE id=? AND workspace_id=?",
            sid,
            wid(),
          );
        if (
          !space ||
          !["owner", "editor"].includes(spaceRole(user, space) || "")
        )
          throw new HttpError(403, "Kein Zugriff");
        const content = z.string().max(2_000_000).parse(b.content);
        const html =
          b.format === "html"
            ? cleanHtml(content)
            : b.format === "markdown"
              ? markdownHtml(content)
              : `<p>${escaped(content).replaceAll("\n", "</p><p>")}</p>`;
        const np = createPage(wid(), sid, user.id, str.parse(b.title));
        run(
          "UPDATE documents SET html=?,state=? WHERE page_id=?",
          html,
          htmlState(html),
          np,
        );
        result = { id: np };
        break;
      }
      case "workspace.import": {
        requireMember(user, wid(), "editor");
        const sid = uuid.parse(b.spaceId),
          space = one<Space>(
            "SELECT * FROM spaces WHERE id=? AND workspace_id=?",
            sid,
            wid(),
          );
        if (
          !space ||
          !["owner", "editor"].includes(spaceRole(user, space) || "")
        )
          throw new HttpError(403, "Kein Zugriff");
        const backup = z
          .object({
            format: z.literal("flowplan-1"),
            pages: z
              .array(
                z.object({
                  id: str,
                  parent_id: z.string().nullable(),
                  title: str,
                  kind: z.enum(["document", "database"]),
                  data: z.unknown(),
                }),
              )
              .max(500),
          })
          .parse(b.backup);
        const mapped = new Map<string, string>();
        for (const p of backup.pages) {
          if (mapped.has(p.id)) throw new HttpError(400, "Doppelte Seiten-ID");
          const np = createPage(wid(), sid, user.id, p.title, p.kind);
          mapped.set(p.id, np);
        }
        const rowIds = new Map<string, string>();
        for (const page of backup.pages)
          if (page.kind === "database") {
            const { rows } = z
              .object({
                rows: z
                  .array(z.object({ id: z.string().optional() }))
                  .max(5000),
              })
              .parse(page.data);
            for (const [index, row] of rows.entries()) {
              const key = row.id || `${page.id}:row:${index}`;
              if (rowIds.has(key))
                throw new HttpError(400, "Doppelte Datensatz-ID");
              rowIds.set(key, id());
            }
          }
        const rewriteHtml = (html: string) =>
          cleanHtml(html, (tagName, attribs) => {
            const attrs = remapLinkedAttributes(
              { ...attribs },
              mapped,
              rowIds,
              (source) => {
                const p = backup.pages.find(
                  (p) => p.id === source && p.kind === "database",
                );
                if (!p) return;
                const data = z
                  .object({
                    database: z.object({ fields: z.array(field) }),
                    rows: z.array(z.object({ id: z.string().optional() })),
                  })
                  .parse(p.data);
                return {
                  fields: data.database.fields,
                  rows: data.rows.flatMap((r) => (r.id ? [{ id: r.id }] : [])),
                };
              },
            );
            if (attrs.href) {
              const match = /^\/?#page=(.+)$/.exec(attrs.href);
              if (match && mapped.has(match[1]))
                attrs.href = `/#page=${mapped.get(match[1])}`;
            }
            return { tagName, attribs: attrs };
          });
        for (const p of backup.pages) {
          const np = mapped.get(p.id)!;
          if (p.parent_id && mapped.has(p.parent_id)) {
            let parent = p.parent_id;
            const seen = new Set([p.id]);
            while (parent) {
              if (seen.has(parent))
                throw new HttpError(400, "Zyklischer Seitenbaum");
              seen.add(parent);
              parent =
                backup.pages.find((x) => x.id === parent)?.parent_id || "";
            }
            run(
              "UPDATE pages SET parent_id=? WHERE id=?",
              mapped.get(p.parent_id)!,
              np,
            );
          }
          if (p.kind === "document") {
            const doc = z
              .object({ html: z.string().max(2_000_000) })
              .parse(p.data);
            const html = rewriteHtml(doc.html);
            run(
              "UPDATE documents SET html=?,state=? WHERE page_id=?",
              html,
              htmlState(html),
              np,
            );
          } else {
            const d = z
              .object({
                database: z.object({
                  fields: z.array(field).min(1).max(80),
                  views: z.array(view).min(1).max(30),
                }),
                rows: z
                  .array(
                    z.object({
                      id: z.string().optional(),
                      cells: z.record(z.string(), z.unknown()),
                      content: z.string().optional(),
                    }),
                  )
                  .max(5000),
              })
              .parse(p.data);
            const fields = d.database.fields.map((f) => ({
              ...f,
              relationPage: f.relationPage
                ? mapped.get(f.relationPage)
                : undefined,
            }));
            run(
              "UPDATE databases SET fields=?,views=? WHERE page_id=?",
              JSON.stringify(fields),
              JSON.stringify(
                remapViewReferences(
                  d.database.views,
                  d.database.fields,
                  rowIds,
                  d.rows.flatMap((r) => (r.id ? [{ id: r.id }] : [])),
                ),
              ),
              np,
            );
            for (const [i, r] of d.rows.entries())
              run(
                "INSERT INTO rows(id,page_id,cells,content,position,created_by,updated_by) VALUES(?,?,?,?,?,?,?)",
                rowIds.get(r.id || `${p.id}:row:${i}`)!,
                np,
                JSON.stringify(
                  Object.fromEntries(
                    Object.entries(r.cells).map(([key, value]) => [
                      key,
                      d.database.fields.find((f) => f.id === key)?.type ===
                      "relation"
                        ? (Array.isArray(value)
                            ? value
                            : typeof value === "string"
                              ? [value]
                              : []
                          )
                            .map((v) => rowIds.get(String(v)))
                            .filter(Boolean)
                        : value,
                    ]),
                  ),
                ),
                rewriteHtml(r.content || ""),
                i,
                user.id,
                user.id,
              );
          }
        }
        result = {
          pages: backup.pages.length,
          pageIds: Object.fromEntries(mapped),
        };
        break;
      }
      case "space.duplicate":
        result = duplicateSpace(user, b);
        break;
      case "space.create": {
        requireMember(user, wid(), "editor");
        const sid = id();
        run(
          "INSERT INTO spaces(id,workspace_id,name,visibility,owner_id,icon,icon_color) VALUES(?,?,?,?,?,?,?)",
          sid,
          wid(),
          str.parse(b.name),
          b.private ? "private" : "team",
          user.id,
          spaceIconSchema.parse(b.icon ?? "folder"),
          spaceColorSchema.parse(b.iconColor ?? "none"),
        );
        result = { id: sid };
        break;
      }
      case "space.update": {
        const sid = uuid.parse(b.spaceId);
        const s = requireSpaceManager(user, sid);
        if (s.deleted_at)
          throw new HttpError(409, "Den Bereich zuerst wiederherstellen.");
        if (b.version !== undefined && b.version !== s.version)
          throw new HttpError(
            409,
            "Der Bereich wurde inzwischen geändert. Bitte neu laden.",
          );
        run(
          "UPDATE spaces SET name=?,visibility=?,icon=?,icon_color=?,version=version+1 WHERE id=?",
          str.parse(b.name),
          b.private ? "private" : "team",
          spaceIconSchema.parse(b.icon ?? s.icon),
          spaceColorSchema.parse(b.iconColor ?? s.icon_color ?? "none"),
          sid,
        );
        break;
      }
      case "page.create": {
        requireMember(user, wid(), "editor");
        const sid = uuid.parse(b.spaceId),
          s = one<Space>(
            "SELECT * FROM spaces WHERE id=? AND workspace_id=?",
            sid,
            wid(),
          );
        if (!s || !["editor", "owner"].includes(spaceRole(user, s) || ""))
          throw new HttpError(403, "Kein Zugriff auf Bereich.");
        const parent = b.parentId ? uuid.parse(b.parentId) : null;
        if (parent) {
          const p = requirePage(user, parent, true);
          if (p.space_id !== sid)
            throw new HttpError(
              400,
              "Übergeordnete Seite liegt in anderem Bereich.",
            );
        }
        const savedTemplate = b.templateId
          ? requireTemplate(user, b.templateId, wid())
          : undefined;
        const kind =
          savedTemplate?.kind ||
          z.enum(["document", "database"]).parse(b.kind || "document");
        const created = createPage(
          wid(),
          sid,
          user.id,
          str.parse(b.title),
          kind,
          parent,
        );
        if (savedTemplate)
          applyPageTemplate(
            user,
            requirePage(user, created, true),
            savedTemplate,
            false,
          );
        if (b.starterTemplate && savedTemplate)
          throw new HttpError(400, "Nur eine Vorlage auswählen.");
        if (b.starterTemplate) {
          const key = z
            .enum(["meeting", "wiki", "project", "tasks"])
            .parse(b.starterTemplate);
          if (starterTemplates[key].kind !== kind)
            throw new HttpError(400, "Vorlage passt nicht zum Seitentyp.");
          applyStarterTemplate(created, user.id, key);
        }
        result = { id: created };
        break;
      }
      case "page.update": {
        const p = write();
        const data = z
          .object({
            title: str.optional(),
            icon: pageIconSchema.optional(),
            cover: coverSchema.optional(),
            cover_position: z.number().finite().min(0).max(100).optional(),
            locked: z.boolean().optional(),
            full_width: z.boolean().optional(),
            font: z.enum(["sans", "serif", "mono"]).optional(),
          })
          .parse(b.patch);
        if (data.cover !== undefined || data.cover_position !== undefined) {
          if (p.locked && data.locked !== false)
            throw new HttpError(409, "Diese Seite ist gesperrt.");
          if (
            b.coverBase &&
            JSON.stringify(appearanceSchema.parse(b.coverBase)) !==
              JSON.stringify(pageAppearance(p))
          )
            throw new HttpError(
              409,
              "Das Cover wurde inzwischen geändert. Bitte neu öffnen.",
            );
          validateCover(p.id, data.cover ?? p.cover);
          if (p.kind === "database") databaseSnapshot(user, p);
          else
            run(
              "INSERT INTO snapshots(id,page_id,state,html,title,created_by) SELECT ?,page_id,state,html,?,? FROM documents WHERE page_id=?",
              id(),
              p.title,
              user.id,
              p.id,
            );
        }
        if (data.icon !== undefined) validateIcon(p.id, data.icon);
        for (const [key, val] of Object.entries(data))
          run(
            `UPDATE pages SET ${key}=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
            typeof val === "boolean" ? Number(val) : val,
            p.id,
          );
        break;
      }
      case "pages.bulk": {
        // Runs the single-page actions inside this transaction: all or nothing.
        const operation = z
          .enum(["delete", "duplicate", "move"])
          .parse(b.operation);
        const ids = [
          ...new Set(z.array(uuid).min(1).max(100).parse(b.pageIds)),
        ];
        const pages = ids.map((pid) => {
          const p = requirePage(user, pid, true);
          if (p.workspace_id !== wid())
            throw new HttpError(
              400,
              "Seiten aus einem anderen Arbeitsbereich.",
            );
          return p;
        });
        // Pages inside another selected page travel with their ancestor.
        const covered = new Set<string>();
        for (const p of pages)
          for (const child of descendants(p.id))
            if (child !== p.id) covered.add(child);
        const roots = pages.filter((p) => !covered.has(p.id));
        const created: string[] = [];
        let previous: string | undefined;
        for (const p of roots) {
          if (operation === "delete")
            command(user, { action: "page.delete", pageId: p.id }, true);
          else if (operation === "duplicate")
            created.push(
              (
                command(
                  user,
                  { action: "page.duplicate", pageId: p.id },
                  true,
                ) as { id: string }
              ).id,
            );
          else {
            // Keep the selection order: the first root goes to the target,
            // every further root directly after the previous one.
            command(
              user,
              previous
                ? {
                    action: "page.move",
                    pageId: p.id,
                    targetId: previous,
                    placement: "after",
                  }
                : {
                    action: "page.move",
                    pageId: p.id,
                    ...(b.parentId
                      ? { targetId: b.parentId, placement: "inside" }
                      : { spaceId: b.spaceId, parentId: null }),
                  },
              true,
            );
            previous = p.id;
          }
        }
        result = { ok: true, count: roots.length, created };
        break;
      }
      case "page.move": {
        const p = write(),
          subtree = descendants(p.id);
        const placement = z
          .enum(["before", "after", "inside"])
          .parse(b.placement || "inside");
        const target = b.targetId
          ? requirePage(user, uuid.parse(b.targetId), true)
          : null;
        const parent = target
          ? placement === "inside"
            ? target.id
            : target.parent_id
          : b.parentId
            ? uuid.parse(b.parentId)
            : null;
        const destinationParent = parent
          ? requirePage(user, parent, true)
          : null;
        const sid =
          destinationParent?.space_id ||
          target?.space_id ||
          (b.spaceId ? uuid.parse(b.spaceId) : p.space_id);
        const destination = one<Space>("SELECT * FROM spaces WHERE id=?", sid);
        if (
          !destination ||
          destination.workspace_id !== p.workspace_id ||
          target?.id === p.id ||
          (parent && subtree.includes(parent))
        )
          throw new HttpError(400, "Ungültiges Verschieben.");
        if (destinationParent?.locked)
          throw new HttpError(409, "Zielseite ist gesperrt.");
        if (
          !destinationParent &&
          !["editor", "owner"].includes(spaceRole(user, destination) || "")
        )
          throw new HttpError(403, "Keine Schreibrechte im Zielbereich.");
        subtree.forEach((child) => requirePage(user, child, true, true));
        for (const child of subtree)
          run("UPDATE pages SET space_id=? WHERE id=?", sid, child);
        run(
          "UPDATE pages SET parent_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
          parent,
          p.id,
        );
        const siblings = all<{ id: string }>(
          "SELECT id FROM pages WHERE space_id=? AND parent_id IS ? AND deleted_at IS NULL AND id!=? ORDER BY position,id",
          sid,
          parent,
          p.id,
        ).map((x) => x.id);
        const index =
          target && placement !== "inside"
            ? siblings.indexOf(target.id) + (placement === "after" ? 1 : 0)
            : siblings.length;
        siblings.splice(Math.max(0, index), 0, p.id);
        siblings.forEach((sibling, i) =>
          run("UPDATE pages SET position=? WHERE id=?", i, sibling),
        );
        break;
      }
      case "page.delete": {
        const p = write();
        const subtree = descendants(p.id);
        subtree.forEach((child) => requirePage(user, child, true, true));
        for (const child of subtree) {
          run(
            "DELETE FROM publication_pages WHERE page_id=? OR root_id=?",
            child,
            child,
          );
          run("DELETE FROM publications WHERE page_id=?", child);
          run("DELETE FROM share_links WHERE root_id=?", child);
          run("DELETE FROM share_link_pages WHERE page_id=?", child);
          run(
            "UPDATE pages SET deleted_at=CURRENT_TIMESTAMP,public_token=NULL WHERE id=?",
            child,
          );
        }
        break;
      }
      case "page.restore": {
        const p = requirePage(user, pid(), true, true);
        if (
          p.parent_id &&
          one<Page>("SELECT * FROM pages WHERE id=?", p.parent_id)?.deleted_at
        )
          run("UPDATE pages SET parent_id=NULL WHERE id=?", p.id);
        for (const child of descendants(p.id))
          run("UPDATE pages SET deleted_at=NULL WHERE id=?", child);
        break;
      }
      case "page.duplicate": {
        result = duplicatePageTree(user, write());
        break;
      }
      case "favorite":
        requirePage(user, pid());
        if (b.value)
          run("INSERT OR IGNORE INTO favorites VALUES(?,?)", user.id, pid());
        else
          run(
            "DELETE FROM favorites WHERE user_id=? AND page_id=?",
            user.id,
            pid(),
          );
        break;
      case "linked.command":
        result = mutateLinkedDatabase(user, b);
        break;
      case "document.sync": {
        const p = write();
        if (p.kind !== "document") throw new HttpError(400, "Kein Dokument.");
        const update = z.string().max(8_000_000).parse(b.update);
        const d = new Y.Doc();
        const existing = one<{
          state: Uint8Array | null;
          html: string;
          generation: string;
        }>("SELECT * FROM documents WHERE page_id=?", p.id);
        if (b.generation !== existing?.generation)
          throw new HttpError(
            409,
            "Eine neue Dokumentversion ist verfügbar. Die Seite wird neu geladen.",
          );
        if (
          existing?.state &&
          !one(
            "SELECT id FROM snapshots WHERE page_id=? AND created_at>datetime('now','-5 minutes')",
            p.id,
          )
        ) {
          run(
            "INSERT INTO snapshots(id,page_id,state,html,title,created_by) VALUES(?,?,?,?,?,?)",
            id(),
            p.id,
            existing.state,
            existing.html,
            p.title,
            user.id,
          );
        }
        try {
          if (existing?.state) Y.applyUpdate(d, existing.state);
          Y.applyUpdate(d, Buffer.from(update, "base64"));
          const merged = Y.encodeStateAsUpdate(d),
            canonical = stateHtml(d);
          for (const match of canonical.matchAll(/data-mention="([^"]+)"/g)) {
            const uid = match[1];
            if (
              uid !== user.id &&
              !existing?.html.includes('data-mention="' + uid + '"') &&
              pageRole({ ...user, id: uid }, p)
            )
              run(
                "INSERT INTO notifications(id,user_id,body,page_id) VALUES(?,?,?,?)",
                id(),
                uid,
                `${user.name} hat dich in „${p.title}“ erwähnt`,
                p.id,
              );
          }
          run(
            "UPDATE documents SET state=?,html=?,updated_at=CURRENT_TIMESTAMP WHERE page_id=?",
            merged,
            canonical,
            p.id,
          );
          run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", p.id);
          result = { state: Buffer.from(merged).toString("base64") };
        } finally {
          d.destroy();
        }
        break;
      }
      case "page.snapshot": {
        const p = write(),
          d = one<{ state: Uint8Array | null; html: string }>(
            "SELECT * FROM documents WHERE page_id=?",
            p.id,
          );
        if (p.kind === "database") {
          const sid = databaseSnapshot(user, p);
          run("UPDATE snapshots SET kind='manual' WHERE id=?", sid);
          result = { id: sid };
          break;
        }
        const sid = id();
        run(
          "INSERT INTO snapshots(id,page_id,state,html,title,created_by,kind) VALUES(?,?,?,?,?,?,'manual')",
          sid,
          p.id,
          d?.state || null,
          d?.html || "",
          p.title,
          user.id,
        );
        result = { id: sid };
        break;
      }
      case "snapshot.restore": {
        const p = write(),
          s = one<{
            state: Uint8Array | null;
            html: string;
            title: string;
            appearance: string | null;
          }>(
            "SELECT * FROM snapshots WHERE id=? AND page_id=?",
            uuid.parse(b.snapshotId),
            p.id,
          );
        if (!s) throw new HttpError(404, "Version nicht gefunden.");
        const appearance = snapshotAppearance(p.id, s.appearance);
        if (appearance) applyAppearance(p.id, appearance);
        if (p.kind === "document")
          run(
            "UPDATE documents SET state=?,html=?,generation=? WHERE page_id=?",
            htmlState(s.html),
            s.html,
            id(),
            p.id,
          );
        else {
          const data = JSON.parse(s.html);
          run(
            "UPDATE databases SET fields=?,views=?,version=version+1 WHERE page_id=?",
            JSON.stringify(data.database.fields),
            JSON.stringify(data.database.views),
            p.id,
          );
          if (Array.isArray(data.comments))
            run("DELETE FROM comments WHERE page_id=?", p.id);
          run("DELETE FROM rows WHERE page_id=?", p.id);
          for (const r of data.rows)
            run(
              "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content,icon,cover,recurrence) VALUES(?,?,?,?,?,?,?,?,?,?)",
              r.id,
              p.id,
              JSON.stringify(r.cells),
              r.position,
              user.id,
              user.id,
              r.content || "",
              restorableImage(p.id, r.icon, validateIcon),
              restorableImage(p.id, r.cover, validateCover),
              typeof r.recurrence === "string" ? r.recurrence : "",
            );
          if (Array.isArray(data.rowTemplates)) {
            run("DELETE FROM row_templates WHERE page_id=?", p.id);
            for (const t of data.rowTemplates)
              run(
                "INSERT INTO row_templates(id,page_id,name,cells,html,is_default,created_by) VALUES(?,?,?,?,?,?,?)",
                id(),
                p.id,
                t.name,
                JSON.stringify(t.cells),
                t.html,
                t.is_default,
                user.id,
              );
          }
          if (Array.isArray(data.inlineThreads)) {
            const restoredThreads = archivedThreadsSchema.parse(
              data.inlineThreads,
            );
            const restoredRows = new Map<string, string>(
              data.rows.map((r: { id: string }) => [r.id, r.id]),
            );
            for (const t of restoredThreads) {
              if (!t.row_id || !restoredRows.has(t.row_id))
                throw new HttpError(
                  400,
                  "Ungültiger Datensatzkommentar in der Version.",
                );
              ensureRowDocument(requireRow(user, p.id, t.row_id).row);
            }
            importInlineComments(p.id, restoredThreads, restoredRows, user.id);
          }
          if (data.formConfig)
            run(
              "UPDATE forms SET config=? WHERE page_id=?",
              JSON.stringify(formConfigSchema.parse(data.formConfig)),
              p.id,
            );
          if (Array.isArray(data.comments))
            for (const c of data.comments)
              run(
                "INSERT INTO comments(id,page_id,row_id,author_id,body,resolved,created_at) VALUES(?,?,?,?,?,?,?)",
                c.id,
                p.id,
                c.row_id,
                c.author_id,
                c.body,
                c.resolved,
                c.created_at,
              );
          restoreRelationPairs(user, p.id, data.relationPairs);
        }
        run(
          "UPDATE pages SET title=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
          s.title,
          p.id,
        );
        break;
      }
      case "database.update": {
        autoDatabaseSnapshot(user, write());
        const d = database(pid());
        if (b.version !== d.version)
          throw new HttpError(
            409,
            "Die Datenbank wurde zwischenzeitlich geändert. Bitte neu laden.",
          );
        const fields = z.array(field).min(1).max(80).parse(b.fields);
        if (
          d.fields.some((old) =>
            fields.some((next) => next.id === old.id && next.name !== old.name),
          )
        )
          for (const next of fields) {
            const old = d.fields.find((f) => f.id === next.id);
            if (
              next.type === "formula" &&
              next.formula &&
              next.formula === old?.formula
            )
              next.formula = field.shape.formula.parse(
                rewriteFormulaReferences(next.formula, d.fields, "store"),
              );
          }
        const currentFields = new Set(fields.map((f) => f.id)),
          deletedFields = new Set(
            d.fields.filter((f) => !currentFields.has(f.id)).map((f) => f.id),
          );
        const cleanFilter = (f: Filter) => {
          if (deletedFields.has(f.field)) return null;
          if (!currentFields.has(f.field))
            throw new HttpError(
              400,
              "Filter verweist auf eine unbekannte Eigenschaft.",
            );
          return f;
        };
        const views = z
          .array(view)
          .min(1)
          .max(30)
          .parse(b.views)
          .map((v) => ({
            ...v,
            filters: v.filters.flatMap((f) => (cleanFilter(f) ? [f] : [])),
            sorts: v.sorts.filter((s) => !deletedFields.has(s.field)),
            ...(v.filterGroup
              ? {
                  filterGroup: transformFilterGroup(v.filterGroup, cleanFilter),
                }
              : {}),
          }));
        if (
          new Set(fields.map((f) => f.id)).size !== fields.length ||
          new Set(views.map((v) => v.id)).size !== views.length
        )
          throw new HttpError(400, "Doppelte Eigenschaft oder Ansicht.");
        validateDatabaseRelations(user, write(), fields, d.fields);
        for (const v of views) {
          try {
            if (v.calculations)
              v.calculations = validateCalculations(
                v.calculations,
                fields,
                d.fields,
              );
          } catch (error) {
            throw new HttpError(400, (error as Error).message);
          }
          if (
            v.gallery?.cover === "field" &&
            !fields.some(
              (f) => f.id === v.gallery!.fieldId && f.type === "files",
            )
          ) {
            if (d.fields.some((f) => f.id === v.gallery!.fieldId))
              v.gallery = { ...v.gallery, cover: "none", fieldId: undefined };
            else
              throw new HttpError(
                400,
                "Galerie verweist auf eine unbekannte Bildeigenschaft.",
              );
          }
        }
        validateViewRowOrders(pid(), views);
        run(
          "UPDATE databases SET fields=?,views=?,version=version+1 WHERE page_id=?",
          JSON.stringify(fields),
          JSON.stringify(views),
          pid(),
        );
        configureRelation(user, pid(), d.version, b.relation);
        break;
      }
      case "row.schedule":
        result = scheduleRow(user, pid(), b);
        break;
      case "row.move":
        result = moveRow(user, pid(), b);
        break;
      case "rows.bulk":
        result = bulkRows(user, pid(), b);
        break;
      case "row.create": {
        autoDatabaseSnapshot(user, write());
        const template = selectedRowTemplate(pid(), b.templateId);
        const cells = {
          ...(template ? JSON.parse(template.cells) : {}),
          ...z.record(z.string(), z.unknown()).parse(b.cells || {}),
        };
        if (JSON.stringify(cells).length > 200000)
          throw new HttpError(413, "Datensatz zu groß.");
        const rid = id();
        run(
          "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
          rid,
          pid(),
          JSON.stringify(cells),
          Date.now(),
          user.id,
          user.id,
        );
        if (template) replaceRowDocument(rid, template.html, user.id);
        result = { id: rid };
        break;
      }
      case "row.document.sync":
        result = syncRowDocument(
          user,
          pid(),
          uuid.parse(b.rowId),
          b.generation,
          b.update,
        );
        break;
      case "row.snapshot":
        result = snapshotRow(user, pid(), uuid.parse(b.rowId));
        break;
      case "row.snapshot.restore":
        restoreRow(user, pid(), uuid.parse(b.rowId), b.snapshotId);
        break;
      case "row.template.save":
        result = saveRowTemplate(user, pid(), uuid.parse(b.rowId), b.name);
        break;
      case "row.template.default":
        manageRowTemplate(
          user,
          pid(),
          b.templateId,
          "default",
          b.enabled === true,
        );
        break;
      case "row.template.delete":
        manageRowTemplate(user, pid(), b.templateId, "delete");
        break;
      case "rows.import": {
        write();
        const imported = z
          .array(z.record(z.string(), z.unknown()))
          .max(5000)
          .parse(b.rows);
        imported.forEach((cells, i) =>
          run(
            "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
            id(),
            pid(),
            JSON.stringify(cells),
            Date.now() + i,
            user.id,
            user.id,
          ),
        );
        break;
      }
      case "row.update": {
        const p = write();
        autoDatabaseSnapshot(user, p);
        const rid = uuid.parse(b.rowId),
          row = one<{ version: number; cells: string }>(
            "SELECT * FROM rows WHERE id=? AND page_id=?",
            rid,
            pid(),
          );
        if (!row) throw new HttpError(404, "Datensatz fehlt.");
        if (b.version !== row.version)
          throw new HttpError(
            409,
            "Datensatz wurde geändert. Bitte neu laden.",
          );
        if (b.content !== undefined)
          throw new HttpError(
            400,
            "Dokumentinhalt über den Dokumenteditor bearbeiten.",
          );
        const cells = {
          ...JSON.parse(row.cells),
          ...validateCellPatch(user, p, database(pid()).fields, b.cells || {}),
        };
        if (JSON.stringify(cells).length > 200000)
          throw new HttpError(413, "Datensatz zu groß.");
        run(
          "UPDATE rows SET cells=?,content=COALESCE(?,content),updated_at=CURRENT_TIMESTAMP,updated_by=?,version=version+1 WHERE id=?",
          JSON.stringify(cells),
          b.content === undefined
            ? null
            : z.string().max(200000).parse(b.content),
          user.id,
          rid,
        );
        break;
      }
      case "row.delete": {
        const p = write();
        autoDatabaseSnapshot(user, p);
        trashRow(user, p, uuid.parse(b.rowId));
        maintainRowOrders(pid());
        break;
      }
      case "row.trash.restore":
        result = restoreTrashedRow(user, b);
        break;
      case "row.trash.purge":
        result = purgeTrashedRow(user, b);
        break;
      case "favorite.row": {
        const { row } = requireRow(user, pid(), uuid.parse(b.rowId));
        if (b.value)
          run(
            "INSERT OR IGNORE INTO row_favorites(user_id,row_id,page_id) VALUES(?,?,?)",
            user.id,
            row.id,
            pid(),
          );
        else
          run(
            "DELETE FROM row_favorites WHERE user_id=? AND row_id=?",
            user.id,
            row.id,
          );
        break;
      }
      case "thread.create":
      case "thread.reply":
      case "thread.resolve":
      case "thread.edit":
      case "thread.deleteMessage":
      case "thread.react":
        result = inlineCommentCommand(user, b);
        break;
      case "comment.create": {
        const p = requirePage(user, pid());
        if (b.rowId) requireRow(user, p.id, uuid.parse(b.rowId));
        const body = z.string().trim().min(1).max(5000).parse(b.body);
        run(
          "INSERT INTO comments(id,page_id,row_id,author_id,body) VALUES(?,?,?,?,?)",
          id(),
          p.id,
          b.rowId ? uuid.parse(b.rowId) : null,
          user.id,
          body,
        );
        for (const m of all<{ user_id: string }>(
          "SELECT user_id FROM members WHERE workspace_id=? AND user_id!=?",
          p.workspace_id,
          user.id,
        )) {
          const other = { ...user, id: m.user_id };
          if (pageRole(other, p))
            run(
              "INSERT INTO notifications(id,user_id,body,page_id,row_id) VALUES(?,?,?,?,?)",
              id(),
              m.user_id,
              `${user.name} kommentiert „${p.title}“`,
              p.id,
              b.rowId ? uuid.parse(b.rowId) : null,
            );
        }
        break;
      }
      case "comment.resolve":
        requirePage(user, pid(), true);
        run(
          "UPDATE comments SET resolved=? WHERE id=? AND page_id=?",
          b.resolved ? 1 : 0,
          uuid.parse(b.commentId),
          pid(),
        );
        run(
          "UPDATE shared_comments SET resolved=? WHERE id=? AND page_id=?",
          b.resolved ? 1 : 0,
          uuid.parse(b.commentId),
          pid(),
        );
        break;
      case "row.appearance":
        result = setRowAppearance(user, b);
        break;
      case "row.recurrence":
        result = setRowRecurrence(user, b);
        break;
      case "reminder.set":
        result = setDateReminder(user, b);
        break;
      case "notification.read":
        run(
          "UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE user_id=?",
          user.id,
        );
        break;
      case "share.create":
      case "share.revoke":
        result = manageShareLink(user, b);
        break;
      case "page.publish": {
        const p = write();
        publishPage(
          user,
          p,
          z.boolean().parse(b.enabled),
          z.boolean().optional().parse(b.includeChildren) ?? false,
          z.boolean().optional().parse(b.allowCopy) ?? true,
        );
        break;
      }
      case "publication.copy":
        result = copyPublication(user, b);
        break;
      case "form.update": {
        write();
        database(pid());
        const previous = formSettings(pid()),
          config =
            b.config === undefined
              ? previous?.config || formConfigSchema.parse({})
              : formConfigSchema.parse(b.config);
        run(
          "INSERT INTO forms(page_id,token,enabled,internal,anonymous,config) VALUES(?,?,?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET enabled=excluded.enabled,internal=excluded.internal,anonymous=excluded.anonymous,config=excluded.config",
          pid(),
          id(),
          b.enabled === undefined ? previous?.enabled || 0 : b.enabled ? 1 : 0,
          b.internal === undefined
            ? (previous?.internal ?? 1)
            : b.internal
              ? 1
              : 0,
          b.anonymous === undefined
            ? previous?.anonymous || 0
            : b.anonymous
              ? 1
              : 0,
          JSON.stringify(config),
        );
        break;
      }
      case "form.submit":
        write();
        database(pid());
        result = saveFormSubmission(
          pid(),
          user,
          z.record(z.string(), z.unknown()).parse(b.cells),
          true,
        );
        break;
      case "member.invite": {
        requireMember(user, wid(), "owner");
        const email = z.email().parse(b.email).toLowerCase(),
          role = z.enum(["editor", "viewer"]).parse(b.role);
        run(
          "INSERT INTO invites(id,workspace_id,email,role,created_by) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,email) DO UPDATE SET role=excluded.role",
          id(),
          wid(),
          email,
          role,
          user.id,
        );
        break;
      }
      case "member.role": {
        requireMember(user, wid(), "owner");
        const target = uuid.parse(b.userId),
          role = z.enum(["owner", "editor", "viewer", "remove"]).parse(b.role);
        const old = one<{ role: string }>(
          "SELECT role FROM members WHERE workspace_id=? AND user_id=?",
          wid(),
          target,
        );
        if (
          old?.role === "owner" &&
          role !== "owner" &&
          all(
            "SELECT user_id FROM members WHERE workspace_id=? AND role=?",
            wid(),
            "owner",
          ).length <= 1
        )
          throw new HttpError(400, "Der letzte Eigentümer muss bleiben.");
        if (role === "remove")
          run(
            "DELETE FROM members WHERE workspace_id=? AND user_id=?",
            wid(),
            target,
          );
        else
          run(
            "UPDATE members SET role=? WHERE workspace_id=? AND user_id=?",
            role,
            wid(),
            target,
          );
        break;
      }
      case "grant.set": {
        const resource = uuid.parse(b.resourceId);
        const p = one<Page>("SELECT * FROM pages WHERE id=?", resource),
          s = one<Space>("SELECT * FROM spaces WHERE id=?", resource);
        if (!p && !s) throw new HttpError(404, "Ressource fehlt.");
        requireMember(user, (p || s)!.workspace_id, "owner");
        const uid = b.userId ? uuid.parse(b.userId) : "",
          gid = b.groupId ? uuid.parse(b.groupId) : "";
        if (!uid && !gid)
          throw new HttpError(400, "Mitglied oder Gruppe erforderlich.");
        if (
          uid &&
          !one(
            "SELECT 1 FROM members WHERE workspace_id=? AND user_id=?",
            (p || s)!.workspace_id,
            uid,
          )
        )
          throw new HttpError(400, "Mitglied fehlt.");
        if (
          gid &&
          !one(
            "SELECT 1 FROM groups WHERE id=? AND workspace_id=?",
            gid,
            (p || s)!.workspace_id,
          )
        )
          throw new HttpError(400, "Gruppe fehlt.");
        run(
          "DELETE FROM grants WHERE resource_id=? AND user_id=? AND group_id=?",
          resource,
          uid,
          gid,
        );
        if (b.role !== "remove")
          run(
            "INSERT INTO grants VALUES(?,?,?,?)",
            resource,
            uid,
            gid,
            z.enum(["editor", "viewer"]).parse(b.role),
          );
        break;
      }
      case "group.create": {
        requireMember(user, wid(), "owner");
        const gid = id();
        run("INSERT INTO groups VALUES(?,?,?)", gid, wid(), str.parse(b.name));
        result = { id: gid };
        break;
      }
      case "group.member": {
        const gid = uuid.parse(b.groupId),
          g = one<{ workspace_id: string }>(
            "SELECT * FROM groups WHERE id=?",
            gid,
          );
        if (!g) throw new HttpError(404, "Gruppe fehlt");
        requireMember(user, g.workspace_id, "owner");
        const uid = uuid.parse(b.userId);
        if (
          !one(
            "SELECT 1 FROM members WHERE workspace_id=? AND user_id=?",
            g.workspace_id,
            uid,
          )
        )
          throw new HttpError(400, "Mitglied fehlt");
        if (b.enabled)
          run("INSERT OR IGNORE INTO group_members VALUES(?,?)", gid, uid);
        else
          run(
            "DELETE FROM group_members WHERE group_id=? AND user_id=?",
            gid,
            uid,
          );
        break;
      }
      case "template.save": {
        const p = write();
        const payload =
          p.kind === "database"
            ? JSON.stringify({
                appearance: pageAppearance(p),
                database: database(p.id),
                rows: rows(p.id),
                ...databaseTemplateExtras(p.id),
              })
            : JSON.stringify({
                appearance: pageAppearance(p),
                html:
                  one<{ html: string }>(
                    "SELECT html FROM documents WHERE page_id=?",
                    p.id,
                  )?.html || "",
              });
        const templateId = id();
        if (payload.length > 20_000_000)
          throw new HttpError(413, "Vorlage zu groß.");
        run(
          "INSERT INTO templates(id,workspace_id,name,kind,payload,created_by,visibility) VALUES(?,?,?,?,?,?,?)",
          templateId,
          p.workspace_id,
          str.parse(b.name),
          p.kind,
          payload,
          user.id,
          b.private ? "private" : "workspace",
        );
        captureTemplateFiles(user, templateId, payload);
        result = { id: templateId };
        break;
      }
      case "template.update":
      case "template.delete":
      case "template.restore":
        result = managePageTemplate(user, b);
        break;
      case "template.apply": {
        const p = write();
        const template = requireTemplate(user, b.templateId, p.workspace_id);
        if (p.kind === "database" && b.version !== database(p.id).version)
          throw new HttpError(
            409,
            "Die Datenbank wurde zwischenzeitlich geändert. Bitte neu laden.",
          );
        result = applyPageTemplate(user, p, template);
        break;
      }
      case "admin.user": {
        requireAdmin(user);
        const uid = uuid.parse(b.userId);
        if (uid === user.id)
          throw new HttpError(
            400,
            "Eigenes Konto kann nicht deaktiviert werden.",
          );
        run("UPDATE users SET disabled=? WHERE id=?", b.disabled ? 1 : 0, uid);
        if (b.disabled) run("DELETE FROM sessions WHERE user_id=?", uid);
        break;
      }
      case "admin.quota": {
        requireAdmin(user);
        const quota = z
          .number()
          .int()
          .min(0)
          .max(10_000_000)
          .nullable()
          .parse(b.quotaMb);
        setWorkspaceQuota(uuid.parse(b.workspaceId), quota);
        break;
      }
      case "admin.revoke":
        requireAdmin(user);
        run("DELETE FROM sessions WHERE user_id=?", uuid.parse(b.userId));
        break;
      default:
        throw new HttpError(400, "Unbekannte Aktion.");
    }
    if (
      ![
        "document.sync",
        "row.document.sync",
        "notification.read",
        "favorite",
      ].includes(action)
    )
      audit(
        user.id,
        action,
        String(b.pageId || b.spaceId || b.workspaceId || b.userId || ""),
      );
    return result;
  };
  return withinTransaction ? execute() : transaction(execute, user);
}
function createWorkspaceInner(user: string, name: string) {
  const wid = id(),
    sid = id();
  run(
    "INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)",
    wid,
    name,
    user,
  );
  run("INSERT INTO members VALUES(?,?,?)", wid, user, "owner");
  run(
    "INSERT INTO spaces(id,workspace_id,name,owner_id) VALUES(?,?,?,?)",
    sid,
    wid,
    "Teamspace",
    user,
  );
  createPage(wid, sid, user, "Willkommen");
  return wid;
}
import { inlineCommentCommand } from "./inline-comments";
import {
  archivedThreadsSchema,
  importInlineComments,
} from "./inline-comment-archive";
import { ensureRowDocument } from "./row-documents";
import { listDateReminders, setDateReminder } from "./date-reminders";
import { setRowAppearance, setRowRecurrence } from "./row-appearance";
import { copyPublication } from "./publication-copy";
import { purgeTrashedRow, restoreTrashedRow, trashRow } from "./row-trash";
import { setWorkspaceQuota } from "./instance-ops";
