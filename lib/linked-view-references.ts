import { parseLinkedAttributes } from "./linked-views";
import { remapViewReferences } from "./view-references";
import type { Field } from "./types";

// Remap only actual references, never UUID-looking text in a filter or view name.
// A block whose stored configuration is unusable (no views, broken JSON) stays
// as a placeholder without source instead of failing the whole copy or restore.
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
  let parsed: ReturnType<typeof parseLinkedAttributes>;
  try {
    parsed = parseLinkedAttributes({
      id: attrs["data-linked-database"],
      source: sourceId,
      views: attrs["data-linked-views"],
      version: attrs["data-linked-version"] || "1",
    });
  } catch {
    const placeholder = { ...attrs };
    delete placeholder["data-linked-source"];
    delete placeholder["data-linked-views"];
    delete placeholder["data-linked-version"];
    return placeholder;
  }
  return {
    ...attrs,
    "data-linked-source": pages.get(sourceId)!,
    "data-linked-views": JSON.stringify(
      remapViewReferences(parsed.views, database.fields, rows, database.rows),
    ),
  };
}
