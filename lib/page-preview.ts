import { journalLocked } from "./journal-extras";
import { one } from "./db";
import { requirePage } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { htmlText } from "./search-index";

// Small summary for hover cards; the full page is loaded only on click.
export async function pagePreview(
  user: Parameters<typeof requirePage>[0],
  pageId: string,
) {
  const page = await requirePage(user, pageId);
  const space = await one<{ name: string }>(
    "SELECT name FROM spaces WHERE id=?",
    page.space_id,
  );
  const html =
    page.kind === "document" && !(await journalLocked(user, page))
      ? (await one<{ html: string }>(
          "SELECT html FROM documents WHERE page_id=?",
          page.id,
        ))?.html || ""
      : "";
  // Only the records this person sees count (none behind a journal PIN).
  const rows =
    page.kind === "database" && !(await journalLocked(user, page))
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
  };
}
