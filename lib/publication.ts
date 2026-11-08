import { publicHiddenFieldIds, stripCells } from "./field-access";
import { whiteboardSnapshotItems } from "./whiteboard";
import { createHash } from "node:crypto";
import { imageFileId } from "./page-appearance";
import { all, one, run, id, nowText } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { inPinJournal, lockedPageIds, pinJournalPageIds, PIN_JOURNAL_NOT_SHARED } from "./journal-extras";
import { cleanHtml, cleanHtmlAsync } from "./document-server";
import { checkShareProtection } from "./share-access";
import type { Identity, Page } from "./types";
import { mapAsync } from "./each-async";

export async function publicationSettings(pageId: string) {
  const row = await one<{
    include_children: number;
    allow_copy: number;
    published_at: string | null;
    password: number;
    expires_at: number | null;
  }>(
    "SELECT include_children,allow_copy,published_at,password_hash IS NOT NULL password,expires_at FROM publications WHERE page_id=?",
    pageId,
  );
  return {
    includeChildren: !!row?.include_children,
    allowCopy: row ? !!row.allow_copy : true,
    publishedAt: row?.published_at || null,
    password: !!row?.password,
    expiresAt: row?.expires_at ?? null,
    count:
      (await one<{ count: number }>(
        "SELECT count(*) count FROM publication_pages WHERE root_id=?",
        pageId,
      ))?.count || 0,
  };
}
// What a published page shows under its title: when it was published, and
// whether it is offered for copying – never behind a password. allow_copy is
// an integer, combined here and not with AND in SQL (PostgreSQL refuses
// integers as booleans).
export async function publicationNotice(pageId: string) {
  const row = await one<{ published_at: string | null; allow_copy: number; password: number }>(
    "SELECT published_at,allow_copy,password_hash IS NOT NULL password FROM publications WHERE page_id=?",
    pageId,
  );
  return row ? { published_at: row.published_at, allow_copy: row.allow_copy && !row.password ? 1 : 0 } : undefined;
}
export async function publishPage(
  user: Identity,
  page: Page,
  enabled: boolean,
  includeChildren: boolean,
  allowCopy = true,
) {
  // A journal with a PIN is never published (setting the PIN ended its
  // publications, lib/journal-extras.ts); below a published page it stays
  // out with all its days.
  if (enabled && await inPinJournal(page)) throw new HttpError(423, PIN_JOURNAL_NOT_SHARED);
  // Workflow pages are never published, not even below a published page (#168).
  if (enabled && page.kind === "workflow") throw new HttpError(409, "Workflow-Seiten lassen sich nicht veröffentlichen oder per Link teilen.");
  const pinned = enabled && includeChildren ? (await pinJournalPageIds(page.workspace_id)) : new Set<string>();
  const pages = includeChildren
    ? (await all<Page>(
        `WITH RECURSIVE tree AS (SELECT * FROM pages WHERE id=? AND deleted_at IS NULL UNION ALL SELECT p.* FROM pages p JOIN tree t ON p.parent_id=t.id WHERE p.deleted_at IS NULL) SELECT * FROM tree`,
        page.id,
      )).filter((p) => !pinned.has(p.id) && p.kind !== "workflow")
    : [page];
  if (enabled) {
    // Like share links: nothing below a journal whose PIN the person has not entered.
    const locked = await lockedPageIds(user, page.workspace_id);
    for (const p of pages) {
      await requirePage(user, p.id, true);
      if (locked.has(p.id)) throw new HttpError(423, "Dieses Journal ist gesperrt.");
    }
  }
  // Password and end date stay while the page remains published.
  const kept = await one<{ password_hash: string | null; expires_at: number | null }>(
    "SELECT password_hash,expires_at FROM publications WHERE page_id=?",
    page.id,
  );
  await run("DELETE FROM publication_pages WHERE root_id=?", page.id);
  await run("DELETE FROM publications WHERE page_id=?", page.id);
  await run(
    "UPDATE pages SET public_token=? WHERE id=?",
    enabled ? page.public_token || id() : null,
    page.id,
  );
  if (enabled) {
    await run(
      "INSERT INTO publications(page_id,include_children,published_at,published_by,allow_copy,password_hash,expires_at) VALUES(?,?,?,?,?,?,?)",
      page.id,
      includeChildren ? 1 : 0, nowText(),
      user.id,
      allowCopy ? 1 : 0,
      kept?.password_hash ?? null,
      kept?.expires_at ?? null,
    );
    for (const p of pages)
      await run(
        "INSERT INTO publication_pages(root_id,page_id) VALUES(?,?)",
        page.id,
        p.id,
      );
  }
}
export async function publicTree(token: string) {
  const link = await one<{
    root_id: string;
    role: "viewer" | "commenter" | "editor";
    password_hash: string | null;
    expires_at: number | null;
  }>("SELECT root_id,role,password_hash,expires_at FROM share_links WHERE token=?", token);
  const root = link
    ? (await one<Page>(
        "SELECT * FROM pages WHERE id=? AND deleted_at IS NULL",
        link.root_id,
      ))
    : (await one<Page>(
        "SELECT * FROM pages WHERE public_token=? AND deleted_at IS NULL",
        token,
      ));
  // Nothing of a journal with a PIN goes out through a link or a
  // publication – also when a shared page was moved into one later.
  if (!root || await inPinJournal(root)) throw new HttpError(404, "Veröffentlichung nicht gefunden.");
  // End date and password (lib/share-access.ts) hold for everything served
  // through the link: pages, records, files, live updates and guest edits.
  checkShareProtection(
    token,
    link ||
      await one<{ password_hash: string | null; expires_at: number | null }>(
        "SELECT password_hash,expires_at FROM publications WHERE page_id=?",
        root.id,
      ) || { password_hash: null, expires_at: null },
  );
  // The explicit publication set is intersected with the current tree. Moving a page out revokes inherited publication.
  const descendants = await all<Page>(
    `WITH RECURSIVE tree AS (SELECT * FROM pages WHERE id=? AND deleted_at IS NULL UNION ALL SELECT p.* FROM pages p JOIN tree t ON p.parent_id=t.id WHERE p.deleted_at IS NULL) SELECT * FROM tree ORDER BY position`,
    root.id,
  );
  const selected = new Set(
    (await all<{ page_id: string }>(
      link
        ? "SELECT page_id FROM share_link_pages WHERE token=?"
        : "SELECT page_id FROM publication_pages WHERE root_id=?",
      link ? token : root.id,
    )).map((p) => p.page_id),
  );
  selected.add(root.id); // Existing single-page links remain valid after migration.
  for (const id of await pinJournalPageIds(root.workspace_id)) selected.delete(id);
  const accessible = new Set([root.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of descendants)
      if (
        selected.has(p.id) &&
        p.parent_id &&
        accessible.has(p.parent_id) &&
        !accessible.has(p.id)
      ) {
        accessible.add(p.id);
        changed = true;
      }
  }
  return {
    root,
    role: link?.role || ("viewer" as const),
    pages: descendants.filter((p) => accessible.has(p.id)),
  };
}
export async function publicPage(token: string, pageId?: string) {
  const tree = await publicTree(token),
    page = tree.pages.find((p) => p.id === (pageId || tree.root.id));
  if (!page) throw new HttpError(404, "Seite nicht veröffentlicht.");
  return { ...tree, page };
}
export async function publicFile(token: string, fileId: string) {
  const { pages } = await publicTree(token);
  const file = await one<{ id: string; page_id: string; name: string; mime: string }>(
    "SELECT * FROM files WHERE id=? AND deleted_at IS NULL",
    fileId,
  );
  // Files in the trash (lib/file-trash.ts) are not served.
  if (!file || !pages.some((p) => p.id === file.page_id))
    throw new HttpError(404, "Datei nicht veröffentlicht.");
  // Fresh guest uploads are readable through the link that uploaded them.
  if (
    await one(
      "SELECT 1 FROM share_uploads WHERE file_id=? AND token=?",
      fileId,
      token,
    )
  )
    return file;
  const html =
    String(
      (await one("SELECT html FROM documents WHERE page_id=?", file.page_id))?.html ||
        "",
    ) +
    (await all<{ html: string }>(
      "SELECT d.html FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE r.page_id=? AND r.access!='private'",
      file.page_id,
    ))
      .map((d) => d.html)
      .join("");
  // An old, unused upload is not published simply because its parent page is public.
  const referenced = new Set<string>();
  // Images placed on a whiteboard.
  const board = pages.find((p) => p.id === file.page_id);
  if (board?.kind === "whiteboard")
    for (const item of await whiteboardSnapshotItems(board as Page))
      if (item.src === `/api/files/${fileId}`) referenced.add(fileId);
  // PDFs imported as the pages of a notebook (lib/notebook.ts).
  if (
    board?.kind === "notebook" &&
    await one("SELECT 1 FROM notebook_sheets WHERE page_id=? AND background LIKE ?", file.page_id, `%"file":"${fileId}"%`)
  )
    referenced.add(fileId);
  const coverId = imageFileId(
    pages.find((p) => p.id === file.page_id)?.cover || "",
  );
  if (coverId) referenced.add(coverId);
  const iconId = imageFileId(
    pages.find((p) => p.id === file.page_id)?.icon || "",
  );
  if (iconId) referenced.add(iconId);
  // Files attached to records of a published database are published with
  // it, except in properties with a read rule (lib/field-access.ts).
  const restricted = publicHiddenFieldIds(
    JSON.parse(
      String((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", file.page_id))?.fields || "[]"),
    ),
  );
  for (const row of await all<{ cells: string }>(
    "SELECT cells FROM rows WHERE page_id=? AND access!='private' AND cells LIKE ?",
    file.page_id,
    `%/api/files/${fileId}%`,
  ))
    if (stripCells(row.cells, restricted).includes(`"/api/files/${fileId}"`)) referenced.add(fileId);
  for (const row of await all<{ icon: string; cover: string }>(
    "SELECT icon,cover FROM rows WHERE page_id=? AND access!='private' AND (icon LIKE '/api/files/%' OR cover LIKE '/api/files/%')",
    file.page_id,
  ))
    for (const value of [row.icon, row.cover]) {
      const fid = imageFileId(value);
      if (fid) referenced.add(fid);
    }
  cleanHtml(html, (tagName, attribs) => {
    for (const attr of ["src", "href", "data-pdf"]) {
      const m = /^\/api\/files\/([\w-]+)$/.exec(attribs[attr] || "");
      if (m) referenced.add(m[1]);
    }
    return { tagName, attribs };
  });
  if (!referenced.has(fileId))
    throw new HttpError(404, "Datei nicht veröffentlicht.");
  return file;
}
// The published pages with the icons links to them show (#96): uploaded
// pictures through the share's own file address, or none when the picture
// is not published.
export async function publishedLinkPages(token: string, pages: Pick<Page, "id" | "icon" | "kind">[]) {
  return await mapAsync(pages, async (p) => {
    let icon = p.icon || "";
    const fileId = imageFileId(icon);
    if (fileId) {
      try {
        await publicFile(token, fileId);
        icon = `/api/share/${token}/files/${fileId}`;
      } catch {
        icon = "";
      }
    }
    return { id: p.id, icon, kind: p.kind };
  });
}
// Links and files outside the share are removed. For guest editing, pass
// `hidden`: they become stable placeholders that saving maps back, so a
// guest edit never drops what the guest cannot see.
export function hiddenPlaceholder(token: string, value: string) {
  return `/share/${token}/hidden/${createHash("sha256")
    .update(`${token}\u0000${value}`)
    .digest("hex")
    .slice(0, 24)}`;
}
export function publishedHtml(
  html: string,
  token: string,
  pages: { id: string }[],
  hidden?: Map<string, string>,
) {
  const pageIds = new Set(pages.map((p) => p.id));
  const hide = (attrs: Record<string, string>, attr: string) => {
    if (hidden) {
      const placeholder = hiddenPlaceholder(token, attrs[attr]);
      hidden.set(placeholder, attrs[attr]);
      attrs[attr] = placeholder;
    } else delete attrs[attr];
  };
  return cleanHtmlAsync(html, async (tagName, attribs) => {
    const attrs = { ...attribs };
    if (attrs["data-linked-database"]) {
      delete attrs["data-linked-source"];
      delete attrs["data-linked-views"];
      delete attrs["data-linked-version"];
    }
    // Boards outside the share are not named.
    if (attrs["data-whiteboard"] && !pageIds.has(attrs["data-whiteboard"]))
      hide(attrs, "data-whiteboard");
    for (const attr of ["src", "href", "data-pdf"]) {
      const file = /^\/api\/files\/([\w-]+)$/.exec(attrs[attr] || "");
      if (file) {
        try {
          await publicFile(token, file[1]);
          attrs[attr] = `/api/share/${token}/files/${file[1]}`;
        } catch {
          hide(attrs, attr);
        }
      }
      // Page and block links (#88: the block part stays behind).
      const link = /^\/?#page=([\w-]+)(?:&block=[\w-]{1,64})?$/.exec(attrs[attr] || "");
      if (link) {
        if (pageIds.has(link[1])) attrs[attr] = `/share/${token}/${link[1]}`;
        else hide(attrs, attr);
      }
    }
    return { tagName, attribs: attrs };
  });
}

// Password and end date of a publication (owners with write access).
export async function protectPublication(page: Page, changes: { password_hash?: string | null; expires_at?: number | null }) {
  if (!page.public_token || !(await one("SELECT 1 FROM publications WHERE page_id=?", page.id)))
    throw new HttpError(400, "Diese Seite ist nicht veröffentlicht.");
  if (changes.password_hash !== undefined)
    await run("UPDATE publications SET password_hash=? WHERE page_id=?", changes.password_hash, page.id);
  if (changes.expires_at !== undefined)
    await run("UPDATE publications SET expires_at=? WHERE page_id=?", changes.expires_at, page.id);
}
