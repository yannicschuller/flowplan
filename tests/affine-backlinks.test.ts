// #167: after an AFFiNE import most documents sat at the top of the
// workspace page. A document AFFiNE places nowhere that exactly one other
// document links to (in its text) now goes below that document – unless
// switched off in the import preview ("Dokumente mit genau einem Verweis
// darunter einordnen"). Built with tests/helpers/affine-fixture.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-affine-backlinks-"));
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { importFromSource, parseImport } = await import("../lib/importers");
const { affineFileV2, note, page, para } = await import("./helpers/affine-fixture");
import type { Workspace } from "./helpers/affine-fixture";

const ROOT = "affine:root";
const ref = (pageId: string) => ({ insert: " ", attributes: { reference: { type: "LinkedPage", pageId } } });
const linking = (id: string, title: string, targets: string[], surface?: Parameters<typeof page>[3]) =>
  page(id, title, [note([para([{ insert: `${title}: ` }, ...targets.flatMap((t) => [ref(t), { insert: " " }])])])], surface);

// Start links to Einzeln, Zweifach, Ordner, Oben and itself; Einzeln to
// Kette; Andere to Zweifach; Gee and Ha to each other; a journal day to
// Vom Tag; only Andere's whiteboard to Vom Board.
function workspace(): Workspace {
  return {
    id: "wsBack",
    name: "Verweise",
    docs: [
      { id: "dStart", title: "Start", doc: linking("dStart", "Start", ["dOne", "dTwo", "dFolder", "dTop", "dStart"]) },
      { id: "dOne", title: "Einzeln", doc: linking("dOne", "Einzeln", ["dChain"]) },
      { id: "dChain", title: "Kette", doc: linking("dChain", "Kette", []) },
      { id: "dTwo", title: "Zweifach", doc: linking("dTwo", "Zweifach", []) },
      {
        id: "dOther",
        title: "Andere",
        doc: linking("dOther", "Andere", ["dTwo"], {
          children: [{ id: "card1", flavour: "affine:embed-linked-doc", props: { pageId: "dBoard", xywh: "[900,0,300,100]", index: "a1" } }],
        }),
      },
      { id: "dBoard", title: "Vom Board", doc: linking("dBoard", "Vom Board", []) },
      { id: "dFolder", title: "Ordner-Dokument", doc: linking("dFolder", "Ordner-Dokument", []) },
      { id: "dTop", title: "Oben", doc: linking("dTop", "Oben", []) },
      { id: "dG", title: "Gee", doc: linking("dG", "Gee", ["dH"]) },
      { id: "dH", title: "Ha", doc: linking("dH", "Ha", ["dG"]) },
      { id: "dDay", title: "Oct 3, 2026", doc: linking("dDay", "Tag", ["dFromDay"]) },
      { id: "dFromDay", title: "Vom Tag", doc: linking("dFromDay", "Vom Tag", []) },
    ],
    folders: [
      { id: "Fo", parentId: null, type: "folder", data: "Ablage", index: "a0" },
      { id: "Lf", parentId: "Fo", type: "doc", data: "dFolder", index: "a0" },
      // Put at the top of AFFiNE's "Organize" tree by hand.
      { id: "Lt", parentId: null, type: "doc", data: "dTop", index: "a1" },
    ],
    docProperties: { dDay: { journal: "2026-10-03" } },
  };
}
const parentsOf = (tree: Awaited<ReturnType<typeof parseImport>>) =>
  Object.fromEntries(tree.pages.filter((p) => p.key.startsWith("doc:")).map((p) => [p.key.slice(4), p.parent]));

