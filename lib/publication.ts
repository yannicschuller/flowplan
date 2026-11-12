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
import { recordFile, recordScope, recordSharePages, recordSubPage } from "./record-share";
import { privateRecordPageIds } from "./record-pages";
import { parsePageLocation } from "./page-location";

export async function publicationSettings(pageId: string) {
  const row = await one<{
    include_children: number;
    auto_children: number;
    allow_copy: number;
    published_at: string | null;
    password: number;
    expires_at: number | null;
  }>(
    "SELECT include_children,auto_children,allow_copy,published_at,password_hash IS NOT NULL password,expires_at FROM publications WHERE page_id=?",
    pageId,
  );
  const autoChildren = !!row?.include_children && !!row.auto_children;
  return {
    includeChildren: !!row?.include_children,
    autoChildren,
    allowCopy: row ? !!row.allow_copy : true,
    publishedAt: row?.published_at || null,
    password: !!row?.password,
    expiresAt: row?.expires_at ?? null,
    // With new sub-pages joining by themselves, the pages visitors reach
    // right now (the stored list alone would miss them).
    count: autoChildren
      ? await publishedCount(pageId)
      : (await one<{ count: number }>(
          "SELECT count(*) count FROM publication_pages WHERE root_id=?",
          pageId,
        ))?.count || 0,
  };
}
async function publishedCount(pageId: string) {
  const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", pageId);
  if (!page?.public_token) return 0;
  try {
    return (await resolveTree(page.public_token, false)).pages.length;
  } catch {
    return 0;
  }
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
  // New sub-pages join by themselves (only together with the sub-pages).
  autoChildren = false,
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
      )).filter((p) => !neverPublished(p, pinned))
    : [page];
  // Not the pages below private records of a published database (#231).
  const belowPrivate = includeChildren ? await privateRecordPageIds(pages.filter((p) => p.id !== page.id)) : new Set<string>();
  if (belowPrivate.size) pages.splice(0, pages.length, ...pages.filter((p) => !belowPrivate.has(p.id)));
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
      "INSERT INTO publications(page_id,include_children,auto_children,published_at,published_by,allow_copy,password_hash,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      page.id,
      includeChildren ? 1 : 0, includeChildren && autoChildren ? 1 : 0, nowText(),
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
// Never part of a publication, also not as a sub-page: workflow pages
// (#168) and every page of a journal with a PIN.
function neverPublished(p: Page, pinned: Set<string>) {
  return pinned.has(p.id) || p.kind === "workflow";
}
// "Neue Unterseiten automatisch veröffentlichen" (publications.auto_children):
// the sub-pages below the published page that are not in its stored list –
// created, duplicated, moved or restored there after it was published – join
// it as long as they are below it, with its settings (password, end date,
// copying, look: all kept per publication). Only what publishing them by hand
// would allow: the person who published it may still edit the page (so no
// private space or page grant they lack), it is no workflow, in no journal
// with a PIN and in no encrypted space. Checked on every visit, so a page
// moved out leaves the publication, and one this person may no longer edit
// (or a publisher who left) stops being published; the stored list – what
// was chosen by hand – stays as it is.
async function joinedSubPages(root: Page, publishedBy: string | null, descendants: Page[], selected: Set<string>, pinned: Set<string>) {
  const candidates = descendants.filter((p) => !selected.has(p.id) && !neverPublished(p, pinned));
  if (!candidates.length || !publishedBy) return [];
  const account = await one<Identity>("SELECT * FROM users WHERE id=? AND disabled=0", publishedBy);
  if (!account) return [];
  const publisher: Identity = {
    ...account,
    groups: (await all<{ group_id: string }>("SELECT group_id FROM group_members WHERE user_id=?", publishedBy)).map((g) => g.group_id),
    isAdmin: false,
  };
  const locked = await lockedPageIds(publisher, root.workspace_id);
  const joined: string[] = [];
  for (const p of candidates) {
    if (locked.has(p.id)) continue;
    try {
      await requirePage(publisher, p.id, true);
      joined.push(p.id);
    } catch {
      // Not theirs to publish: stays private.
    }
  }
  return joined;
}
export async function publicTree(token: string) {
  return await resolveTree(token, true);
}
// protect=false only for the owner's count in the share dialog.
async function resolveTree(token: string, protect: boolean) {
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
  const publication = link
    ? undefined
    : await one<{ password_hash: string | null; expires_at: number | null; include_children: number; auto_children: number; published_by: string | null }>(
        "SELECT password_hash,expires_at,include_children,auto_children,published_by FROM publications WHERE page_id=?",
        root.id,
      );
  if (protect) checkShareProtection(token, link || publication || { password_hash: null, expires_at: null });
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
  const pinned = await pinJournalPageIds(root.workspace_id);
  for (const id of pinned) selected.delete(id);
  if (publication?.include_children && publication.auto_children)
    for (const id of await joinedSubPages(root, publication.published_by, descendants, selected, pinned)) selected.add(id);
  // A record made private (or moved to the trash) takes its sub-pages out (#231).
  for (const id of await privateRecordPageIds(descendants.filter((p) => p.id !== root.id))) selected.delete(id);
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
  // A shared record (#231): only its included sub-pages are pages of the
  // share (the record itself has its own paths, lib/record-share.ts).
  const record = await recordScope(token);
  if (record) return await recordSubPage(record, pageId);
  const tree = await publicTree(token),
    page = tree.pages.find((p) => p.id === (pageId || tree.root.id));
  if (!page) throw new HttpError(404, "Seite nicht veröffentlicht.");
  return { ...tree, page };
}
export async function publicFile(token: string, fileId: string) {
  // A shared record serves only the files it uses (lib/record-share.ts).
  const record = await recordScope(token);
  let pages: Page[];
  if (record) {
    try {
      return await recordFile(record, fileId);
    } catch (error) {
      // Or one of the included sub-pages uses it (#231), as on a page link.
      pages = await recordSharePages(record);
      if (!pages.length) throw error;
    }
  } else pages = (await publicTree(token)).pages;
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
      } else {
        // Links to records, threads or whiteboard elements of pages outside
        // the share do not even name them (a shared record links nowhere, #231).
        const raw = attrs[attr] || "";
        const target = /^\/?#page=/.test(raw) ? parsePageLocation(raw.replace(/^\//, "")) : null;
        if (target && !pageIds.has(target.pageId)) hide(attrs, attr);
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
