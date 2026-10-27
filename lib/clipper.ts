// The browser extension (extensions/browser): it signs in with a personal
// API token of the scope "clipper" (or "write") and only talks to the two
// endpoints here – the targets it may save to and saving a clip. Answers
// carry CORS headers for browser-extension origins only, never for web
// pages, and never allow cookies: the bearer token is the only credential.
// Clipped HTML comes from the content script and is sanitised here.
import { z } from "zod";
import { parseDocument, DomUtils } from "htmlparser2";
import { all, audit, one, run, transaction } from "./db";
import { SPACE_ORDER } from "./space-order";
import { HttpError, appUrl } from "./auth";
import { identityFromApiToken } from "./api-tokens";
import { pageRole, requireMember, requirePage, spaceRole } from "./permissions";
import { journalLocked, lockedPageIds } from "./journal-extras";
import { createPage } from "./seed";
import { cleanHtml, htmlState } from "./document-server";
import { captureRecord } from "./capture";
import { addBookmarks, bookmarksDatabase } from "./web-clip";
import { appendHtmlToPage } from "./mcp";
import { ct } from "./content-locale";
import { encryptedSpace, requirePlaintext, requirePlaintextSpace } from "./e2ee-server";
import type { Field, Identity, Page, Space } from "./types";

// chrome-extension://<32 letters> (Chrome, Edge, Brave, Opera),
// moz-extension://<uuid> (Firefox), safari-web-extension://<uuid>.
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\/[a-z0-9-]{16,64}$/i;
export const isExtensionOrigin = (origin: string | null) => !!origin && EXTENSION_ORIGIN.test(origin);

