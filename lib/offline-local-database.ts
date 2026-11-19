// What a database made offline shows (#370), apart from the workspace
// shell: loaded with components/offline-local-data.ts when such a page opens.
import type { OfflinePageChange } from "./offline-queue";
import type { Field, Row, View } from "./types";
import type { CatalogTemplate } from "./template-catalog";
import { resolveCatalogDates } from "./template-catalog";
import { databaseKinds, databaseSetup, type DatabaseKind, type Translate } from "./database-setup";

// What a database made offline shows: the fields and views the server
// will create (lib/database-setup.ts, or the template's) and the
// template's example records under the ids sent along.
export function localDatabase(
  change: OfflinePageChange,
  tr: Translate,
  template?: CatalogTemplate,
): { fields: Field[]; views: View[]; settings?: object; recordLayout?: object; rows: Row[] } {
  const at = new Date(change.at).toISOString();
  if (template && change.starterTemplate) {
    const rows = (template.rows || []).map((row, i) => ({
      id: change.rowIds?.[i] || `${change.pageId}-${i}`,
      page_id: change.pageId,
      cells: resolveCatalogDates(row.cells),
      position: i,
      created_at: at,
      updated_at: at,
      created_by: "",
      updated_by: "",
      version: 1,
      role: "editor" as const,
    }));
    return { fields: template.fields || [], views: template.views || [], settings: template.settings, rows };
  }
  const setup = databaseSetup((databaseKinds.includes(change.databaseKind as DatabaseKind) ? change.databaseKind : "tasks") as DatabaseKind, tr);
  return { ...setup, rows: [] };
}