test("a document with exactly one document linking to it goes below that one; the rest keeps its place (#167)", async () => {
  const bytes = affineFileV2(workspace());
  const tree = await parseImport("Verweise.affine", bytes);
  const parents = parentsOf(tree);
  assert.equal(parents.dOne, "doc:dStart", "one document links to it: below that one");
  assert.equal(parents.dChain, "doc:dOne", "chains follow");
  assert.equal(parents.dTwo, ROOT, "two documents link to it: stays at the top");
  assert.equal(parents.dOther, ROOT);
  assert.equal(parents.dStart, ROOT, "a link to itself does not count");
  assert.equal(parents.dFolder, "folder:Fo", "AFFiNE's folders win");
  assert.equal(parents.dTop, ROOT, "placed at the top of AFFiNE's tree: stays there");
  // A cycle: the first of the two goes below the other, never both.
  assert.equal(parents.dG, "doc:dH");
  assert.equal(parents.dH, ROOT);
  assert.equal(parents.dBoard, ROOT, "a link from a whiteboard is no place for a page");
  assert.equal(parents.dFromDay, ROOT, "a journal day is no place for a page");
  assert.equal(parents.dDay, null, "journal days go into the journal");
  // Andere's whiteboard still sits next to its document, with the card.
  const board = tree.pages.find((p) => p.key === "board:dOther");
  assert.equal(board?.parent, ROOT);
  assert.match(JSON.stringify(board?.board), /doc%3AdBoard/);
  assert.equal(tree.linkedBelow, 3);
  tree.close?.();

  // Switched off: the earlier behaviour, the count stays for the preview.
  const off = await parseImport("Verweise.affine", bytes, undefined, { nestLinked: false });
  const flat = parentsOf(off);
  for (const key of ["dOne", "dChain", "dTwo", "dG", "dH", "dBoard", "dFromDay", "dStart"]) assert.equal(flat[key], ROOT, key);
  assert.equal(flat.dFolder, "folder:Fo");
  assert.equal(off.linkedBelow, 3);
  off.close?.();
});

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}

test("the preview counts them, the import writes them below and keeps the links; the switch keeps them at the top (#167)", async () => {
  const owner = await account("affine-backlinks");
  const wid = await createWorkspace(owner.id, "Verweise");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const bytes = affineFileV2(workspace());
  const preview = await importFromSource(owner, wid, space, { name: "Verweise.affine", bytes }, { dryRun: true });
  assert.equal(preview.linkedBelow, 3);
  assert.equal(preview.wrapper, "Verweise");
  const asDatabase = await importFromSource(owner, wid, space, { name: "Verweise.affine", bytes }, { dryRun: true, mode: "database" });
  assert.equal(asDatabase.linkedBelow, undefined, "a database has no page tree");

  type Row = { id: string; parent_id: string | null };
  const latest = async (title: string) =>
    (await one<Row>("SELECT id,parent_id FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1", wid, title))!;
  const html = async (pageId: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html;

  await importFromSource(owner, wid, space, { name: "Verweise.affine", bytes });
  const root = await latest("Verweise"),
    start = await latest("Start"),
    single = await latest("Einzeln"),
    chain = await latest("Kette"),
    two = await latest("Zweifach"),
    g = await latest("Gee"),
    h = await latest("Ha");
  assert.equal(start.parent_id, root.id);
  assert.equal(single.parent_id, start.id);
  assert.equal(chain.parent_id, single.id);
  assert.equal(two.parent_id, root.id);
  assert.equal(g.parent_id, h.id);
  assert.equal(h.parent_id, root.id);
  assert.ok((await html(start.id)).includes(`/#page=${single.id}`), "the link stays");
  assert.ok((await html(single.id)).includes(`/#page=${chain.id}`));
  assert.ok((await html(g.id)).includes(`/#page=${h.id}`) && (await html(h.id)).includes(`/#page=${g.id}`));

  await importFromSource(owner, wid, space, { name: "Verweise.affine", bytes }, { nestLinked: false });
  const root2 = await latest("Verweise");
  for (const title of ["Start", "Einzeln", "Kette", "Zweifach", "Gee", "Ha"]) assert.equal((await latest(title)).parent_id, root2.id, title);
});
