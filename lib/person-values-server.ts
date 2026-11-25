// Switching "Mehrere Personen" (#535) on or off, on the server: the
// records and record templates of the database take the property's new
// shape – a list of ids when it is switched on, the first person when it
// is switched off (the dialog said how many records lose people).
import { all, run } from "./db";
import { multiPersonSwitchedOff, multiPersonSwitchedOn, personCell, personIds } from "./person-values";
import type { Field } from "./types";

export async function convertPersonValues(pageId: string, before: Field[], after: Field[]) {
  const off = multiPersonSwitchedOff(after, before),
    on = multiPersonSwitchedOn(after, before);
  if (!off.length && !on.length) return;
  const changes = [...off.map((id) => ({ id, multi: false })), ...on.map((id) => ({ id, multi: true }))];
  for (const table of ["rows", "row_templates"] as const)
    for (const row of await all<{ id: string; cells: string }>(`SELECT id,cells FROM ${table} WHERE page_id=?`, pageId)) {
      const cells = JSON.parse(row.cells || "{}") as Record<string, unknown>;
      let changed = false;
      for (const { id, multi } of changes) {
        if (!(id in cells)) continue;
        const next = personCell({ type: "person", multiPerson: multi }, personIds(cells[id]));
        if (JSON.stringify(next) !== JSON.stringify(cells[id])) {
          cells[id] = next;
          changed = true;
        }
      }
      if (!changed) continue;
      await run(`UPDATE ${table} SET cells=? WHERE id=?`, JSON.stringify(cells), row.id);
      // People who are no longer named are no longer found by them.
      if (table === "rows") await run("INSERT INTO search_dirty(page_id,row_id) VALUES(?,?) ON CONFLICT DO NOTHING", pageId, row.id);
    }
}
