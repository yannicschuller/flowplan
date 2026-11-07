// Links show the linked page's or record's own icon (#96): which icon
// (emoji, upload, library symbol, the kind's default), which links count,
// and the server's answer for records and unknown pages – only for what the
// person may read. Backlinks, search and related pages give records their
// own icon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-link-icons-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { linkTargets, parseTargetKey, LINK_TARGETS_LIMIT } = await import("../lib/link-targets");
const { textBacklinks } = await import("../lib/text-backlinks");
const { searchWorkspace } = await import("../lib/search-index");
const { publishedLinkPages } = await import("../lib/publication");
const { hasOwnIcon, iconType, linkLocation, shownPageIcon, targetKey } = await import("../lib/page-link-icons");

test("the icon to show: own icon, else the kind's", () => {
  assert.equal(shownPageIcon("🚀", "document"), "🚀");
  assert.equal(shownPageIcon("👨‍👩‍👧", "document"), "👨‍👩‍👧");
  assert.equal(shownPageIcon("icon:Rocket:#337ea9", "database"), "icon:Rocket:#337ea9");
  assert.equal(shownPageIcon("/api/files/abc", "whiteboard"), "/api/files/abc");
  // New pages carry their kind's name; databases "file".
  assert.equal(shownPageIcon("file", "document"), "file");
  assert.equal(shownPageIcon("file", "database"), "table");
  assert.equal(shownPageIcon("", "database"), "table");
  assert.equal(shownPageIcon("whiteboard", "whiteboard"), "whiteboard");
  assert.equal(shownPageIcon("", "whiteboard"), "whiteboard");
  assert.equal(shownPageIcon(null, "record"), "record");
  assert.equal(shownPageIcon("", "row"), "record");
  assert.equal(shownPageIcon("⭐", "row"), "⭐");
  assert.equal(shownPageIcon(undefined, undefined), "file");
  // Older named icons stay.
  assert.equal(shownPageIcon("rocket", "document"), "rocket");
  assert.ok(hasOwnIcon("😀") && hasOwnIcon("icon:Star:#cb912f") && !hasOwnIcon("file") && !hasOwnIcon("") && !hasOwnIcon(null));
});

test("icon types", () => {
  assert.equal(iconType("😀"), "emoji");
  assert.equal(iconType("🇩🇪"), "emoji");
  assert.equal(iconType("1️⃣"), "emoji");
  assert.equal(iconType("icon:Star:#cb912f"), "library");
  assert.equal(iconType("/api/files/x1"), "image");
  assert.equal(iconType("/api/share/tok/files/x1"), "image");
  assert.equal(iconType("file"), "named");
  assert.equal(iconType("/api/files/../x"), "named");
});

test("which links point to a page or record", () => {
  const p = "0b7c6a4e-1d2f-4a3b-9c8d-7e6f5a4b3c2d",
    r = "1b7c6a4e-1d2f-4a3b-9c8d-7e6f5a4b3c2d";
  assert.deepEqual(linkLocation(`/#page=${p}`), { pageId: p });
  assert.deepEqual(linkLocation(`#page=${p}&row=${r}`), { pageId: p, rowId: r });
  assert.deepEqual(linkLocation(`/#page=${p}&block=b-1`), { pageId: p, blockId: "b-1" });
  assert.deepEqual(linkLocation(`https://flow.example/#page=${p}`, "https://flow.example"), { pageId: p });
  // Another site's #page= is not ours.
  assert.equal(linkLocation(`https://other.example/#page=${p}`, "https://flow.example"), null);
  assert.equal(linkLocation(`https://flow.example/#page=${p}`), null);
  assert.equal(linkLocation(`/#page=nope`), null);
  assert.equal(linkLocation("https://example.com"), null);
  assert.equal(linkLocation(""), null);
  assert.equal(linkLocation(null), null);
  // Links between published pages.
  assert.deepEqual(linkLocation(`/share/abcDEF_-1/${p}`), { pageId: p });
  assert.equal(linkLocation(`/share/abc/hidden/123`), null);
  assert.equal(targetKey({ pageId: p }), p);
  assert.equal(targetKey({ pageId: p, rowId: r }), `${p}:${r}`);
  assert.deepEqual(parseTargetKey(`${p}:${r}`), { pageId: p, rowId: r });
  assert.deepEqual(parseTargetKey(p), { pageId: p });
  assert.equal(parseTargetKey(`${p}:${r}:x`), null);
  assert.equal(parseTargetKey("x"), null);
});

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("Olga"),
  viewer = await account("Vera"),
  stranger = await account("Sven");
