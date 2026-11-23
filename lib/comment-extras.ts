// What page, record and text comments carry besides their text (#450):
// attachments, mentions of pages and records, and link previews – all in
// the formatted comment (lib/comment-content.ts, the doc node's attrs and
// pageMention nodes), stored in comments.rich_body / inline_messages.rich_body.
//
// - Attachments are uploads of the comment's page (POST /api/upload with
//   purpose=comment, lib/upload-safety.ts checks): served to whoever may
//   read the page and – for a record's comment – the record
//   (lib/file-access.ts, lib/row-files.ts), counted in quotas like every
//   upload. A comment may only attach files its author uploaded to that
//   page (or that the edited comment already had); name, type and size are
//   the stored file's. Removing an attachment or deleting the comment moves
//   its file to the file trash when nothing else uses it (lib/file-trash.ts
//   rules: restorable until the trash period ends).
// - A page mention stores the page (and record) id and the title when
//   written (for the plain text: search, exports, notifications). Readers
//   get the current title – or `noAccess` without any title when they may
//   not read it. Mentioning a page notifies nobody.
// - Link previews are what GET /api/embed found for a link of the comment
//   (lib/oembed.ts, SSRF-safe) while it was written; only links the comment
//   contains keep theirs.
import { HttpError } from "./auth";
import { all, audit, nowText, one, run } from "./db";
import { pageRole } from "./permissions";
import { journalLocked } from "./journal-extras";
import { rowRoleResolver } from "./row-access";
import { publicHiddenFieldIds } from "./field-access";
import { cellText } from "./cell-text";
import { usedFileIds } from "./file-usage";
import {
  attachmentFileId,
  commentAttachments,
  commentPageMentions,
  commentText,
  mapCommentNodes,
  type CommentAttachment,
  type CommentNode,
} from "./comment-content";
import type { Field, Identity, Page } from "./types";

type Target = { title: string } | null;

// Readability and current titles of mentioned pages and records for one
// person, cached for one request (as lib/link-targets.ts).
export function mentionReader(user: Identity, workspaceId: string) {
  const pages = new Map<string, Page | null>();
  const resolvers = new Map<string, Awaited<ReturnType<typeof rowRoleResolver>>>();
  const targets = new Map<string, Target>();
  const page = async (pageId: string) => {
    if (!pages.has(pageId)) {
      const found = (await one<Page>("SELECT * FROM pages WHERE id=?", pageId)) || null;
      pages.set(
        pageId,
        found &&
          found.workspace_id === workspaceId &&
          !found.deleted_at &&
          !found.synced &&
          (await pageRole(user, found)) &&
          !(await journalLocked(user, found))
          ? found
          : null,
      );
    }
    return pages.get(pageId) || null;
  };
  return async (pageId: string, rowId?: string): Promise<Target> => {
    const key = rowId ? `${pageId}:${rowId}` : pageId;
    if (targets.has(key)) return targets.get(key)!;
    let target: Target = null;
    const found = await page(pageId);
    if (found && !rowId) target = { title: found.title || "" };
    else if (found && found.kind === "database" && rowId) {
      const row = await one<{ id: string; access: string; created_by: string; cells: string }>(
        "SELECT id,access,created_by,cells FROM rows WHERE id=? AND page_id=?",
        rowId,
        pageId,
      );
      if (row) {
        if (!resolvers.has(pageId)) resolvers.set(pageId, await rowRoleResolver(user, found));
        if (resolvers.get(pageId)!(row as never)) target = { title: await recordTitle(pageId, row.cells) };
      }
    }
    targets.set(key, target);
    return target;
  };
}
// A record's title: its first property everybody may read (as the search).
async function recordTitle(pageId: string, cells: string) {
  const stored = await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId);
  const fields = (stored ? JSON.parse(stored.fields) : []) as Field[];
  const hidden = publicHiddenFieldIds(fields);
  const first = fields.find((f) => !hidden.has(f.id));
  if (!first) return "";
  try {
    return cellText((JSON.parse(cells) as Record<string, unknown>)[first.id]).slice(0, 200);
  } catch {
    return "";
  }
}

