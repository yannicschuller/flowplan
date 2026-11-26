// "@" mentions in whiteboard texts (#567): the stored format, how the board
// and its exports read it, and the board among the backlinks of the page it
// mentions – on save, rename and delete, only for people who may read it –
// plus the notification of a person mentioned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wb-mentions-"));
const { all, id, run } = await import("../lib/db");
const { command, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const links = await import("../lib/whiteboard-links");
const rich = await import("../lib/whiteboard-richtext");
const { whiteboardSummary, whiteboardSnapshotItems } = await import("../lib/whiteboard");
const { itemText } = await import("../lib/whiteboard-model");
const { pageGraph } = await import("../lib/page-graph");
const { atOpensMentionInText } = await import("../lib/mention-trigger");

const PAGE = "0b9d2a4e-8c1f-4c3e-9b7a-1f2e3d4c5b6a";
const ROW = "1c8e3b5f-9d2a-4b4f-8c8b-2a3f4e5d6c7b";

test("stored format: [label](address) with page, record and person addresses", () => {
  assert.equal(links.mentionHref({ kind: "page", pageId: PAGE }), `/#page=${PAGE}`);
  assert.equal(links.mentionHref({ kind: "page", pageId: PAGE, rowId: ROW }), `/#page=${PAGE}&row=${ROW}`);
  assert.equal(links.mentionHref({ kind: "person", userId: "u-1" }), "mention:u-1");
  assert.deepEqual(links.parseMention(`/#page=${PAGE}`), { kind: "page", pageId: PAGE });
  assert.deepEqual(links.parseMention(`#page=${PAGE}&row=${ROW}`), { kind: "page", pageId: PAGE, rowId: ROW });
  assert.deepEqual(links.parseMention("mention:u-1"), { kind: "person", userId: "u-1" });
  // Element links, other parameters and anything odd are no mention.
  for (const bad of [`/#page=${PAGE}&item=x`, `/#page=${PAGE}&row=${ROW}&evil=1`, "/#page=nope", "mention:", "mention:a b", "mention:<x>", `https://x.example/#page=${PAGE}`])
    assert.equal(links.parseMention(bad), null, bad);
  // Mentions are safe links; the rest stays as it was.
  assert.equal(links.safeHref(`/#page=${PAGE}`), `/#page=${PAGE}`);
  assert.equal(links.safeHref("mention:u-1"), "mention:u-1");
  assert.equal(links.safeHref("mention:javascript:alert(1)"), null);
  assert.equal(links.safeHref("/#page=nope"), null);
  assert.deepEqual(links.linkTarget(`/#page=${PAGE}&row=${ROW}`, "other", "https://flow.example"), { kind: "page", href: `/#page=${PAGE}&row=${ROW}` });
  assert.equal(links.linkTarget("mention:u-1", "other", "https://flow.example"), null);
  // Written into the text; brackets and line breaks of a title cannot break it.
  assert.equal(rich.mentionMarkup("Plan [Q3]\nneu", { kind: "page", pageId: PAGE }), `[Plan Q3 neu](/#page=${PAGE})`);
  assert.equal(rich.mentionMarkup("  ", { kind: "page", pageId: PAGE }), `[…](/#page=${PAGE})`);
  // "@" opens the dialog where a mention can start, not inside a word.
  assert.equal(atOpensMentionInText("", 0), true);
  assert.equal(atOpensMentionInText("Hallo ", 6), true);
  assert.equal(atOpensMentionInText("(", 1), true);
  assert.equal(atOpensMentionInText("ada", 3), false);
});

test("reading: spans on the board, plain text, summary links, exports as text", () => {
  const text = `Siehe [Plan](/#page=${PAGE}) und [Heizung](/#page=${PAGE}&row=${ROW}), frag [@Ada](mention:u-1) <b>`;
  const [block] = rich.parseRichText(text);
  assert.equal(block.kind, "p");
  assert.deepEqual(block.kind === "p" && block.spans.filter((s) => s.href).map((s) => [s.text, s.href]), [
    ["Plan", `/#page=${PAGE}`],
    ["Heizung", `/#page=${PAGE}&row=${ROW}`],
    ["@Ada", "mention:u-1"],
  ]);
  assert.equal(rich.plainText(text), "Siehe Plan und Heizung, frag @Ada <b>");
  assert.equal(itemText({ type: "sticky", text }), "Siehe Plan und Heizung, frag @Ada <b>");
  // documents.html: page links and person mentions as in documents, all escaped.
  const html = rich.summaryHtml(text);
  assert.ok(html.includes(`<a href="/#page=${PAGE}">Plan</a>`), html);
  assert.ok(html.includes(`<a href="/#page=${PAGE}&amp;row=${ROW}">Heizung</a>`), html);
  assert.ok(html.includes('<span data-mention="u-1">@Ada</span>'), html);
  assert.ok(html.endsWith("&lt;b&gt;"), html);
  // The SVG export keeps the title as text, without the in-app address.
  const svg = rich.richTextHtml(text);
  assert.ok(svg.includes(">Plan</span>") && !svg.includes("#page="), svg);
  // Without a mention the summary is what it always was.
  assert.equal(
    whiteboardSummary([{ id: "a", type: "sticky", x: 0, y: 0, w: 1, h: 1, z: 1, text: "**Fett** & gut", tags: ["T"] }]),
    "<p>Fett &amp; gut T</p>",
  );
  assert.equal(
    whiteboardSummary([{ id: "a", type: "sticky", x: 0, y: 0, w: 1, h: 1, z: 1, text: `[Plan](/#page=${PAGE})`, tags: ["T"] }]),
    `<p><a href="/#page=${PAGE}">Plan</a> T</p>`,
  );
});

test("renames: mentions with the old title get the new one, own wording stays", () => {
  const text = `[Plan](/#page=${PAGE}) [Der Plan](/#page=${PAGE}) [Plan](/#page=${PAGE}&row=${ROW}) [Plan](https://x.example)`;
  assert.equal(
    rich.retitleMentions(text, { pageId: PAGE }, "Plan", "Plan 2027"),
    `[Plan 2027](/#page=${PAGE}) [Der Plan](/#page=${PAGE}) [Plan](/#page=${PAGE}&row=${ROW}) [Plan](https://x.example)`,
  );
  assert.equal(
    rich.retitleMentions(text, { pageId: PAGE, rowId: ROW }, "Plan", "Wartung"),
    `[Plan](/#page=${PAGE}) [Der Plan](/#page=${PAGE}) [Wartung](/#page=${PAGE}&row=${ROW}) [Plan](https://x.example)`,
  );
  assert.equal(rich.retitleMentions(text, { pageId: PAGE }, "Anders", "Neu"), null);
  assert.equal(rich.retitleMentions(text, { pageId: PAGE }, "Plan", "Plan"), null);
});

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

test("backlinks, graph, renames, deletes and notifications follow the board's texts", async () => {
  const owner = await account("wm-owner"),
    member = await account("wm-member"),
    outsider = await account("wm-outsider");
  const wid = await createWorkspace(owner.id, "Erwähnungen");
  await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
  const team = (await bootstrap(owner, wid)).spaces[0].id;
  const privateSpace = ((await command(owner, { action: "space.create", workspaceId: wid, name: "Privat", private: true })) as { id: string }).id;
  const page = async (title: string, kind = "document", spaceId = team) =>
    ((await command(owner, { action: "page.create", workspaceId: wid, spaceId, title, kind })) as { id: string }).id;
  const guide = await page("Anleitung"),
    notes = await page("Notizen", "database"),
    board = await page("Planungsboard", "whiteboard"),
    hiddenBoard = await page("Geheimes Board", "whiteboard", privateSpace);
  const heating = ((await command(owner, { action: "row.create", pageId: notes, cells: { title: "Heizung" } })) as { id: string }).id;

  // A client of a board: writes notes and syncs them.
  async function client(pageId: string, user: Identity = owner) {
    const data = (await pageData(user, pageId)) as { whiteboard: { state: string; generation: string } };
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(data.whiteboard.state, "base64"));
    let sent = Y.encodeStateVector(doc);
    const items = doc.getMap<Y.Map<unknown>>("items");
    return {
      doc,
      set(key: string, text: string) {
        const existing = items.get(key);
        if (existing) return existing.set("text", text);
        const map = new Y.Map<unknown>();
        for (const [k, v] of Object.entries({ type: "sticky", x: 0, y: 0, w: 200, h: 200, z: 1, text })) map.set(k, v);
        items.set(key, map);
      },
      remove(key: string) {
        items.delete(key);
      },
      async sync() {
        const vector = Y.encodeStateVector(doc);
        const update = Y.encodeStateAsUpdate(doc, sent);
        sent = vector;
        const result = (await command(user, { action: "whiteboard.sync", pageId, generation: data.whiteboard.generation, update: b64(update), vector: b64(vector) })) as { state: string };
        Y.applyUpdate(doc, Buffer.from(result.state, "base64"), "remote");
      },
    };
  }
  const backlinks = async (user: Identity, pageId: string) =>
    ((await pageData(user, pageId)) as { backlinks: { id: string; title: string; rowId?: string }[] }).backlinks.map((l) => l.title);

  const a = await client(board);
  a.set("n1", `Lies ${rich.mentionMarkup("Anleitung", { kind: "page", pageId: guide })} zuerst`);
  a.set("n2", `Und ${rich.mentionMarkup("Heizung", { kind: "page", pageId: notes, rowId: heating })}`);
  await a.sync();
  // The page lists the board; so does the database (the record link names it).
  assert.deepEqual(await backlinks(owner, guide), ["Planungsboard"]);
  assert.deepEqual(await backlinks(member, guide), ["Planungsboard"]);
  // The graph draws the edge board → page.
  const graph = await pageGraph(owner, wid);
  assert.ok(graph.edges.some((e) => e.from === board && e.to === guide && e.kind === "link"), JSON.stringify(graph.edges));

  // A board the member may not open is no backlink for them.
  const h = await client(hiddenBoard);
  h.set("x", rich.mentionMarkup("Anleitung", { kind: "page", pageId: guide }));
  await h.sync();
  assert.deepEqual((await backlinks(owner, guide)).sort(), ["Geheimes Board", "Planungsboard"]);
  assert.deepEqual(await backlinks(member, guide), ["Planungsboard"]);

  // Renaming the page: the mention on the board reads the new title.
  await command(owner, { action: "page.update", pageId: guide, patch: { title: "Handbuch" } });
  const texts = (await whiteboardSnapshotItems({ id: board } as never)).map((i) => i.text);
  assert.ok(texts.includes(`Lies [Handbuch](/#page=${guide}) zuerst`), JSON.stringify(texts));
  assert.deepEqual(await backlinks(member, guide), ["Planungsboard"]);
  // The open board gets the change with its next sync.
  await a.sync();
  assert.equal(a.doc.getMap<Y.Map<unknown>>("items").get("n1")?.get("text"), `Lies [Handbuch](/#page=${guide}) zuerst`);

  // The mention removed from the text: no backlink any more.
  a.set("n1", "Lies das Handbuch zuerst");
  await a.sync();
  assert.deepEqual(await backlinks(member, guide), []);
  a.set("n1", `Wieder ${rich.mentionMarkup("Handbuch", { kind: "page", pageId: guide })}`);
  await a.sync();
  assert.deepEqual(await backlinks(member, guide), ["Planungsboard"]);
  // The note deleted: gone again.
  a.remove("n1");
  await a.sync();
  assert.deepEqual(await backlinks(member, guide), []);
  a.set("n3", rich.mentionMarkup("Handbuch", { kind: "page", pageId: guide }));
  await a.sync();
  // The board in the trash: no backlink.
  await command(owner, { action: "page.delete", pageId: board });
  assert.deepEqual(await backlinks(member, guide), []);
  await command(owner, { action: "page.delete", pageId: hiddenBoard });

  // People: the person mentioned is told once; not the writer, nobody without access.
  const people = await page("Leute", "whiteboard");
  const p = await client(people);
  p.set("m", `${rich.mentionMarkup("@Mitglied", { kind: "person", userId: member.id })} ${rich.mentionMarkup("@Ich", { kind: "person", userId: owner.id })} ${rich.mentionMarkup("@Fremd", { kind: "person", userId: outsider.id })}`);
  await p.sync();
  const told = async (uid: string) => (await all("SELECT id FROM notifications WHERE user_id=? AND kind='mention' AND page_id=?", uid, people)).length;
  assert.equal(await told(member.id), 1);
  assert.equal(await told(owner.id), 0);
  assert.equal(await told(outsider.id), 0);
  // Editing the note again does not tell them a second time.
  p.set("m", `Hallo ${rich.mentionMarkup("@Mitglied", { kind: "person", userId: member.id })}`);
  await p.sync();
  assert.equal(await told(member.id), 1);
});
