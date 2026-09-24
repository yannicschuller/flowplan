import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-zipimport-"),
);
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap, database, rows } = await import("../lib/api");
const { writeZip } = await import("../lib/archive");
const { importZip, inferField, importDate, exportTitle } =
  await import("../lib/zip-import");
const { markdownToHtml } = await import("../lib/markdown-import");

function account(name: string) {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.test`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.test`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  } as Identity;
}
const owner = account("import-owner"),
  viewer = account("import-viewer");
const wid = createWorkspace(owner.id, "Import");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = bootstrap(owner, wid).spaces[0].id;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const hex = (n: number) => String(n).repeat(32).slice(0, 32);
const zip = (files: Record<string, string | Buffer>) =>
  writeZip(
    new Map(
      Object.entries(files).map(([k, v]) => [
        k,
        Buffer.isBuffer(v) ? v : Buffer.from(v),
      ]),
    ),
  );

test("helpers infer titles, dates, field types and convert Markdown safely", () => {
  assert.equal(exportTitle(`Projekt Alpha ${hex(1)}.md`), "Projekt Alpha");
  assert.equal(exportTitle(`Aufgaben ${hex(2)}_all.csv`), "Aufgaben");
  assert.equal(importDate("September 24, 2026 3:05 PM"), "2026-09-24");
  assert.equal(importDate("2026-01-02"), "2026-01-02");
  assert.equal(importDate("24.09.2026"), null);
  assert.equal(inferField("Anzahl", ["1", "2,5", ""], 1).type, "number");
  assert.equal(inferField("Fertig", ["Yes", "No"], 2).type, "checkbox");
  assert.equal(inferField("Fällig", ["May 1, 2026"], 3).type, "date");
  assert.deepEqual(
    inferField("Status", ["Offen", "Offen", "Done", "Done"], 4),
    {
      id: "f4",
      name: "Status",
      type: "select",
      options: ["Offen", "Done"],
    },
  );
  assert.equal(inferField("Name", ["1"], 0).type, "text");
  const html = markdownToHtml(
    "- [x] fertig\n- [ ] offen\n\n<b>roh</b> [x](javascript:alert(1))",
  );
  assert.match(html, /data-type="taskList"/);
  assert.match(html, /data-checked="true"/);
  assert.doesNotMatch(html, /<b>|javascript/);
});

test("Notion exports become nested pages, databases with record pages and attachments", async () => {
  const inner = await zip({
    [`Wiki ${hex(1)}.md`]: `# Wiki\n\nSiehe [Kapitel](Wiki%20${hex(1)}/Kapitel%20${hex(3)}.md) und ![Logo](Wiki%20${hex(1)}/logo.png)\n\n- [x] erledigt\n`,
    [`Wiki ${hex(1)}/Kapitel ${hex(3)}.md`]: "# Kapitel\n\nInhalt des Kapitels",
    [`Wiki ${hex(1)}/logo.png`]: png,
    [`Wiki ${hex(1)}/unbenutzt.png`]: png,
    [`Aufgaben ${hex(2)}.csv`]: "Name,Status\nNur Ansicht,Offen\n",
    [`Aufgaben ${hex(2)}_all.csv`]:
      'Name,Status,Aufwand,Fertig,Fällig\nPlanen,Offen,2,No,"September 24, 2026"\nBauen,Offen,5,Yes,\nTesten,Done,1,No,\nPrüfen,Done,3,Yes,\n',
    [`Aufgaben ${hex(2)}/Planen ${hex(4)}.md`]:
      "# Planen\n\nStatus: Offen\nAufwand: 2\n\nDetails zum **Planen**",
  });
  // Notion wraps big exports in an outer ZIP with a single folder.
  const outer = await zip({ "Export-1234/Part-1.zip": inner });
  const result = await importZip(owner, wid, space, outer);
  assert.equal(result.pages, 3);
  assert.equal(result.rows, 4);
  assert.equal(result.files, 1);
  const page = (title: string) =>
    one<{ id: string; parent_id: string | null; kind: string }>(
      "SELECT id,parent_id,kind FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL",
      wid,
      title,
    )!;
  const wiki = page("Wiki"),
    chapter = page("Kapitel"),
    tasks = page("Aufgaben");
  assert.equal(chapter.parent_id, wiki.id);
  assert.equal(tasks.kind, "database");
  const html = one<{ html: string }>(
    "SELECT html FROM documents WHERE page_id=?",
    wiki.id,
  )!.html;
  assert.match(html, new RegExp(`#page=${chapter.id}`));
  const files = all<{ id: string; name: string }>(
    "SELECT id,name FROM files WHERE page_id=?",
    wiki.id,
  );
  assert.deepEqual(
    files.map((f) => f.name),
    ["logo.png"],
  );
  assert.match(html, new RegExp(`/api/files/${files[0].id}`));
  assert.ok(
    readFileSync(
      join(process.env.FLOWPLAN_DATA_DIR!, "uploads", files[0].id),
    ).equals(png),
  );
  assert.doesNotMatch(html, /<h1>Wiki<\/h1>/);
  const fields = database(tasks.id).fields;
  assert.deepEqual(
    fields.map((f) => [f.name, f.type]),
    [
      ["Name", "text"],
      ["Status", "select"],
      ["Aufwand", "number"],
      ["Fertig", "checkbox"],
      ["Fällig", "date"],
    ],
  );
  const records = rows(tasks.id);
  assert.deepEqual(
    records.map((r) => r.cells.title),
    ["Planen", "Bauen", "Testen", "Prüfen"],
  );
  assert.equal(records[0].cells.f4, "2026-09-24");
  assert.equal(records[1].cells.f3, true);
  const rowHtml = one<{ html: string }>(
    "SELECT html FROM row_documents WHERE row_id=?",
    records[0].id,
  )!.html;
  assert.match(rowHtml, /<strong>Planen<\/strong>/);
  assert.doesNotMatch(rowHtml, /Status: Offen/);
});

test("imports need write access, content and stay within limits", async () => {
  const simple = await zip({ "Notiz.md": "Hallo" });
  await assert.rejects(
    importZip(viewer, wid, space, simple),
    /Berechtigung|Rolle|Zugriff/i,
  );
  await assert.rejects(
    importZip(owner, wid, space, await zip({ "bild.png": png })),
    /keine Markdown/,
  );
  await assert.rejects(
    importZip(owner, wid, space, Buffer.from("kein zip")),
    /ZIP/,
  );
  const before = one<{ n: number }>("SELECT COUNT(*) n FROM pages")!.n;
  process.env.FLOWPLAN_WORKSPACE_QUOTA_MB = "1";
  const big = await zip({
    "Groß.md": "![x](gross.bin)",
    "gross.bin": Buffer.alloc(2 * 1024 * 1024),
  });
  await assert.rejects(importZip(owner, wid, space, big), /Speicherkontingent/);
  delete process.env.FLOWPLAN_WORKSPACE_QUOTA_MB;
  // Failed imports leave nothing behind.
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM pages")!.n, before);
  const ok = await importZip(owner, wid, space, simple);
  assert.equal(ok.pages, 1);
});
