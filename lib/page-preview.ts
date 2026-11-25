import { journalLocked } from "./journal-extras";
import { one } from "./db";
import { requirePage } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { htmlText } from "./search-index";
import { documentPreview } from "./document-preview";
import { isEncryptedPage } from "./e2ee-server";

// Small summary for hover cards; the full page is loaded only on click.
// With `full` (#549, large page cards on whiteboards): a document's whole
// content too, as sanitized read-only HTML (lib/document-preview.ts, the
// HTML the database feed shows) – never for pages of an end-to-end
// encrypted space (`encrypted`) or behind a journal PIN (`locked`).
export async function pagePreview(
  user: Parameters<typeof requirePage>[0],
  pageId: string,
  options: { full?: boolean } = {},
) {
  const page = await requirePage(user, pageId);
  const locked = await journalLocked(user, page);
  const encrypted = options.full && page.kind === "document" ? await isEncryptedPage(page) : false;
  const space = await one<{ name: string }>(
    "SELECT name FROM spaces WHERE id=?",
    page.space_id,
  );
  const html =
    page.kind === "document" && !locked && !encrypted
      ? (await one<{ html: string }>(
          "SELECT html FROM documents WHERE page_id=?",
          page.id,
        ))?.html || ""
      : "";
  // Only the records this person sees count (none behind a journal PIN).
  const rows =
    page.kind === "database" && !locked
      ? Math.max(
          0,
          Number(
            (await one<{ n: number }>(
              "SELECT COUNT(*) n FROM rows WHERE page_id=?",
              page.id,
            ))?.n || 0,
          ) - (await hiddenRowIds(user, page)).size,
        )
      : 0;
  const text = htmlText(html);
  return {
    id: page.id,
    title: page.title,
    icon: page.icon,
    kind: page.kind,
    space: space?.name || "",
    excerpt:
      [...text].slice(0, 240).join("") + ([...text].length > 240 ? "…" : ""),
    rows,
    updatedAt: page.updated_at,
    ...(options.full && page.kind === "document"
      ? { html: html ? documentPreview(html).html : "", ...(encrypted ? { encrypted: true } : {}), ...(locked ? { locked: true } : {}) }
      : {}),
  };
}
