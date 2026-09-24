import { one } from "./db";
import { requirePage } from "./permissions";
import { htmlText } from "./search-index";

// Small summary for hover cards; the full page is loaded only on click.
export function pagePreview(
  user: Parameters<typeof requirePage>[0],
  pageId: string,
) {
  const page = requirePage(user, pageId);
  const space = one<{ name: string }>(
    "SELECT name FROM spaces WHERE id=?",
    page.space_id,
  );
  const html =
    page.kind === "document"
      ? one<{ html: string }>(
          "SELECT html FROM documents WHERE page_id=?",
          page.id,
        )?.html || ""
      : "";
  const rows =
    page.kind === "database"
      ? Number(
          one<{ n: number }>(
            "SELECT COUNT(*) n FROM rows WHERE page_id=?",
            page.id,
          )?.n || 0,
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