export function clipperCors(origin: string | null): Record<string, string> {
  if (!isExtensionOrigin(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin!,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
    "Access-Control-Expose-Headers": "Idempotent-Replayed, Retry-After",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

// Only a bearer token counts here; a browser session cookie is ignored, so
// another site can never use someone's session through these endpoints.
export function clipperUser(authorization: string | null): Identity {
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Bitte melde dich mit einem API-Token an.");
  const user = identityFromApiToken(authorization, { clipper: true });
  if (!user) throw new HttpError(401, "Das API-Token ist ungültig oder abgelaufen.");
  if (user.apiScope !== "clipper" && user.apiScope !== "write") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  return user;
}

const rank: Record<string, number> = { viewer: 1, commenter: 1, editor: 2, owner: 3 };
const writable = (user: Identity, page: Page) =>
  !page.deleted_at && !page.locked && ["document", "database"].includes(page.kind) && rank[pageRole(user, page) || ""] >= 2 && !journalLocked(user, page);
const MAX_TARGET_PAGES = 400;

// Workspaces, spaces and pages (documents and databases) this person may
// save to, newest first.
export function clipperTargets(user: Identity) {
  const workspaces = all<{ id: string; name: string }>(
    "SELECT w.id,w.name FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=? AND m.role IN ('owner','editor') ORDER BY w.name COLLATE NOCASE",
    user.id,
  );
  return {
    user: { name: user.name },
    workspaces: workspaces.map((w) => {
      // End-to-end encrypted spaces are left out: the server never writes
      // plaintext into them.
      const spaces = all<Space>(`SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NULL ORDER BY ${SPACE_ORDER}`, w.id).filter(
        (s) => ["editor", "owner"].includes(spaceRole(user, s) || "") && !encryptedSpace(s.id),
      );
      const names = new Map(spaces.map((s) => [s.id, s.name]));
      const locked = lockedPageIds(user, w.id);
      const pages = all<Page>(
        "SELECT * FROM pages WHERE workspace_id=? AND kind IN ('document','database') AND deleted_at IS NULL AND synced=0 AND journal_date IS NULL ORDER BY updated_at DESC LIMIT 2000",
        w.id,
      )
        .filter((p) => names.has(p.space_id) && !locked.has(p.id) && writable(user, p))
        .slice(0, MAX_TARGET_PAGES)
        .map((p) => ({ id: p.id, title: p.title, kind: p.kind, space: p.space_id, bookmarks: p.kind === "database" && isBookmarks(p.id) }));
      return { id: w.id, name: w.name, spaces: spaces.map((s) => ({ id: s.id, name: s.name })), pages };
    }),
  };
}
const isBookmarks = (pageId: string) => !!one("SELECT 1 FROM databases WHERE page_id=? AND fields LIKE '%\"id\":\"bm_url\"%'", pageId);

// ---- Sanitising ----

const MAX_CLIP_HTML = 250_000;
// Clipped HTML: addresses made absolute against the page, lazy images
// resolved, page styling dropped, then the editor's usual cleaning.
export function clipHtml(html: string, baseUrl: string) {
  const doc = parseDocument(html.slice(0, 2_000_000), { decodeEntities: true });
  const absolute = (value: string, schemes: RegExp) => {
    try {
      const url = new URL(value.trim(), baseUrl);
      return schemes.test(url.protocol) ? url.toString() : null;
    } catch {
      return null;
    }
  };
  for (const el of DomUtils.findAll(() => true, doc.children)) {
    const attribs = el.attribs;
    if (el.name === "a") {
      const href = absolute(attribs.href || "", /^(https?|mailto):$/);
      if (href) attribs.href = href;
      else delete attribs.href;
    }
    if (el.name === "img") {
      const lazy = attribs["data-src"] || attribs["data-original"] || (attribs.srcset || attribs["data-srcset"] || "").split(",")[0]?.trim().split(/\s+/)[0] || "";
      const src = absolute(!attribs.src || attribs.src.startsWith("data:") ? lazy || attribs.src || "" : attribs.src, /^https?:$/);
      if (src) attribs.src = src;
      else delete attribs.src;
    }
    for (const name of Object.keys(attribs)) if (/^(style|class|id|on.*|data-.*|srcset|width|height)$/i.test(name)) delete attribs[name];
  }
  const clean = cleanHtml(DomUtils.getOuterHTML(doc.children))
    .replace(/<img(?![^>]*\ssrc=)[^>]*>/g, "")
    .trim();
  if (clean.length > MAX_CLIP_HTML) throw new HttpError(413, "Der Ausschnitt ist zu groß.");
  return clean;
}

// ---- Saving ----

const httpUrl = z
  .string()
  .max(2000)
  .refine((v) => /^https?:\/\//i.test(v), "Ungültige Adresse.");
const clipSchema = z.object({
  mode: z.enum(["page", "selection", "bookmark", "highlight"]),
  target: z.object({ workspaceId: z.uuid(), spaceId: z.uuid().optional(), pageId: z.uuid().optional() }),
  url: httpUrl,
  title: z.string().max(300).optional(),
  description: z.string().max(2000).optional(),
  favicon: z.string().max(2000).optional(),
  html: z.string().max(2_000_000).optional(),
  text: z.string().max(20_000).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});
export type ClipInput = z.infer<typeof clipSchema>;

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const link = (url: string, title?: string) => `<a href="${esc(url)}">${esc(title?.trim() || url)}</a>`;
const openUrl = (pageId: string, rowId?: string) => `${appUrl().replace(/\/$/, "")}/#page=${pageId}${rowId ? `&row=${rowId}` : ""}`;

// A space the person may create pages in.
function writableSpace(user: Identity, workspaceId: string, spaceId: string) {
  requireMember(user, workspaceId, "editor");
  const space = one<Space>("SELECT * FROM spaces WHERE id=? AND workspace_id=? AND deleted_at IS NULL", spaceId, workspaceId);
  if (!space || !["editor", "owner"].includes(spaceRole(user, space) || "")) throw new HttpError(403, "Keine Schreibrechte im Zielbereich.");
  requirePlaintextSpace(space);
  return space;
}
function targetPage(user: Identity, workspaceId: string, pageId: string) {
  const page = requirePage(user, pageId, true);
  if (page.workspace_id !== workspaceId) throw new HttpError(400, "Nur innerhalb eines Arbeitsbereichs.");
  if (!writable(user, page)) throw new HttpError(403, "In diese Seite kann nicht gespeichert werden.");
  requirePlaintext(page);
  return page;
}

// Tags into a multi-select (or select) property named "Tags" or
// "Schlagwörter"; for bookmarks a "Tags" property is added on first use.
function tagRecord(pageId: string, rowId: string, tags: string[], create = false) {
  if (!tags.length) return;
  const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)!.fields) as Field[];
  let field = fields.find((f) => ["multiselect", "select"].includes(f.type) && /^(tags?|schlagw(ö|oe)rter|stichw(ö|oe)rter|labels?)$/i.test(f.name.trim()));
  if (!field && create) {
    field = { id: "bm_tags", name: ct("Tags", "Tags"), type: "multiselect", options: [] };
    fields.push(field);
  }
  if (!field) return;
  const options = field.options || [];
  for (const tag of tags) if (!options.some((o) => o.toLowerCase() === tag.toLowerCase()) && options.length < 300) options.push(tag);
  field.options = options;
  const chosen = tags.map((tag) => options.find((o) => o.toLowerCase() === tag.toLowerCase())).filter((t): t is string => !!t);
  const cells = JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId)!.cells) as Record<string, unknown>;
  cells[field.id] = field.type === "select" ? chosen[0] : [...new Set(chosen)];
  run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(fields), pageId);
  run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify(cells), rowId);
}

