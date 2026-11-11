// rows.import (the CSV import of a database): numbers, checkboxes and dates a
// property cannot hold are refused with the property's name, as row.update
// refuses them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-rows-import-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database, rows } = await import("../lib/api");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Import", "import@example.test");
const owner = { id: uid, name: "Import", email: "import@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(owner.id, "Import");
const space = (await bootstrap(owner, wid)).spaces[0].id;

test("imported numbers, checkboxes and dates must fit their property", async () => {
  const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Import", kind: "database" })) as { id: string }).id;
  const d = await database(pageId);
  await command(owner, {
    action: "database.update",
    pageId,
    version: d.version,
    views: d.views,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "n", name: "Zahl", type: "number" },
      { id: "d", name: "Datum", type: "date" },
      { id: "c", name: "Ok", type: "checkbox" },
      { id: "s", name: "Status", type: "select", options: ["Offen"] },
    ],
  });
  const importing = async (cells: Record<string, unknown>) => await command(owner, { action: "rows.import", pageId, rows: [{ title: "X", ...cells }] });
  await importing({ n: null, d: "", c: false, s: "" });
  await importing({ n: 1.5, d: "2026-11-05T09:30:00Z", c: true, s: "Offen" });
  for (const [cells, name] of [
    [{ n: "12 %" }, "Zahl"],
    [{ d: "2026-02-30" }, "Datum"],
    [{ d: "05.11.2026" }, "Datum"],
    [{ c: "vielleicht" }, "Ok"],
  ] as const)
    await assert.rejects(async () => await importing(cells), (e: Error & { status?: number }) => {
      assert.equal(e.status, 400);
      assert.match(e.message, new RegExp(`passt nicht in die Eigenschaft „${name}“`));
      return true;
    });
  assert.deepEqual(new Set((await rows(pageId)).map((r) => JSON.stringify([r.cells.n, r.cells.d]))), new Set(['[null,""]', '[1.5,"2026-11-05T09:30:00Z"]']));
});