const linkHrefs = (content: CommentNode) => {
  const hrefs = new Set<string>();
  const visit = (n: CommentNode) => {
    for (const mark of n.marks || []) if (mark.type === "link" && mark.attrs?.href) hrefs.add(mark.attrs.href);
    n.content?.forEach(visit);
  };
  visit(content);
  return hrefs;
};

// The content as stored: attachments checked against the page's files,
// page mentions checked for the author with their titles, previews only
// for links the comment has. `previous`: the stored content of the edited
// comment (what it already had stays allowed).
export async function commentContentInput(
  user: Identity,
  page: Pick<Page, "id" | "workspace_id">,
  content: CommentNode,
  previous: CommentNode | null = null,
): Promise<CommentNode> {
  const before = new Map(commentAttachments(previous).map((a) => [attachmentFileId(a.src)!, a]));
  const attachments: CommentAttachment[] = [];
  for (const attachment of commentAttachments(content)) {
    const fileId = attachmentFileId(attachment.src)!;
    const file = await one<{ page_id: string; name: string | null; mime: string | null; size: number | null; created_by: string | null; deleted_at: string | null }>(
      "SELECT page_id,name,mime,size,created_by,deleted_at FROM files WHERE id=?",
      fileId,
    );
    if (!file || file.page_id !== page.id || file.deleted_at || (file.created_by !== user.id && !before.has(fileId)))
      throw new HttpError(400, "Ein Anhang ist nicht verfügbar. Bitte entferne ihn und lade die Datei erneut hoch.");
    attachments.push({ src: `/api/files/${fileId}`, name: file.name || "Datei", mime: file.mime || "", size: Number(file.size || 0) });
  }
  const earlier = new Map<string, string>();
  if (previous)
    await mapCommentNodes(previous, (n) => {
      if (n.type === "pageMention" && n.attrs?.pageId)
        earlier.set(n.attrs.rowId ? `${n.attrs.pageId}:${n.attrs.rowId}` : n.attrs.pageId, n.attrs.label || "");
      return n;
    });
  const read = mentionReader(user, page.workspace_id);
  const links = linkHrefs(content);
  const stored = await mapCommentNodes(content, async (n) => {
    if (n.type === "pageMention" && n.attrs?.pageId) {
      const { pageId, rowId } = n.attrs;
      const key = rowId ? `${pageId}:${rowId}` : pageId;
      const target = await read(pageId, rowId);
      if (!target && !earlier.has(key))
        throw new HttpError(400, "Eine erwähnte Seite ist nicht verfügbar. Bitte entferne die Erwähnung.");
      return { type: "pageMention", attrs: { pageId, ...(rowId ? { rowId } : {}), label: (target ? target.title : earlier.get(key)) || "" } };
    }
    if (n.type !== "doc") return n;
    const { attachments: _files, previews, ...rest } = n.attrs || {};
    void _files;
    const kept = (previews || []).filter((p) => links.has(p.url));
    const attrs = { ...rest, ...(attachments.length ? { attachments } : {}), ...(kept.length ? { previews: kept } : {}) };
    const { attrs: _old, ...node } = n;
    void _old;
    return Object.keys(attrs).length ? { ...node, attrs } : node;
  });
  return stored;
}

// Whether stored content needs anything resolved for a reader.
const needsReading = (content: CommentNode) => commentAttachments(content).length > 0 || commentPageMentions(content).length > 0;

// The content as one reader sees it: page mentions with the current title,
// or `noAccess` without a title; attachments whose file is gone or in the
// trash marked `missing`. The plain text follows the titles shown.
export function commentPresenter(user: Identity, workspaceId: string) {
  const read = mentionReader(user, workspaceId);
  const files = new Map<string, boolean>();
  return async (content: CommentNode | null, body: string): Promise<{ content: CommentNode | null; body: string }> => {
    if (!content || !needsReading(content)) return { content, body };
    const shown = await mapCommentNodes(content, async (n) => {
      if (n.type === "pageMention" && n.attrs?.pageId) {
        const { pageId, rowId } = n.attrs;
        const target = await read(pageId, rowId);
        return {
          type: "pageMention",
          attrs: target ? { pageId, ...(rowId ? { rowId } : {}), label: target.title } : { pageId, ...(rowId ? { rowId } : {}), label: "", noAccess: true },
        };
      }
      if (n.type !== "doc" || !n.attrs?.attachments?.length) return n;
      const attachments: CommentAttachment[] = [];
      for (const a of n.attrs.attachments) {
        const fileId = attachmentFileId(a.src)!;
        if (!files.has(fileId))
          files.set(fileId, !!(await one("SELECT 1 FROM files WHERE id=? AND deleted_at IS NULL", fileId)));
        attachments.push(files.get(fileId) ? a : { ...a, missing: true });
      }
      return { ...n, attrs: { ...n.attrs, attachments } };
    });
    return {
      content: shown,
      body: commentPageMentions(shown).length ? commentText(shown).trim().slice(0, 5000) : body,
    };
  };
}

