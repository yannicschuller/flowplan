import { test } from "node:test";
import { sqliteOnly } from "./helpers/backend";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
import {
  commentAnchor,
  commentRange,
  commentQuote,
} from "../lib/comment-positions";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-inline-comments-"),
);
const { one, all, run, id } = await import("../lib/db");
const { command } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { inlineThreads, withCommentDocument } =
  await import("../lib/inline-comments");
const { exportArchive, importArchive, readZip, writeZip } =
  await import("../lib/archive");
const { rowDocumentData } = await import("../lib/row-documents");
async function fixture() {
  async function user(name: string): Promise<Identity> {
    const uid = id();
    await run(
      "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
      uid,
      uid,
      name,
      `${uid}@test.invalid`,
    );
    return {
      id: uid,
      name,
      email: "",
      disabled: 0,
      created_at: "",
      isAdmin: false,
      groups: [],
    };
  }
  const owner = await user("Writer"),
    viewer = await user("Reader"),
    other = await user("Other"),
    wid = await createWorkspace(owner.id, "Inline tests"),
    sid = String((await one("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id);
  await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const act = async (data: Record<string, unknown>, u = owner): Promise<any> =>
    await command(u, data);
  const pageId = (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: sid,
    title: "Thread source",
  })).id;
  // The reader follows the page: new comments reach followers, not the
  // whole workspace (lib/comment-recipients.ts).
  await act({ action: "page.follow", pageId, follow: true }, viewer);
  const html =
    "<p>Alpha Bravo Charlie</p><ul><li><p>Nested words</p></li></ul>";
  await run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    pageId,
  );
  const anchor = async () =>
    await withCommentDocument(pageId, null, (b, g) => commentAnchor(b, 7, 12, g));
  const create = async (u = owner, extra = {}) => {
    const data = {
      action: "thread.create",
      pageId,
      threadId: id(),
      messageId: id(),
      anchor: await anchor(),
      body: "Please review",
      ...extra,
    };
    await act(data, u);
    return data;
  };
  return { owner, viewer, other, wid, sid, pageId, html, act, anchor, create };
}
test("threads accept readers, replies are idempotent, notifications respect rights, and content is unchanged", async () => {
  const f = await fixture(),
    before = await one("SELECT * FROM documents WHERE page_id=?", f.pageId),
    c = await f.create();
  const first = (await inlineThreads(f.viewer, f.pageId))[0];
  assert.equal(first.messages[0].body, "Please review");
  assert.equal(first.canResolve, false);
  assert.equal(
    (await all("SELECT * FROM notifications WHERE user_id=?", f.viewer.id)).length,
    1,
  );
  await f.act(c);
  assert.equal(
    (await all("SELECT * FROM notifications WHERE user_id=?", f.viewer.id)).length,
    1,
  );
  const reply = {
    action: "thread.reply",
    pageId: f.pageId,
    threadId: c.threadId,
    messageId: id(),
    body: "Looks good",
  };
  await f.act(reply, f.viewer);
  await f.act(reply, f.viewer);
  assert.equal((await inlineThreads(f.owner, f.pageId))[0].messageCount, 2);
  assert.equal(
    (await all("SELECT * FROM notifications WHERE user_id=?", f.owner.id)).length,
    1,
  );
  assert.equal(
    (await all("SELECT * FROM notifications WHERE user_id=?", f.other.id)).length,
    0,
  );
  assert.deepEqual(
    await one("SELECT * FROM documents WHERE page_id=?", f.pageId),
    before,
  );
  await assert.rejects(async () => await inlineThreads(f.other, f.pageId), /Berechtigung/);
});
test("resolution and message changes enforce ownership and compare versions without losing replies", async () => {
  const f = await fixture(),
    c = await f.create(),
    base = { pageId: f.pageId, threadId: c.threadId };
  await f.act(
    { action: "thread.reply", ...base, messageId: id(), body: "Second" },
    f.viewer,
  );
  await assert.rejects(
    async () =>
      await f.act({ action: "thread.resolve", ...base, version: 1, resolved: true }),
    /geändert/,
  );
  await assert.rejects(
    async () =>
      await f.act(
        { action: "thread.resolve", ...base, version: 2, resolved: true },
        f.viewer,
      ),
    /Verfasser/,
  );
  await f.act({
    action: "thread.edit",
    ...base,
    messageId: c.messageId,
    version: 1,
    body: "Changed",
  });
  await assert.rejects(
    async () =>
      await f.act({
        action: "thread.edit",
        ...base,
        messageId: c.messageId,
        version: 1,
        body: "Stale",
      }),
    /inzwischen/,
  );
  await assert.rejects(
    async () =>
      await f.act(
        {
          action: "thread.deleteMessage",
          ...base,
          messageId: c.messageId,
          version: 2,
        },
        f.viewer,
      ),
    /eigene/,
  );
  await f.act({
    action: "thread.deleteMessage",
    ...base,
    messageId: c.messageId,
    version: 2,
  });
  let thread = (await inlineThreads(f.owner, f.pageId))[0];
  assert.equal(thread.messages[0].body, "");
  assert.equal(thread.messages[1].body, "Second");
  await f.act({
    action: "thread.resolve",
    ...base,
    version: thread.version,
    resolved: true,
  });
  await assert.rejects(
    async () =>
      await f.act({ action: "thread.reply", ...base, messageId: id(), body: "Late" }),
    /wieder öffnen/,
  );
  thread = (await inlineThreads(f.owner, f.pageId))[0];
  await f.act({
    action: "thread.resolve",
    ...base,
    version: thread.version,
    resolved: false,
  });
  assert.equal((await inlineThreads(f.owner, f.pageId))[0].resolved, 0);
});
test("emoji reactions are distinct per member and reject arbitrary text; summaries bound message content", async () => {
  const f = await fixture(),
    c = await f.create(f.owner, { body: "A".repeat(300) }),
    base = {
      pageId: f.pageId,
      threadId: c.threadId,
      messageId: c.messageId,
      action: "thread.react",
      emoji: "🚀",
      active: true,
    };
  await f.act(base);
  await f.act(base);
  await f.act(base, f.viewer);
  let reaction = (await inlineThreads(f.owner, f.pageId))[0].messages[0].reactions[0];
  assert.equal(reaction.count, 2);
  assert.equal(reaction.mine, true);
  await f.act({ ...base, active: false });
  reaction = (await inlineThreads(f.owner, f.pageId))[0].messages[0].reactions[0];
  assert.equal(reaction.count, 1);
  assert.equal(reaction.mine, false);
  await assert.rejects(async () => await f.act({ ...base, emoji: "<script>" }));
  const summary = (await inlineThreads(f.owner, f.pageId, undefined, true))[0];
  assert.equal(summary.complete, false);
  assert.equal(summary.messages[0].body.length, 160);
  assert.deepEqual(summary.messages[0].reactions, []);
  assert.equal(
    (await inlineThreads(f.owner, f.pageId, undefined, true, c.threadId))[0].messages[0]
      .body.length,
    300,
  );
});
// The stored reactions move by a SQLite migration step (lib/db.ts).
test("reactions with a redundant U+FE0F (emojibase-data 17) are read and stored as the picker's form", { skip: sqliteOnly }, async () => {
  const f = await fixture(),
    c = await f.create(f.owner),
    base = {
      pageId: f.pageId,
      threadId: c.threadId,
      messageId: c.messageId,
      action: "thread.react",
      active: true,
    };
  // Stored before the update: the viewer's 👍️ and the owner's ⌚️ and ⌚.
  await run("INSERT INTO inline_reactions VALUES(?,?,?)", c.messageId, f.viewer.id, "👍️");
  await run("INSERT INTO inline_reactions VALUES(?,?,?)", c.messageId, f.owner.id, "⌚️");
  await run("INSERT INTO inline_reactions VALUES(?,?,?)", c.messageId, f.owner.id, "⌚");
  (globalThis as { flowplanSchema?: number }).flowplanSchema = undefined;
  // An older client still sends 👍️; the heart keeps its FE0F.
  await f.act({ ...base, emoji: "👍️" });
  await f.act({ ...base, emoji: "❤️" });
  assert.deepEqual(
    Object.fromEntries(
      (await all<{ emoji: string; n: number }>(
        "SELECT emoji,count(*) n FROM inline_reactions WHERE message_id=? GROUP BY emoji",
        c.messageId,
      )).map((r) => [r.emoji, r.n]),
    ),
    { "⌚": 1, "❤️": 1, "👍": 2 },
  );
  const thumbs = (await inlineThreads(f.owner, f.pageId))[0].messages[0].reactions.find((r) => r.emoji === "👍");
  assert.equal(thumbs?.count, 2);
  await f.act({ ...base, emoji: "👍", active: false });
  await f.act({ ...base, emoji: "⌚️", active: false });
  assert.deepEqual(
    (await all<{ emoji: string }>("SELECT emoji FROM inline_reactions WHERE message_id=? AND user_id=?", c.messageId, f.owner.id)).map((r) => r.emoji),
    ["❤️"],
  );
});
test("relative anchors follow insertions, reject stale drafts, and detach after deletion or generation changes", async () => {
  const f = await fixture(),
    anchor = await f.anchor(),
    c = await f.create();
  await withCommentDocument(f.pageId, null, async (b) => {
    const text = (b.type.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(0, "New ");
    await run(
      "UPDATE documents SET state=? WHERE page_id=?",
      Y.encodeStateAsUpdate(b.doc),
      f.pageId,
    );
  });
  await withCommentDocument(f.pageId, null, (b, g) => {
    const r = commentRange(b, anchor, g)!;
    assert.equal(r.from, 11);
    assert.equal(commentQuote(b.content, r.from, r.to), "Bravo");
  });
  // Original quote still matches after insertion before the selection.
  await f.create(f.viewer, { anchor });
  await withCommentDocument(f.pageId, null, async (b) => {
    const text = (b.type.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.delete(10, 5);
    await run(
      "UPDATE documents SET state=? WHERE page_id=?",
      Y.encodeStateAsUpdate(b.doc),
      f.pageId,
    );
  });
  await withCommentDocument(f.pageId, null, (b, g) =>
    assert.equal(commentRange(b, anchor, g), null),
  );
  await assert.rejects(async () => await f.create(f.viewer, { anchor }), /Textstelle/);
  assert.equal((await inlineThreads(f.owner, f.pageId))[0].anchor.quote, "Bravo");
  await run("UPDATE documents SET generation=? WHERE page_id=?", id(), f.pageId);
  await assert.rejects(async () => await f.create(f.viewer, { anchor }), /Textstelle/);
  assert.equal(
    (await inlineThreads(f.owner, f.pageId)).some((t) => t.id === c.threadId),
    true,
  );
});
test("document and row scope, private permissions and generation validation reject forged anchors", async () => {
  const f = await fixture(),
    c = await f.create(),
    database = (await f.act({
      action: "page.create",
      workspaceId: f.wid,
      spaceId: f.sid,
      title: "Rows",
      kind: "database",
    })).id;
  const row = (await f.act({
    action: "row.create",
    pageId: database,
    cells: { title: "One" },
  })).id;
  await rowDocumentData(f.owner, database, row);
  await run(
    "UPDATE row_documents SET html=?,state=? WHERE row_id=?",
    f.html,
    htmlState(f.html),
    row,
  );
  await assert.rejects(
    async () =>
      await f.act({
        ...c,
        threadId: id(),
        messageId: id(),
        pageId: database,
        rowId: row,
      }),
    /Textstelle/,
  );
  await assert.rejects(
    async () => await f.act({ ...c, threadId: id(), messageId: id(), rowId: row }),
    /Datenbank/,
  );
  const anchor = await withCommentDocument(database, row, (b, g) =>
    commentAnchor(b, 7, 12, g),
  );
  await f.act({
    ...c,
    threadId: id(),
    messageId: id(),
    pageId: database,
    rowId: row,
    anchor,
  });
  assert.equal((await inlineThreads(f.viewer, database, row)).length, 1);
  await run("UPDATE spaces SET visibility='private' WHERE id=?", f.sid);
  await assert.rejects(async () => await inlineThreads(f.viewer, database, row), /Berechtigung/);
  await assert.rejects(
    async () => await f.act({ ...c, threadId: id(), messageId: id() }, f.viewer),
    /Berechtigung/,
  );
  await run("DELETE FROM rows WHERE id=?", row);
  assert.equal(
    (await all("SELECT * FROM inline_threads WHERE row_id=?", row)).length,
    0,
  );
});
test("ZIP archives preserve threads, quotes, replies and reactions with fresh document anchors", async () => {
  const f = await fixture(),
    c = await f.create();
  await f.act(
    {
      action: "thread.reply",
      pageId: f.pageId,
      threadId: c.threadId,
      messageId: id(),
      body: "Agreed",
    },
    f.viewer,
  );
  await f.act(
    {
      action: "thread.react",
      pageId: f.pageId,
      threadId: c.threadId,
      messageId: c.messageId,
      emoji: "👍🏽",
      active: true,
    },
    f.viewer,
  );
  const bytes = await exportArchive(f.owner, f.wid),
    zip = await readZip(bytes),
    manifest = JSON.parse(zip.get("flowplan.json")!.toString());
  const original = manifest.pages.find((p: any) => p.id === f.pageId);
  assert.equal(original.inlineThreads[0].messages.length, 2);
  const imported = await importArchive(f.owner, f.wid, bytes),
    copy = imported.pageIds[f.pageId],
    thread = (await inlineThreads(f.owner, copy))[0];
  assert.equal(thread.messages[1].body, "Agreed");
  assert.equal(thread.messages[0].name, f.owner.name);
  assert.equal(thread.messages[0].author_id, null);
  assert.equal(thread.messages[0].reactions[0].count, 1);
  assert.equal(thread.messages[0].reactions[0].mine, false);
  await withCommentDocument(copy, null, (b, g) => {
    const r = commentRange(b, thread.anchor, g)!;
    assert.equal(commentQuote(b.content, r.from, r.to), "Bravo");
  });
  // Corrupt portable ranges remain detached instead of guessing another quote.
  original.inlineThreads[0].range.from = 999999;
  zip.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const detached = await importArchive(f.owner, f.wid, await writeZip(zip));
  const dt = (await inlineThreads(f.owner, detached.pageIds[f.pageId]))[0];
  assert.equal(dt.anchor.generation, "detached-import");
});
test("database snapshots recover row threads after deletion with visible historical authorship", async () => {
  const f = await fixture(),
    database = (await f.act({
      action: "page.create",
      workspaceId: f.wid,
      spaceId: f.sid,
      title: "Row threads",
      kind: "database",
    })).id;
  const row = (await f.act({
    action: "row.create",
    pageId: database,
    cells: { title: "Entry" },
  })).id;
  await rowDocumentData(f.owner, database, row);
  await run(
    "UPDATE row_documents SET html=?,state=? WHERE row_id=?",
    f.html,
    htmlState(f.html),
    row,
  );
  await run("UPDATE rows SET content=? WHERE id=?", f.html, row);
  const anchor = await withCommentDocument(database, row, (b, g) =>
    commentAnchor(b, 7, 12, g),
  );
  await f.act(
    {
      action: "thread.create",
      pageId: database,
      rowId: row,
      threadId: id(),
      messageId: id(),
      anchor,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Recover me", marks: [{ type: "bold" }] },
            ],
          },
          {
            type: "paragraph",
            content: [
              {
                type: "mention",
                attrs: { userId: f.owner.id, label: "Writer" },
              },
            ],
          },
        ],
      },
    },
    f.viewer,
  );
  const snapshot = (await f.act({ action: "page.snapshot", pageId: database })).id;
  await f.act({ action: "row.delete", pageId: database, rowId: row });
  await f.act({ action: "snapshot.restore", pageId: database, snapshotId: snapshot });
  const thread = (await inlineThreads(f.owner, database, row))[0];
  assert.equal(thread.messages[0].body, "Recover me\n@Writer");
  assert.equal(
    thread.messages[0].content?.content?.[0].content?.[0].marks?.[0].type,
    "bold",
  );
  assert.equal(
    thread.messages[0].content?.content?.[1].content?.[0].attrs?.userId,
    null,
  );
  assert.equal(thread.messages[0].name, "Reader");
  await withCommentDocument(database, row, (b, g) =>
    assert.ok(commentRange(b, thread.anchor, g)),
  );
});
test("comment draft storage scopes users and documents, expires stale drafts and reports quota failures", async () => {
  const { readCommentDrafts, saveCommentDrafts } =
    await import("../lib/comment-drafts");
  const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "sessionStorage",
    ),
    values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
  };
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
  });
  try {
    const tid = id(),
      mid = id();
    assert.equal(
      saveCommentDrafts("user:doc:row", "Pending", {
        [tid]: { id: mid, body: "Reply" },
      }),
      true,
    );
    assert.equal(readCommentDrafts("user:doc:row").replies[tid].body, "Reply");
    assert.equal(readCommentDrafts("other:doc:row").body, "");
    const data = JSON.parse(values.get("user:doc:row")!);
    data.time = Date.now() - 86400001;
    values.set("user:doc:row", JSON.stringify(data));
    assert.equal(readCommentDrafts("user:doc:row").body, "");
    values.set("user:doc:row", "invalid");
    assert.equal(readCommentDrafts("user:doc:row").body, "");
    storage.setItem = () => {
      throw new Error("Quota");
    };
    assert.equal(saveCommentDrafts("user:doc:row", "Pending", {}), false);
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("Storage denied");
      },
    });
    assert.deepEqual(readCommentDrafts("user:doc:row").replies, {});
    assert.equal(saveCommentDrafts("user:doc:row", "Pending", {}), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
test("archived database versions remap row threads and reject foreign row references atomically", async () => {
  const f = await fixture(),
    database = (await f.act({
      action: "page.create",
      workspaceId: f.wid,
      spaceId: f.sid,
      title: "Historical threads",
      kind: "database",
    })).id;
  const row = (await f.act({
    action: "row.create",
    pageId: database,
    cells: { title: "Entry" },
  })).id;
  await rowDocumentData(f.owner, database, row);
  await run(
    "UPDATE row_documents SET html=?,state=? WHERE row_id=?",
    f.html,
    htmlState(f.html),
    row,
  );
  await run("UPDATE rows SET content=? WHERE id=?", f.html, row);
  const anchor = await withCommentDocument(database, row, (b, g) =>
    commentAnchor(b, 7, 12, g),
  );
  await f.act({
    action: "thread.create",
    pageId: database,
    rowId: row,
    threadId: id(),
    messageId: id(),
    anchor,
    body: "History reply",
  });
  await f.act({ action: "page.snapshot", pageId: database });
  await f.act({ action: "row.delete", pageId: database, rowId: row });
  const bytes = await exportArchive(f.owner, f.wid),
    imported = await importArchive(f.owner, f.wid, bytes),
    copy = imported.pageIds[database];
  const snapshot = (await one<{ id: string; html: string }>(
      "SELECT id,html FROM snapshots WHERE page_id=?",
      copy,
    ))!,
    payload = JSON.parse(snapshot.html);
  assert.equal(payload.inlineThreads[0].row_id, payload.rows[0].id);
  await f.act({ action: "snapshot.restore", pageId: copy, snapshotId: snapshot.id });
  const thread = (await inlineThreads(f.owner, copy, payload.rows[0].id))[0];
  assert.equal(thread.messages[0].body, "History reply");
  await withCommentDocument(copy, payload.rows[0].id, (b, g) =>
    assert.ok(commentRange(b, thread.anchor, g)),
  );
  const zip = await readZip(bytes),
    manifest = JSON.parse(zip.get("flowplan.json")!.toString()),
    p = manifest.pages.find((p: any) => p.id === database),
    bad = JSON.parse(p.snapshots[0].html);
  bad.inlineThreads[0].row_id = id();
  p.snapshots[0].html = JSON.stringify(bad);
  zip.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const count = (await all("SELECT id FROM pages")).length;
  await assert.rejects(
    importArchive(f.owner, f.wid, await writeZip(zip)),
    /Datenbankversion/,
  );
  assert.equal((await all("SELECT id FROM pages")).length, count);
});

test("thread notifications preserve scoped row and thread destinations for initial comments and replies", async () => {
  const f = await fixture();
  const t = await f.create();
  const first = (await one<{
    page_id: string;
    row_id: string | null;
    thread_id: string;
  }>(
    "SELECT * FROM notifications WHERE user_id=? AND thread_id=?",
    f.viewer.id,
    t.threadId,
  ))!;
  assert.equal(first.page_id, f.pageId);
  assert.equal(first.row_id, null);
  assert.equal(first.thread_id, t.threadId);
  await f.act(
    {
      action: "thread.reply",
      pageId: f.pageId,
      threadId: t.threadId,
      messageId: id(),
      body: "Reply destination",
    },
    f.viewer,
  );
  assert.equal(
    (await one(
      "SELECT thread_id FROM notifications WHERE user_id=? AND thread_id=?",
      f.owner.id,
      t.threadId,
    ))?.thread_id,
    t.threadId,
  );
  const database = (await f.act({
    action: "page.create",
    workspaceId: f.wid,
    spaceId: f.sid,
    title: "Rows",
    kind: "database",
  })).id;
  const row = (await f.act({
    action: "row.create",
    pageId: database,
    cells: { title: "Row" },
  })).id;
  await f.act({ action: "page.follow", pageId: database, follow: true }, f.viewer);
  await rowDocumentData(f.owner, database, row);
  await run(
    "UPDATE row_documents SET state=?,html=? WHERE row_id=?",
    htmlState(f.html),
    f.html,
    row,
  );
  const anchor = await withCommentDocument(database, row, (b, g) =>
    commentAnchor(b, 7, 12, g),
  );
  const tid = id();
  await f.act({
    action: "thread.create",
    pageId: database,
    rowId: row,
    threadId: tid,
    messageId: id(),
    anchor,
    body: "Row destination",
  });
  const n = (await one(
    "SELECT page_id,row_id,thread_id FROM notifications WHERE user_id=? AND thread_id=?",
    f.viewer.id,
    tid,
  ))!;
  assert.deepEqual(
    { ...n },
    { page_id: database, row_id: row, thread_id: tid },
  );
  await f.act({
    action: "comment.create",
    pageId: database,
    rowId: row,
    body: "Ordinary row comment",
  });
  assert.equal(
    (await one(
      "SELECT row_id FROM notifications WHERE user_id=? AND page_id=? AND thread_id IS NULL",
      f.viewer.id,
      database,
    ))?.row_id,
    row,
  );
});

test("formatted messages preserve marks across retries and edits; plain text remains compatible", async () => {
  const f = await fixture();
  const rich = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Formatted", marks: [{ type: "bold" }] },
        ],
      },
    ],
  };
  const c = await f.create(f.owner, { content: rich, body: "Ignored client text" });
  const message = (await inlineThreads(f.viewer, f.pageId))[0].messages[0];
  assert.equal(message.body, "Formatted");
  assert.deepEqual(message.content, rich);
  await f.act(c);
  await assert.rejects(
    async () =>
      await f.act({
        ...c,
        content: {
          ...rich,
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Formatted",
                  marks: [{ type: "italic" }],
                },
              ],
            },
          ],
        },
      }),
    /anders gespeichert/,
  );
  await f.act({
    action: "thread.edit",
    pageId: f.pageId,
    threadId: c.threadId,
    messageId: c.messageId,
    version: 1,
    body: "<b>Literal old client</b>",
  });
  const changed = (await inlineThreads(f.viewer, f.pageId))[0].messages[0];
  assert.equal(changed.body, "<b>Literal old client</b>");
  assert.equal(changed.content, null);
  await assert.rejects(
    async () =>
      await f.act({
        action: "thread.edit",
        pageId: f.pageId,
        threadId: c.threadId,
        messageId: c.messageId,
        version: 1,
        content: rich,
      }),
    /inzwischen/,
  );
  await f.act({
    action: "thread.deleteMessage",
    pageId: f.pageId,
    threadId: c.threadId,
    messageId: c.messageId,
    version: 2,
  });
  assert.equal(
    (await one("SELECT rich_body FROM inline_messages WHERE id=?", c.messageId))
      ?.rich_body,
    null,
  );
});
test("mention lookup and submission enforce current page access, active accounts and server-derived names", async () => {
  const f = await fixture();
  const { inlineMentionCandidates } = await import("../lib/inline-comments");
  const content = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "mention",
            attrs: { userId: f.viewer.id, label: "Forged name" },
          },
        ],
      },
    ],
  };
  assert.deepEqual(
    (await inlineMentionCandidates(f.owner, f.pageId, undefined, "read")).map(
      (u) => u.id,
    ),
    [f.viewer.id],
  );
  await assert.rejects(
    async () => await inlineMentionCandidates(f.other, f.pageId),
    /Berechtigung/,
  );
  const c = await f.create(f.owner, { content });
  assert.equal(
    (await inlineThreads(f.viewer, f.pageId))[0].messages[0].body,
    "@Reader",
  );
  assert.match(
    String(
      (await one(
        "SELECT body FROM notifications WHERE user_id=? AND thread_id=?",
        f.viewer.id,
        c.threadId,
      ))?.body,
    ),
    /erwähnt/,
  );
  await run("UPDATE users SET name='Renamed Reader' WHERE id=?", f.viewer.id);
  await f.act(c); // Retries are stable even after the mentioned person's display name changes.
  assert.equal(
    (await all(
      "SELECT id FROM notifications WHERE user_id=? AND thread_id=?",
      f.viewer.id,
      c.threadId,
    )).length,
    1,
  );
  await run("UPDATE users SET disabled=1 WHERE id=?", f.viewer.id);
  assert.equal(
    (await inlineMentionCandidates(f.owner, f.pageId, undefined, "Reader")).length,
    0,
  );
  await assert.rejects(async () => await f.create(f.owner, { content }), /keinen Zugriff/);
  await run("UPDATE users SET disabled=0 WHERE id=?", f.viewer.id);
  await run("UPDATE spaces SET visibility='private' WHERE id=?", f.sid);
  assert.equal((await inlineMentionCandidates(f.owner, f.pageId)).length, 1);
  await assert.rejects(async () => await f.create(f.owner, { content }), /keinen Zugriff/);
  assert.equal(
    (await all("SELECT id FROM inline_threads WHERE page_id=?", f.pageId)).length,
    1,
  );
});
test("reply mentions notify non-participants once; edits notify only newly mentioned members with exact destinations", async () => {
  const f = await fixture(),
    c = await f.create();
  await run("INSERT INTO members VALUES(?,?,?)", f.wid, f.other.id, "viewer");
  const rich = (uid: string) => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Please " },
          { type: "mention", attrs: { userId: uid, label: "Name" } },
        ],
      },
    ],
  });
  const reply = {
    action: "thread.reply",
    pageId: f.pageId,
    threadId: c.threadId,
    messageId: id(),
    content: rich(f.other.id),
  };
  await f.act(reply, f.viewer);
  await f.act(reply, f.viewer);
  assert.equal(
    (await all(
      "SELECT id FROM notifications WHERE user_id=? AND thread_id=?",
      f.other.id,
      c.threadId,
    )).length,
    1,
  );
  const n = (await one(
    "SELECT * FROM notifications WHERE user_id=? AND thread_id=?",
    f.other.id,
    c.threadId,
  ))!;
  assert.equal(n.page_id, f.pageId);
  assert.equal(n.row_id, null);
  assert.match(String(n.body), /erwähnt/);
  await f.act({
    action: "thread.edit",
    pageId: f.pageId,
    threadId: c.threadId,
    messageId: c.messageId,
    version: 1,
    content: rich(f.viewer.id),
  });
  assert.equal(
    (await all(
      "SELECT id FROM notifications WHERE user_id=? AND thread_id=?",
      f.viewer.id,
      c.threadId,
    )).length,
    2,
  );
  await f.act({
    action: "thread.edit",
    pageId: f.pageId,
    threadId: c.threadId,
    messageId: c.messageId,
    version: 2,
    content: rich(f.viewer.id),
  });
  assert.equal(
    (await all(
      "SELECT id FROM notifications WHERE user_id=? AND thread_id=?",
      f.viewer.id,
      c.threadId,
    )).length,
    2,
  );
});
test("archives retain rich comments while imported mentions become historical and trigger no notifications", async () => {
  const f = await fixture();
  await f.create(f.owner, {
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Please ", marks: [{ type: "bold" }] },
            {
              type: "mention",
              attrs: { userId: f.viewer.id, label: "Reader" },
            },
          ],
        },
      ],
    },
  });
  const bytes = await exportArchive(f.owner, f.wid),
    before = (await all("SELECT id FROM notifications")).length;
  const imported = await importArchive(f.owner, f.wid, bytes);
  const message = (await inlineThreads(f.owner, imported.pageIds[f.pageId]))[0]
    .messages[0];
  assert.equal(message.body, "Please @Reader");
  assert.equal(message.content?.content?.[0].content?.[1].attrs?.userId, null);
  assert.equal(
    message.content?.content?.[0].content?.[0].marks?.[0].type,
    "bold",
  );
  assert.equal((await all("SELECT id FROM notifications")).length, before);
  const zip = await readZip(bytes),
    manifest = JSON.parse(zip.get("flowplan.json")!.toString());
  manifest.pages.find(
    (p: any) => p.id === f.pageId,
  ).inlineThreads[0].messages[0].body = "Mismatched";
  zip.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const count = (await all("SELECT id FROM pages")).length;
  await assert.rejects(
    importArchive(f.owner, f.wid, await writeZip(zip)),
    /stimmen nicht überein/,
  );
  assert.equal((await all("SELECT id FROM pages")).length, count);
});

test("rich comment drafts preserve formatting and mentions separately for new messages and replies", async () => {
  const { saveCommentDrafts, readCommentDrafts } =
    await import("../lib/comment-drafts");
  const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "sessionStorage",
    ),
    values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) || null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    },
  });
  try {
    const content = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Draft",
                marks: [{ type: "bold" as const }],
              },
            ],
          },
        ],
      },
      tid = id();
    assert.equal(
      saveCommentDrafts(
        "rich",
        "Draft",
        { [tid]: { id: id(), body: "Draft", content } },
        content,
      ),
      true,
    );
    const saved = readCommentDrafts("rich");
    assert.deepEqual(saved.content, content);
    assert.deepEqual(saved.replies[tid].content, content);
    const corrupt = JSON.parse(values.get("rich")!);
    corrupt.content.content[0].content[0].marks = [
      { type: "link", attrs: { href: "javascript:alert(1)" } },
    ];
    values.set("rich", JSON.stringify(corrupt));
    assert.equal(readCommentDrafts("rich").body, "");
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
