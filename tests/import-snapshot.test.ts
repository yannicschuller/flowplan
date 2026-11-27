// What an import writes stays the same when writing gets faster (#594): a
// mid-size synthetic Obsidian vault (tests/helpers/obsidian-vault.ts) is
// imported and the result – page tree and sibling order, kinds, icons,
// aliases, tags, properties, files, and every page's HTML and Yjs state –
// compared with a snapshot taken before the write phase was optimised.
// Random ids (pages, files, blocks) are replaced by stable names first.
// Regenerated for #598: `status` (three short values, each on many notes)
// is now a select instead of text – nothing else changed.
// After an intended change of the import's output:
//   UPDATE_IMPORT_SNAPSHOT=1 node --import tsx --test tests/import-snapshot.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-import-snapshot-"));
const { all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { importFromSource } = await import("../lib/importers");
const { vaultZip } = await import("./helpers/obsidian-vault");

const SNAPSHOT = join(import.meta.dirname, "fixtures", "import", "obsidian-synthetic.snapshot.json");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "snapshot", "snapshot@example.test");
const owner = { id: uid, name: "snapshot", email: "snapshot@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;

type PageRow = { id: string; parent_id: string | null; title: string; kind: string; icon: string; position: number; aliases: string | null; cover: string | null };
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

async function snapshot(wid: string, before: Set<string>) {
  const pages = (await all<PageRow>("SELECT id,parent_id,title,kind,icon,position,aliases,cover FROM pages WHERE workspace_id=? AND deleted_at IS NULL", wid)).filter((p) => !before.has(p.id));
  const byId = new Map(pages.map((p) => [p.id, p]));
  const path = (p: PageRow): string => {
    const parent = p.parent_id ? byId.get(p.parent_id) : undefined;
    return parent ? `${path(parent)}/${p.title}` : p.title;
  };
  const files = await all<{ id: string; page_id: string; name: string; mime: string; size: number }>(
    `SELECT id,page_id,name,mime,size FROM files WHERE page_id IN (${pages.map(() => "?").join(",")})`,
    ...pages.map((p) => p.id),
  );
  const names = new Map<string, string>();
  for (const p of pages) names.set(p.id, `page:${path(p)}`);
  for (const f of files) names.set(f.id, `file:${f.name}`);
  const docs = new Map(
    (await all<{ page_id: string; html: string; state: Uint8Array | null }>(
      `SELECT page_id,html,state FROM documents WHERE page_id IN (${pages.map(() => "?").join(",")})`,
      ...pages.map((p) => p.id),
    )).map((d) => [d.page_id, d]),
  );
  const tags = await all<{ page_id: string; name: string }>(
    `SELECT l.page_id,t.name FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id IN (${pages.map(() => "?").join(",")}) ORDER BY l.page_id,l.position`,
    ...pages.map((p) => p.id),
  );
  const values = await all<{ page_id: string; name: string; type: string; value: string }>(
    `SELECT v.page_id,d.name,d.type,v.value FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id WHERE v.page_id IN (${pages.map(() => "?").join(",")}) ORDER BY d.name`,
    ...pages.map((p) => p.id),
  );
  const sorted = [...pages].sort((a, b) => path(a).localeCompare(path(b)));
  // Block ids in the order they first appear (pages by path).
  let blocks = 0;
  for (const p of sorted) for (const match of (docs.get(p.id)?.html || "").matchAll(/data-block-id="([^"]+)"/g)) if (!names.has(match[1])) names.set(match[1], `block:${++blocks}`);
  const ids = new RegExp([...names.keys()].map((k) => k.replace(/[-]/g, "\\-")).join("|"), "g");
  const stable = (text: string) => text.replace(ids, (k) => names.get(k)!);
  return {
    pages: sorted.map((p) => {
      const doc = docs.get(p.id);
      const state = doc?.state ? (() => {
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, doc.state!);
        const json = JSON.stringify(yDocToProsemirrorJSON(ydoc, "default"));
        ydoc.destroy();
        return json;
      })() : "";
      const siblings = pages.filter((s) => s.parent_id === p.parent_id).sort((a, b) => a.position - b.position);
      return {
        path: path(p),
        kind: p.kind,
        icon: p.icon,
        rank: siblings.indexOf(p),
        aliases: p.aliases,
        cover: p.cover ? stable(p.cover) : null,
        tags: tags.filter((t) => t.page_id === p.id).map((t) => t.name),
        properties: Object.fromEntries(values.filter((v) => v.page_id === p.id).map((v) => [`${v.name}:${v.type}`, v.value])),
        html: doc ? sha(stable(doc.html)) : null,
        state: state ? sha(stable(state)) : null,
      };
    }),
    files: files.map((f) => ({ name: f.name, mime: f.mime, size: f.size, page: names.get(f.page_id) })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

test("a synthetic Obsidian vault imports as it did before the write phase was optimised (#594)", async () => {
  const wid = await createWorkspace(owner.id, "Snapshot");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const before = new Set((await all<{ id: string }>("SELECT id FROM pages WHERE workspace_id=?", wid)).map((p) => p.id));
  const bytes = await vaultZip({ notes: 160, images: 24 });
  const result = await importFromSource(owner, wid, space, { name: "vault.zip", bytes }, { source: "obsidian" });
  assert.equal(result.pages, 160);
  const actual = await snapshot(wid, before);
  if (process.env.UPDATE_IMPORT_SNAPSHOT) writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 1) + "\n");
  const expected = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  assert.equal(actual.pages.length, expected.pages.length);
  for (let i = 0; i < expected.pages.length; i++) assert.deepEqual(actual.pages[i], expected.pages[i], expected.pages[i].path);
  assert.deepEqual(actual.files, expected.files);
});