// " · 📎 2 Anhänge" for notification texts (no names, no content);
// lib/i18n-errors.ts translates it.
export const attachmentNote = (content: CommentNode | null | undefined) => {
  const n = commentAttachments(content).length;
  return !n ? "" : n === 1 ? " · 📎 1 Anhang" : ` · 📎 ${n} Anhänge`;
};

// Files a comment no longer has (removed in an edit, or the comment was
// deleted): those its author uploaded to the page and nothing else in the
// workspace uses go to the file trash (lib/file-trash.ts), as "Delete" in
// the media library does – restorable until the trash period ends.
export async function trashDroppedAttachments(
  user: Identity,
  page: Pick<Page, "id" | "workspace_id">,
  before: CommentNode | null,
  after: CommentNode | null,
) {
  const kept = new Set(commentAttachments(after).map((a) => attachmentFileId(a.src)));
  const dropped = commentAttachments(before)
    .map((a) => attachmentFileId(a.src)!)
    .filter((fileId) => !kept.has(fileId));
  if (!dropped.length) return [];
  const own = (
    await all<{ id: string }>(
      `SELECT id FROM files WHERE page_id=? AND created_by=? AND deleted_at IS NULL AND id IN (${dropped.map(() => "?").join(",")})`,
      page.id,
      user.id,
      ...dropped,
    )
  ).map((f) => f.id);
  if (!own.length) return [];
  const used = await usedFileIds(page.workspace_id, own);
  const unused = own.filter((fileId) => !used.has(fileId.toLowerCase()));
  for (const fileId of unused) {
    await run("UPDATE files SET deleted_at=?,deleted_by=? WHERE id=?", nowText(), user.id, fileId);
    await audit(user.id, "file.trashed", fileId, "comment");
    await run("INSERT INTO search_dirty(page_id,row_id) VALUES(?,?) ON CONFLICT DO NOTHING", page.id, `f:${fileId}`);
  }
  return unused;
}

// Content brought in from an archive (lib/archive.ts, lib/inline-comment-
// archive.ts): mentioned people become historic mentions, pages and
// records plain text (or `mapPage`'s new ids), attachments the imported
// files (`mapSrc`; files that did not come along are left out).
export async function importedContent(
  content: CommentNode,
  mapSrc: ((src: string) => string | null) | null,
  mapPage: ((pageId: string, rowId?: string) => { pageId: string; rowId?: string } | null) | null = null,
): Promise<CommentNode> {
  return await mapCommentNodes(content, (n) => {
    if (n.type === "mention") return { ...n, attrs: { userId: null, label: n.attrs?.label || "" } };
    if (n.type === "pageMention") {
      const mapped = n.attrs?.pageId && mapPage ? mapPage(n.attrs.pageId, n.attrs.rowId) : null;
      return mapped
        ? { type: "pageMention", attrs: { ...mapped, label: n.attrs?.label || "" } }
        : { type: "text", text: "@" + (n.attrs?.label || "…") };
    }
    if (n.type !== "doc" || !n.attrs?.attachments?.length) return n;
    const attachments = mapSrc
      ? n.attrs.attachments.flatMap((a) => {
          const src = mapSrc(a.src);
          return src && attachmentFileId(src) ? [{ ...a, src, missing: undefined }] : [];
        })
      : n.attrs.attachments;
    const { attachments: _old, ...rest } = n.attrs;
    void _old;
    const attrs = { ...rest, ...(attachments.length ? { attachments: attachments.map(({ missing: _m, ...a }) => (void _m, a)) } : {}) };
    return Object.keys(attrs).length ? { ...n, attrs } : { type: n.type, content: n.content };
  });
}