export function saveClip(user: Identity, raw: unknown) {
  const input = clipSchema.parse(raw);
  const { workspaceId } = input.target;
  const title = (input.title?.trim() || new URL(input.url).hostname).slice(0, 200);
  const tags = [...new Set(input.tags || [])];
  const tagLine = tags.length ? `<p>${tags.map((t) => `#${esc(t)}`).join(" ")}</p>` : "";
  const target = input.target.pageId ? targetPage(user, workspaceId, input.target.pageId) : null;
  const space = target ? null : writableSpace(user, workspaceId, z.uuid().parse(input.target.spaceId));
  const result = transaction(() => {
    if (input.mode === "bookmark") {
      // The space's bookmarks database, or the chosen one if it is one.
      const db = target?.kind === "database" && isBookmarks(target.id) ? target.id : bookmarksDatabase(workspaceId, target?.space_id || space!.id, user.id);
      requirePage(user, db, true);
      const saved = addBookmarks(db, user.id, [{ title, url: input.url, note: input.description?.slice(0, 2000) }]);
      if (!saved.added) throw new HttpError(409, "Dieser Link ist schon unter den Lesezeichen.");
      const rowId = saved.ids[0];
      const favicon = input.favicon && /^https:\/\//i.test(input.favicon) ? input.favicon : "";
      if (favicon) {
        // The site's icon as a link property (added on first use).
        const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", db)!.fields) as Field[];
        if (!fields.some((f) => f.id === "bm_favicon")) {
          fields.push({ id: "bm_favicon", name: ct("Favicon", "Favicon"), type: "url" });
          run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(fields), db);
        }
        const cells = JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId)!.cells);
        run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify({ ...cells, bm_favicon: favicon }), rowId);
      }
      tagRecord(db, rowId, tags, true);
      return { pageId: db, rowId };
    }
    if (input.mode === "highlight") {
      const quote = input.html ? clipHtml(input.html, input.url) : "";
      const text = input.text?.trim() || "";
      if (!quote && !text) throw new HttpError(400, "Kein Text markiert.");
      const body = `<blockquote>${quote || `<p>${esc(text).replace(/\n/g, "<br>")}</p>`}<p>— ${link(input.url, title)}</p></blockquote>`;
      if (target?.kind === "database") {
        const saved = captureRecord(user, { pageId: target.id, title, url: input.url, article: body });
        tagRecord(target.id, saved.rowId, tags);
        return { pageId: target.id, rowId: saved.rowId };
      }
      // A space: a new page for the source, later highlights are appended.
      const pageId = target?.id || createPage(workspaceId, space!.id, user.id, title, "document");
      if (!target) {
        const intro = cleanHtml(`<p>${link(input.url, input.url)}</p>${tagLine}`);
        run("UPDATE documents SET html=?,state=? WHERE page_id=?", intro, htmlState(intro), pageId);
      }
      return { pageId, append: body };
    }
    // The whole page or the selection.
    const content = input.html ? clipHtml(input.html, input.url) : input.text ? `<p>${esc(input.text).replace(/\n/g, "<br>")}</p>` : "";
    if (!content) throw new HttpError(400, "Kein Inhalt zum Speichern.");
    if (target?.kind === "database") {
      const saved = captureRecord(user, { pageId: target.id, title, url: input.url, article: content });
      tagRecord(target.id, saved.rowId, tags);
      return { pageId: target.id, rowId: saved.rowId };
    }
    const pageId = createPage(workspaceId, target?.space_id || space!.id, user.id, title, "document", target?.id || null);
    const html = cleanHtml(`<p>${link(input.url, input.url)}</p>${tagLine}<hr>${content}`);
    run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
    audit(user.id, "page.clip", pageId, input.url.slice(0, 200));
    return { pageId };
  }, user);
  // Appending goes through the document's normal sync (versions, live
  // editors), outside the transaction above.
  if ("append" in result && result.append) appendHtmlToPage(user, { pageId: result.pageId, html: result.append });
  return { pageId: result.pageId, ...("rowId" in result && result.rowId ? { rowId: result.rowId } : {}), url: openUrl(result.pageId, "rowId" in result ? result.rowId : undefined) };
}
