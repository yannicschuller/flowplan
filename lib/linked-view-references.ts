import { parseLinkedAttributes } from "./linked-views";
import { remapViewReferences } from "./view-references";
import type { Field } from "./types";

// Remap only actual references, never UUID-looking text in a filter or view name.
export function remapLinkedAttributes(
  attrs: Record<string, string>,
  pages: Map<string, string>,
  rows: Map<string, string>,
  source: (
    id: string,
  ) => { fields: Field[]; rows: { id: string }[] } | undefined,
) {
  if (!attrs["data-linked-database"]) return attrs;
  const sourceId = attrs["data-linked-source"];
  if (!pages.has(sourceId)) return attrs;
  const database = source(sourceId);
  if (!database) return attrs;
  const parsed = parseLinkedAttributes({
    id: attrs["data-linked-database"],
    source: sourceId,
    views: attrs["data-linked-views"],
    version: attrs["data-linked-version"] || "1",
  });
  return {
    ...attrs,
    "data-linked-source": pages.get(sourceId)!,
    "data-linked-views": JSON.stringify(
      remapViewReferences(parsed.views, database.fields, rows, database.rows),
    ),
  };
}
