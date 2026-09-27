import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-reactions-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { htmlState, stateHtml } = await import("../lib/document-server");
const { parseReactions, toggleReaction } = await import("../lib/block-reactions");

const person = (name: string) => {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};
const anna = person("Anna");
const ben = person("Ben");
const wid = createWorkspace(anna.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "viewer");
const space = bootstrap(anna, wid).spaces[0].id;
const pageId = (
  command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title: "Idee", kind: "document" }) as { id: string }
).id;

test("comments collect emoji reactions per person", () => {
  command(anna, { action: "comment.create", pageId, body: "Gute Idee?" });
  const commentId = one<{ id: string }>("SELECT id FROM comments WHERE page_id=?", pageId)!.id;
  command(anna, { action: "comment.react", pageId, commentId, emoji: "👍" });
  // Readers may react too.
  command(ben, { action: "comment.react", pageId, commentId, emoji: "👍" });
  command(ben, { action: "comment.react", pageId, commentId, emoji: "🎉" });
  assert.throws(() => command(ben, { action: "comment.react", pageId, commentId, emoji: "<b>" }), /Emoji/);
  const reactions = (pageData(ben, pageId) as { comments: { reactions: { emoji: string; count: number; mine: boolean; names: string[] }[] }[] })
    .comments[0].reactions;
  assert.deepEqual(
    reactions.map((r) => [r.emoji, r.count, r.mine]),
    [
      ["👍", 2, true],
      ["🎉", 1, true],
    ],
  );
  assert.deepEqual(reactions[0].names, ["Anna", "Ben"]);
  command(ben, { action: "comment.react", pageId, commentId, emoji: "🎉", active: false });
  const after = (pageData(anna, pageId) as { comments: { reactions: { emoji: string; mine: boolean }[] }[] }).comments[0].reactions;
  assert.deepEqual(after.map((r) => [r.emoji, r.mine]), [["👍", true]]);
});

test("block reactions live in the document and survive saving", () => {
  const map = toggleReaction(toggleReaction(null, "👍", anna.id), "👍", ben.id);
  assert.deepEqual(map, { "👍": [anna.id, ben.id] });
  assert.equal(toggleReaction({ "👍": [anna.id] }, "👍", anna.id), null);
  const html = `<p data-reactions='${JSON.stringify(map)}'>Vorschlag</p><h2 data-reactions='{"x":"kaputt"}'>Titel</h2>`;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  const saved = stateHtml(doc);
  assert.match(saved, /data-reactions=/);
  const stored = /<p data-reactions="([^"]+)"/.exec(saved)![1].replace(/&quot;/g, '"');
  assert.deepEqual(parseReactions(stored), map);
  // Malformed values are dropped.
  assert.doesNotMatch(saved.split("<h2")[1], /data-reactions/);
});
