import { cleanHtml, escaped } from "./document-server";
import { cellText, computedCells, queryRows } from "./database";
import { database, rows } from "./api";
import { availableLinkedViews, parseLinkedAttributes } from "./linked-views";
import { displayText } from "./field-format";
import { publicFieldsOf } from "./shared-content";
import type { Page } from "./types";

export const MAX_EMBED_ROWS = 100;
const BLOCK =
  /<div\b[^>]*\bdata-linked-database="([0-9a-f-]{36})"[^>]*>[\s\S]*?<\/div>/gi;

// Linked database blocks on public pages show their first view as a table
// when the source database belongs to the same publication. Only public
// properties are shown; other blocks keep their placeholder.
export function withPublicEmbeds(
  published: string,
  original: string,
  token: string,
  pages: Page[],
) {
  const blocks = new Map<string, Record<string, string>>();
  cleanHtml(original, (tagName, attribs) => {
    if (attribs["data-linked-database"])
      blocks.set(attribs["data-linked-database"], attribs);
    return { tagName, attribs };
  });
  if (!blocks.size) return published;
  const published_ = new Map(pages.map((p) => [p.id, p]));
  return published.replace(BLOCK, (match, blockId: string) => {
    const attrs = blocks.get(blockId);
    if (!attrs) return match;
    try {
      const linked = parseLinkedAttributes({
        id: attrs["data-linked-database"],
        source: attrs["data-linked-source"],
        version: attrs["data-linked-version"] || "1",
        views: attrs["data-linked-views"] || "[]",
      });
      const source = published_.get(linked.source);
      if (!source || source.kind !== "database") return match;
      const d = database(source.id),
        all = rows(source.id);
      const [view] = availableLinkedViews(linked.views, d.fields, all);
      if (!view) return match;
      const hidden = new Set(view.hiddenFields || []);
      const order = view.fieldOrder || [];
      const isPublic = publicFieldsOf(d.fields);
      const fields = d.fields
        .filter((f) => isPublic(f) && !hidden.has(f.id))
        .sort(
          (a, b) =>
            (order.indexOf(a.id) + 1 || Infinity) -
            (order.indexOf(b.id) + 1 || Infinity),
        );
      const title = d.fields[0];
      const shown = queryRows(
        all.map((r) => ({ ...r, cells: computedCells(r, d.fields) })),
        d.fields,
        view,
      );
      const link = (rowId: string) =>
        escaped(`/share/${token}/${source.id}?row=${rowId}`);
      const body = shown
        .slice(0, MAX_EMBED_ROWS)
        .map(
          (r) =>
            `<tr>${fields
              .map((f) =>
                f.id === title?.id
                  ? `<td><a href="${link(r.id)}">${escaped(cellText(r.cells[f.id]) || "Ohne Titel")}</a></td>`
                  : `<td>${escaped(displayText(f, r.cells[f.id], "UTC"))}</td>`,
              )
              .join("")}</tr>`,
        )
        .join("");
      const more =
        shown.length > MAX_EMBED_ROWS
          ? `<p>… und ${shown.length - MAX_EMBED_ROWS} weitere Einträge in <a href="${escaped(`/share/${token}/${source.id}`)}">${escaped(source.title)}</a></p>`
          : "";
      return cleanHtml(
        `<div class="public-embed"><p class="public-embed-title"><a href="${escaped(`/share/${token}/${source.id}`)}">${escaped(source.title)}</a> · ${escaped(view.name)}</p><table><thead><tr>${fields
          .map((f) => `<th>${escaped(f.name)}</th>`)
          .join(
            "",
          )}</tr></thead><tbody>${body || `<tr><td colspan="${fields.length || 1}">Keine Einträge</td></tr>`}</tbody></table>${more}</div>`,
        (tagName, attribs) => ({ tagName, attribs }),
      );
    } catch {
      return match;
    }
  });
}
