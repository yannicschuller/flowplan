import { imageFileId } from "./page-appearance";
import { all, one, run, id } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { cleanHtml } from "./document-server";
import type { Identity, Page } from "./types";

export function publicationSettings(pageId: string) {
  return {
    includeChildren: !!one<{ include_children: number }>(
      "SELECT include_children FROM publications WHERE page_id=?",
      pageId,
    )?.include_children,
    count:
      one<{ count: number }>(
        "SELECT count(*) count FROM publication_pages WHERE root_id=?",
        pageId,
      )?.count || 0,
  };
}
export function publishPage(
  user: Identity,
  page: Page,
  enabled: boolean,
  includeChildren: boolean,
) {
  const pages = includeChildren
    ? all<Page>(
        `WITH RECURSIVE tree AS (SELECT * FROM pages WHERE id=? AND deleted_at IS NULL UNION ALL SELECT p.* FROM pages p JOIN tree t ON p.parent_id=t.id WHERE p.deleted_at IS NULL) SELECT * FROM tree`,
        page.id,
      )
    : [page];
  if (enabled) for (const p of pages) requirePage(user, p.id, true);
  run("DELETE FROM publication_pages WHERE root_id=?", page.id);
  run("DELETE FROM publications WHERE page_id=?", page.id);
  run(
    "UPDATE pages SET public_token=? WHERE id=?",
    enabled ? page.public_token || id() : null,
    page.id,
  );
  if (enabled) {
    run(
      "INSERT INTO publications(page_id,include_children) VALUES(?,?)",
      page.id,
      includeChildren ? 1 : 0,
    );
    for (const p of pages)
      run(
        "INSERT INTO publication_pages(root_id,page_id) VALUES(?,?)",
        page.id,
        p.id,
      );
  }
}
export function publicTree(token: string) {
  const link = one<{
    root_id: string;
    role: "viewer" | "commenter" | "editor";
  }>("SELECT root_id,role FROM share_links WHERE token=?", token);
  const root = link
    ? one<Page>(
        "SELECT * FROM pages WHERE id=? AND deleted_at IS NULL",
        link.root_id,
      )
    : one<Page>(
        "SELECT * FROM pages WHERE public_token=? AND deleted_at IS NULL",
        token,
      );
  if (!root) throw new HttpError(404, "Veröffentlichung nicht gefunden.");
  // The explicit publication set is intersected with the current tree. Moving a page out revokes inherited publication.
  const descendants = all<Page>(
    `WITH RECURSIVE tree AS (SELECT * FROM pages WHERE id=? AND deleted_at IS NULL UNION ALL SELECT p.* FROM pages p JOIN tree t ON p.parent_id=t.id WHERE p.deleted_at IS NULL) SELECT * FROM tree ORDER BY position`,
    root.id,
  );
  const selected = new Set(
    all<{ page_id: string }>(
      link
        ? "SELECT page_id FROM share_link_pages WHERE token=?"
        : "SELECT page_id FROM publication_pages WHERE root_id=?",
      link ? token : root.id,
    ).map((p) => p.page_id),
  );
  selected.add(root.id); // Existing single-page links remain valid after migration.
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
export function publicPage(token: string, pageId?: string) {
  const tree = publicTree(token),
    page = tree.pages.find((p) => p.id === (pageId || tree.root.id));
  if (!page) throw new HttpError(404, "Seite nicht veröffentlicht.");
  return { ...tree, page };
}
export function publicFile(token: string, fileId: string) {
  const { pages } = publicTree(token);
  const file = one<{ id: string; page_id: string; name: string; mime: string }>(
    "SELECT * FROM files WHERE id=?",
    fileId,
  );
  if (!file || !pages.some((p) => p.id === file.page_id))
    throw new HttpError(404, "Datei nicht veröffentlicht.");
  const html =
    String(
      one("SELECT html FROM documents WHERE page_id=?", file.page_id)?.html ||
        "",
    ) +
    all<{ html: string }>(
      "SELECT d.html FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE r.page_id=?",
      file.page_id,
    )
      .map((d) => d.html)
      .join("");
  // An old, unused upload is not published simply because its parent page is public.
  const referenced = new Set<string>();
  const coverId = imageFileId(
    pages.find((p) => p.id === file.page_id)?.cover || "",
  );
  if (coverId) referenced.add(coverId);
  const iconId = imageFileId(
    pages.find((p) => p.id === file.page_id)?.icon || "",
  );
  if (iconId) referenced.add(iconId);
  cleanHtml(html, (tagName, attribs) => {
    for (const attr of ["src", "href"]) {
      const m = /^\/api\/files\/([\w-]+)$/.exec(attribs[attr] || "");
      if (m) referenced.add(m[1]);
    }
    return { tagName, attribs };
  });
  if (!referenced.has(fileId))
    throw new HttpError(404, "Datei nicht veröffentlicht.");
  return file;
}
export function publishedHtml(html: string, token: string, pages: Page[]) {
  const pageIds = new Set(pages.map((p) => p.id));
  return cleanHtml(html, (tagName, attribs) => {
    const attrs = { ...attribs };
    if (attrs["data-linked-database"]) {
      delete attrs["data-linked-source"];
      delete attrs["data-linked-views"];
      delete attrs["data-linked-version"];
    }
    for (const attr of ["src", "href"]) {
      const file = /^\/api\/files\/([\w-]+)$/.exec(attrs[attr] || "");
      if (file) {
        try {
          publicFile(token, file[1]);
          attrs[attr] = `/api/share/${token}/files/${file[1]}`;
        } catch {
          delete attrs[attr];
        }
      }
      const link = /^\/?#page=([\w-]+)$/.exec(attrs[attr] || "");
      if (link) {
        if (pageIds.has(link[1])) attrs[attr] = `/share/${token}/${link[1]}`;
        else delete attrs[attr];
      }
    }
    return { tagName, attribs: attrs };
  });
}