const wid = await createWorkspace(owner.id, "Agentur");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (input: Record<string, unknown>, as = owner) => (await command(as, input)) as Record<string, unknown>;
const create = async (title: string, kind = "document", spaceId = team) =>
  ((await act({ action: "page.create", workspaceId: wid, spaceId, title, kind })) as { id: string }).id;

const rocket = await create("Raketen");
await act({ action: "page.update", pageId: rocket, patch: { icon: "🚀" } });
const tasks = await create("Aufgaben", "database");
const record = ((await act({ action: "row.create", pageId: tasks, cells: { title: "Steuer" } })) as { id: string }).id;
await run("UPDATE rows SET icon=? WHERE id=?", "💸", record);
const plain = ((await act({ action: "row.create", pageId: tasks, cells: { title: "Ohne" } })) as { id: string }).id;
const secret = ((await act({ action: "row.create", pageId: tasks, cells: { title: "Geheim" } })) as { id: string }).id;
await act({ action: "row.access", pageId: tasks, rowId: secret, access: "private", grants: [] });
const privateSpace = ((await act({ action: "space.create", workspaceId: wid, name: "Privat", private: true })) as { id: string }).id;
const hidden = await create("Tagebuch", "document", privateSpace);
await act({ action: "page.update", pageId: hidden, patch: { icon: "🔒" } });

test("the server answers only for what the person may read", async () => {
  const keys = [rocket, tasks, `${tasks}:${record}`, `${tasks}:${plain}`, `${tasks}:${secret}`, hidden, `${rocket}:${record}`, id(), "junk"];
  const own = await linkTargets(owner, keys);
  assert.deepEqual(own[rocket], { icon: "🚀", kind: "document" });
  assert.deepEqual(own[tasks], { icon: "file", kind: "database" });
  assert.deepEqual(own[`${tasks}:${record}`], { icon: "💸", kind: "record" });
  assert.deepEqual(own[`${tasks}:${plain}`], { icon: "", kind: "record" });
  assert.ok(own[`${tasks}:${secret}`]);
  assert.ok(own[hidden]);
  // A record under the wrong database, unknown ids and junk: nothing.
  assert.equal(Object.keys(own).length, 6);
  const read = await linkTargets(viewer, keys);
  assert.ok(read[rocket] && read[`${tasks}:${record}`]);
  // A private record and a private space: not even that they exist.
  assert.equal(read[`${tasks}:${secret}`], undefined);
  assert.equal(read[hidden], undefined);
  assert.deepEqual(await linkTargets(stranger, keys), {});
  // No titles in the answer.
  assert.ok(Object.values(own).every((v) => Object.keys(v).sort().join() === "icon,kind"));
  // Pages in the trash drop out.
  const gone = await create("Weg");
  await act({ action: "page.delete", pageId: gone });
  assert.deepEqual(await linkTargets(owner, [gone]), {});
  assert.ok(LINK_TARGETS_LIMIT >= 50);
});

test("backlinks, search and related pages give records their own icon", async () => {
  const target = await create("Ziel");
  await run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)",
    record,
    Buffer.alloc(0),
    `<p><a href="/#page=${target}">Ziel</a></p>`,
    "g",
  );
  const links = await textBacklinks(owner, { id: target, workspace_id: wid });
  const fromRecord = links.find((l) => l.rowId === record);
  assert.ok(fromRecord);
  assert.equal(fromRecord!.icon, "💸");
  assert.equal(fromRecord!.kind, "record");
  const hits = await searchWorkspace(owner, wid, "Steuer", { kind: "row" });
  const hit = hits.find((h) => h.rowId === record);
  assert.ok(hit);
  assert.equal(hit!.icon, "💸");
});

test("published pages: uploads through the share, unpublished uploads left out", async () => {
  const pages = await publishedLinkPages("token", [
    { id: rocket, icon: "🚀", kind: "document" },
    { id: tasks, icon: `/api/files/${id()}`, kind: "database" },
  ]);
  assert.deepEqual(pages[0], { id: rocket, icon: "🚀", kind: "document" });
  assert.deepEqual(pages[1], { id: tasks, icon: "", kind: "database" });
});

test("the tab's store and the editor's icons", async () => {
  const icons = await import("../components/page-link-icons");
  const { documentSchema } = await import("../lib/document-schema");
  const schema = documentSchema();
  const a = "0b7c6a4e-1d2f-4a3b-9c8d-7e6f5a4b3c2d",
    b = "2b7c6a4e-1d2f-4a3b-9c8d-7e6f5a4b3c2d",
    gone = "3b7c6a4e-1d2f-4a3b-9c8d-7e6f5a4b3c2d";
  let calls = 0;
  const stop = icons.subscribeLinkTargets(() => calls++);
  icons.setLinkTargetPages(
    [
      { id: a, icon: "🚀", kind: "document" },
      { id: b, icon: "file", kind: "database" },
      { id: gone, icon: "🗑️", kind: "document", deleted_at: "2026-01-01" },
    ],
    "share",
  );
  assert.equal(calls, 1);
  // The same pages again: nobody is told.
  icons.setLinkTargetPages([{ id: a, icon: "🚀", kind: "document" }, { id: b, icon: "file", kind: "database" }], "share");
  assert.equal(calls, 1);
  assert.equal(icons.linkIconFor(`/#page=${a}`), "🚀");
  assert.equal(icons.linkIconFor(`/share/tok/${b}`), "table");
  // Unknown, in the trash, or a block link without an own icon: the plain symbol.
  assert.equal(icons.linkIconFor(`/#page=${gone}`), null);
  assert.equal(icons.linkIconFor(`/#page=${b}&block=x1`), null);
  assert.equal(icons.linkIconFor(`/#page=${a}&block=x1`), "🚀");
  assert.equal(icons.linkIconFor("https://example.com"), null);
  const link = (href: string) => schema.marks.link.create({ href });
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [
      schema.text("See "),
      schema.text("Rak", [link(`/#page=${a}`)]),
      schema.text("eten", [link(`/#page=${a}`), schema.marks.bold.create()]),
      schema.text(" and "),
      schema.text("Tasks", [link(`/#page=${b}`)]),
      schema.text(" and "),
      schema.text("web", [link("https://example.com")]),
    ]),
  ]);
  const found = icons.iconDecorations(doc).find();
  // One icon per link (not per bold piece), none for the web link.
  assert.deepEqual(
    found.map((d) => d.from),
    [1 + "See ".length, 1 + "See Raketen and ".length],
  );
  assert.deepEqual(
    found.map((d) => (d as unknown as { spec: { key: string } }).spec.key),
    ["link-icon:🚀", "link-icon:table"],
  );
  // A new icon reaches the editors.
  icons.setLinkTargetPages([{ id: a, icon: "icon:Star:#cb912f", kind: "document" }, { id: b, icon: "file", kind: "database" }], "share");
  assert.equal(calls, 2);
  assert.equal(icons.linkIconFor(`/#page=${a}`), "icon:Star:#cb912f");
  stop();
});
