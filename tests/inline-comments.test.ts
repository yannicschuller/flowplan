import { test } from "node:test";
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
function fixture() {
  function user(name: string): Identity {
    const uid = id();
    run(
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
  const owner = user("Writer"),
    viewer = user("Reader"),
    other = user("Other"),
    wid = createWorkspace(owner.id, "Inline tests"),
    sid = String(one("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id);
  run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const act = (data: Record<string, unknown>, u = owner): any =>
    command(u, data);
  const pageId = act({
    action: "page.create",
    workspaceId: wid,
    spaceId: sid,
    title: "Thread source",
  }).id;
  const html =
    "<p>Alpha Bravo Charlie</p><ul><li><p>Nested words</p></li></ul>";
  run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    pageId,
  );
  const anchor = () =>
    withCommentDocument(pageId, null, (b, g) => commentAnchor(b, 7, 12, g));
  const create = (u = owner, extra = {}) => {
    const data = {
      action: "thread.create",
      pageId,
      threadId: id(),
      messageId: id(),
      anchor: anchor(),
      body: "Please review",
      ...extra,
    };
    act(data, u);
    return data;
  };
  return { owner, viewer, other, wid, sid, pageId, html, act, anchor, create };
}
test("threads accept readers, replies are idempotent, notifications respect rights, and content is unchanged", () => {
  const f = fixture(),
    before = one("SELECT * FROM documents WHERE page_id=?", f.pageId),
    c = f.create();
  const first = inlineThreads(f.viewer, f.pageId)[0];
  assert.equal(first.messages[0].body, "Please review");
  assert.equal(first.canResolve, false);
  assert.equal(
    all("SELECT * FROM notifications WHERE user_id=?", f.viewer.id).length,
    1,
  );
  f.act(c);
  assert.equal(
    all("SELECT * FROM notifications WHERE user_id=?", f.viewer.id).length,
    1,
  );
  const reply = {
    action: "thread.reply",
    pageId: f.pageId,
    threadId: c.threadId,
    messageId: id(),
    body: "Looks good",
  };
  f.act(reply, f.viewer);
  f.act(reply, f.viewer);
  assert.equal(inlineThreads(f.owner, f.pageId)[0].messageCount, 2);
  assert.equal(
    all("SELECT * FROM notifications WHERE user_id=?", f.owner.id).length,
    1,
  );
  assert.equal(
    all("SELECT * FROM notifications WHERE user_id=?", f.other.id).length,
    0,
  );
  assert.deepEqual(
    one("SELECT * FROM documents WHERE page_id=?", f.pageId),
    before,
  );
  assert.throws(() => inlineThreads(f.other, f.pageId), /Berechtigung/);
});
test("resolution and message changes enforce ownership and compare versions without losing replies", () => {
  const f = fixture(),
    c = f.create(),
    base = { pageId: f.pageId, threadId: c.threadId };
  f.act(
    { action: "thread.reply", ...base, messageId: id(), body: "Second" },
    f.viewer,
  );
  assert.throws(
    () =>
      f.act({ action: "thread.resolve", ...base, version: 1, resolved: true }),
    /geändert/,
  );
  assert.throws(
    () =>
      f.act(
        { action: "thread.resolve", ...base, version: 2, resolved: true },
        f.viewer,
      ),
    /Verfasser/,
  );
  f.act({
    action: "thread.edit",
    ...base,
    messageId: c.messageId,
    version: 1,
    body: "Changed",
  });
  assert.throws(
    () =>
      f.act({
        action: "thread.edit",
        ...base,
        messageId: c.messageId,
        version: 1,
        body: "Stale",
      }),
    /inzwischen/,
  );
  assert.throws(
    () =>
      f.act(
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
  f.act({
    action: "thread.deleteMessage",
    ...base,
    messageId: c.messageId,
    version: 2,
  });
  let thread = inlineThreads(f.owner, f.pageId)[0];
  assert.equal(thread.messages[0].body, "");
  assert.equal(thread.messages[1].body, "Second");
  f.act({
    action: "thread.resolve",
    ...base,
    version: thread.version,
    resolved: true,
  });
  assert.throws(
    () =>
      f.act({ action: "thread.reply", ...base, messageId: id(), body: "Late" }),
    /wieder öffnen/,
  );
  thread = inlineThreads(f.owner, f.pageId)[0];
  f.act({
    action: "thread.resolve",
    ...base,
    version: thread.version,
    resolved: false,
  });
  assert.equal(inlineThreads(f.owner, f.pageId)[0].resolved, 0);
});
test("emoji reactions are distinct per member and reject arbitrary text; summaries bound message content", () => {
  const f = fixture(),
    c = f.create(f.owner, { body: "A".repeat(300) }),
    base = {
      pageId: f.pageId,
      threadId: c.threadId,
      messageId: c.messageId,
      action: "thread.react",
      emoji: "🚀",
      active: true,
    };
  f.act(base);
  f.act(base);
  f.act(base, f.viewer);
  let reaction = inlineThreads(f.owner, f.pageId)[0].messages[0].reactions[0];
  assert.equal(reaction.count, 2);
  assert.equal(reaction.mine, true);
  f.act({ ...base, active: false });
  reaction = inlineThreads(f.owner, f.pageId)[0].messages[0].reactions[0];
  assert.equal(reaction.count, 1);
  assert.equal(reaction.mine, false);
  assert.throws(() => f.act({ ...base, emoji: "<script>" }));
  const summary = inlineThreads(f.owner, f.pageId, undefined, true)[0];
  assert.equal(summary.complete, false);
  assert.equal(summary.messages[0].body.length, 160);
  assert.deepEqual(summary.messages[0].reactions, []);
  assert.equal(
    inlineThreads(f.owner, f.pageId, undefined, true, c.threadId)[0].messages[0]
      .body.length,
    300,
  );
});
test("relative anchors follow insertions, reject stale drafts, and detach after deletion or generation changes", () => {
  const f = fixture(),
    anchor = f.anchor(),
    c = f.create();
  withCommentDocument(f.pageId, null, (b) => {
    const text = (b.type.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(0, "New ");
    run(
      "UPDATE documents SET state=? WHERE page_id=?",
      Y.encodeStateAsUpdate(b.doc),
      f.pageId,
    );
  });
  withCommentDocument(f.pageId, null, (b, g) => {
    const r = commentRange(b, anchor, g)!;
    assert.equal(r.from, 11);
    assert.equal(commentQuote(b.content, r.from, r.to), "Bravo");
  });
  // Original quote still matches after insertion before the selection.
  f.create(f.viewer, { anchor });
  withCommentDocument(f.pageId, null, (b) => {
    const text = (b.type.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.delete(10, 5);
    run(
      "UPDATE documents SET state=? WHERE page_id=?",
      Y.encodeStateAsUpdate(b.doc),
      f.pageId,
    );
  });
  withCommentDocument(f.pageId, null, (b, g) =>
    assert.equal(commentRange(b, anchor, g), null),
  );
  assert.throws(() => f.create(f.viewer, { anchor }), /Textstelle/);
  assert.equal(inlineThreads(f.owner, f.pageId)[0].anchor.quote, "Bravo");
  run("UPDATE documents SET generation=? WHERE page_id=?", id(), f.pageId);
  assert.throws(() => f.create(f.viewer, { anchor }), /Textstelle/);
  assert.equal(
    inlineThreads(f.owner, f.pageId).some((t) => t.id === c.threadId),
    true,
  );
});
test("document and row scope, private permissions and generation validation reject forged anchors", () => {
  const f = fixture(),
    c = f.create(),
    database = f.act({
      action: "page.create",
      workspaceId: f.wid,
      spaceId: f.sid,
      title: "Rows",
      kind: "database",
    }).id;
  const row = f.act({
    action: "row.create",
    pageId: database,
    cells: { title: "One" },
  }).id;
  rowDocumentData(f.owner, database, row);
  run(
    "UPDATE row_documents SET html=?,state=? WHERE row_id=?",
    f.html,
    htmlState(f.html),
    row,
  );
  assert.throws(
    () =>
      f.act({
        ...c,
        threadId: id(),
        messageId: id(),
        pageId: database,
        rowId: row,
      }),
    /Textstelle/,
  );
  assert.throws(
    () => f.act({ ...c, threadId: id(), messageId: id(), rowId: row }),
    /Datenbank/,
  );
  const anchor = withCommentDocument(database, row, (b, g) =>
    commentAnchor(b, 7, 12, g),
  );
  f.act({
    ...c,
    threadId: id(),
    messageId: id(),
    pageId: database,
    rowId: row,
    anchor,
  });
  assert.equal(inlineThreads(f.viewer, database, row).length, 1);
  run("UPDATE spaces SET visibility='private' WHERE id=?", f.sid);
  assert.throws(() => inlineThreads(f.viewer, database, row), /Berechtigung/);
  assert.throws(
    () => f.act({ ...c, threadId: id(), messageId: id() }, f.viewer),
    /Berechtigung/,
  );
  run("DELETE FROM rows WHERE id=?", row);
  assert.equal(
    all("SELECT * FROM inline_threads WHERE row_id=?", row).length,
    0,
  );
});
test("ZIP archives preserve threads, quotes, replies and reactions with fresh document anchors", async () => {
  const f = fixture(),
    c = f.create();
  f.act(
    {
      action: "thread.reply",
      pageId: f.pageId,
      threadId: c.threadId,
      messageId: id(),
      body: "Agreed",
    },
    f.viewer,
  );
  f.act(
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
    thread = inlineThreads(f.owner, copy)[0];
  assert.equal(thread.messages[1].body, "Agreed");
  assert.equal(thread.messages[0].name, f.owner.name);
  assert.equal(thread.messages[0].author_id, null);
  assert.equal(thread.messages[0].reactions[0].count, 1);
  assert.equal(thread.messages[0].reactions[0].mine, false);
  withCommentDocument(copy, null, (b, g) => {
    const r = commentRange(b, thread.anchor, g)!;
    assert.equal(commentQuote(b.content, r.from, r.to), "Bravo");
  });
  // Corrupt portable ranges remain detached instead of guessing another quote.
  original.inlineThreads[0].range.from = 999999;
  zip.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const detached = await importArchive(f.owner, f.wid, await writeZip(zip));
  const dt = inlineThreads(f.owner, detached.pageIds[f.pageId])[0];
  assert.equal(dt.anchor.generation, "detached-import");
});
test("database snapshots recover row threads after deletion with visible historical authorship", () => {
  const f = fixture(),
    database = f.act({
      action: "page.create",
      workspaceId: f.wid,
      spaceId: f.sid,
      title: "Row threads",
      kind: "database",
    }).id;
  const row = f.act({
    action: "row.create",
    pageId: database,
    cells: { title: "Entry" },
  }).id;
  rowDocumentData(f.owner, database, row);
  run(
    "UPDATE row_documents SET html=?,state=? WHERE row_id=?",
    f.html,
    htmlState(f.html),
    row,
  );
  run("UPDATE rows SET content=? WHERE id=?", f.html, row);
  const anchor = withCommentDocument(database, row, (b, g) =>
    commentAnchor(b, 7, 12, g),
  );
  f.act(
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
  const snapshot = f.act({ action: "page.snapshot", pageId: database }).id;
  f.act({ action: "row.delete", pageId: database, rowId: row });
  f.act({ action: "snapshot.restore", pageId: database, snapshotId: snapshot });
  const thread = inlineThreads(f.owner, database, row)[0];
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
  withCommentDocument(database, row, (b, g) =>
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
  const f = fixture(),
    database = f.act({
      action: "page.create",
      workspaceId: f.wid,
      spaceId: f.sid,
      title: "Historical threads",
      kind: "database",
    }).id;
  const row = f.act({
    action: "row.create",
    pageId: database,
    cells: { title: "Entry" },
  }).id;
  rowDocumentData(f.owner, database, row);
  run(
    "UPDATE row_documents SET html=?,state=? WHERE row_id=?",
    f.html,
    htmlState(f.html),
    row,
  );
  run("UPDATE rows SET content=? WHERE id=?", f.html, row);
  const anchor = withCommentDocument(database, row, (b, g) =>
    commentAnchor(b, 7, 12, g),
  );
  f.act({
    action: "thread.create",
    pageId: database,
    rowId: row,
    threadId: id(),
    messageId: id(),
    anchor,
    body: "History reply",
  });
  f.act({ action: "page.snapshot", pageId: database });
  f.act({ action: "row.delete", pageId: database, rowId: row });
  const bytes = await exportArchive(f.owner, f.wid),
    imported = await importArchive(f.owner, f.wid, bytes),
    copy = imported.pageIds[database];
  const snapshot = one<{ id: string; html: string }>(
      "SELECT id,html FROM snapshots WHERE page_id=?",
      copy,
    )!,
    payload = JSON.parse(snapshot.html);
  assert.equal(payload.inlineThreads[0].row_id, payload.rows[0].id);
  f.act({ action: "snapshot.restore", pageId: copy, snapshotId: snapshot.id });
  const thread = inlineThreads(f.owner, copy, payload.rows[0].id)[0];
  assert.equal(thread.messages[0].body, "History reply");
  withCommentDocument(copy, payload.rows[0].id, (b, g) =>
    assert.ok(commentRange(b, thread.anchor, g)),
  );
  const zip = await readZip(bytes),
    manifest = JSON.parse(zip.get("flowplan.json")!.toString()),
    p = manifest.pages.find((p: any) => p.id === database),
    bad = JSON.parse(p.snapshots[0].html);
  bad.inlineThreads[0].row_id = id();
  p.snapshots[0].html = JSON.stringify(bad);
  zip.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const count = all("SELECT id FROM pages").length;
  await assert.rejects(
    importArchive(f.owner, f.wid, await writeZip(zip)),
    /Datenbankversion/,
  );
  assert.equal(all("SELECT id FROM pages").length, count);
});

test("thread notifications preserve scoped row and thread destinations for initial comments and replies", () => {
  const f = fixture();
  const t = f.create();
  const first = one<{
    page_id: string;
    row_id: string | null;
    thread_id: string;
  }>(
    "SELECT * FROM notifications WHERE user_id=? AND thread_id=?",
    f.viewer.id,
    t.threadId,
  )!;
  assert.equal(first.page_id, f.pageId);
  assert.equal(first.row_id, null);
  assert.equal(first.thread_id, t.threadId);
  f.act(
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
    one(
      "SELECT thread_id FROM notifications WHERE user_id=? AND thread_id=?",
      f.owner.id,
      t.threadId,
    )?.thread_id,
    t.threadId,
  );
  const database = f.act({
    action: "page.create",
    workspaceId: f.wid,
    spaceId: f.sid,
    title: "Rows",
    kind: "database",
  }).id;
  const row = f.act({
    action: "row.create",
    pageId: database,
    cells: { title: "Row" },
  }).id;
  rowDocumentData(f.owner, database, row);
  run(
    "UPDATE row_documents SET state=?,html=? WHERE row_id=?",
    htmlState(f.html),
    f.html,
    row,
  );
  const anchor = withCommentDocument(database, row, (b, g) =>
    commentAnchor(b, 7, 12, g),
  );
  const tid = id();
  f.act({
    action: "thread.create",
    pageId: database,
    rowId: row,
    threadId: tid,
    messageId: id(),
    anchor,
    body: "Row destination",
  });
  const n = one(
    "SELECT page_id,row_id,thread_id FROM notifications WHERE user_id=? AND thread_id=?",
    f.viewer.id,
    tid,
  )!;
  assert.deepEqual(
    { ...n },
    { page_id: database, row_id: row, thread_id: tid },
  );
  f.act({
    action: "comment.create",
    pageId: database,
    rowId: row,
    body: "Ordinary row comment",
  });
  assert.equal(
    one(
      "SELECT row_id FROM notifications WHERE user_id=? AND page_id=? AND thread_id IS NULL",
      f.viewer.id,
      database,
    )?.row_id,
    row,
  );
});

test("formatted messages preserve marks across retries and edits; plain text remains compatible", () => {
  const f = fixture();
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
  const c = f.create(f.owner, { content: rich, body: "Ignored client text" });
  const message = inlineThreads(f.viewer, f.pageId)[0].messages[0];
  assert.equal(message.body, "Formatted");
  assert.deepEqual(message.content, rich);
  f.act(c);
  assert.throws(
    () =>
      f.act({
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
  f.act({
    action: "thread.edit",
    pageId: f.pageId,
    threadId: c.threadId,
    messageId: c.messageId,
    version: 1,
    body: "<b>Literal old client</b>",
  });
  const changed = inlineThreads(f.viewer, f.pageId)[0].messages[0];
  assert.equal(changed.body, "<b>Literal old client</b>");
  assert.equal(changed.content, null);
  assert.throws(
    () =>
      f.act({
        action: "thread.edit",
        pageId: f.pageId,
        threadId: c.threadId,
        messageId: c.messageId,
        version: 1,
        content: rich,
      }),
    /inzwischen/,
  );
  f.act({
    action: "thread.deleteMessage",
    pageId: f.pageId,
    threadId: c.threadId,
    messageId: c.messageId,
    version: 2,
  });
  assert.equal(
    one("SELECT rich_body FROM inline_messages WHERE id=?", c.messageId)
      ?.rich_body,
    null,
  );
});
test("mention lookup and submission enforce current page access, active accounts and server-derived names", async () => {
  const f = fixture();
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
    inlineMentionCandidates(f.owner, f.pageId, undefined, "read").map(
      (u) => u.id,
    ),
    [f.viewer.id],
  );
  assert.throws(
    () => inlineMentionCandidates(f.other, f.pageId),
    /Berechtigung/,
  );
  const c = f.create(f.owner, { content });
  assert.equal(
    inlineThreads(f.viewer, f.pageId)[0].messages[0].body,
    "@Reader",
  );
  assert.match(
    String(
      one(
        "SELECT body FROM notifications WHERE user_id=? AND thread_id=?",
        f.viewer.id,
        c.threadId,
      )?.body,
    ),
    /erwähnt/,
  );
  run("UPDATE users SET name='Renamed Reader' WHERE id=?", f.viewer.id);
  f.act(c); // Retries are stable even after the mentioned person's display name changes.
  assert.equal(
    all(
      "SELECT id FROM notifications WHERE user_id=? AND thread_id=?",
      f.viewer.id,
      c.threadId,
    ).length,
    1,
  );
  run("UPDATE users SET disabled=1 WHERE id=?", f.viewer.id);
  assert.equal(
    inlineMentionCandidates(f.owner, f.pageId, undefined, "Reader").length,
    0,
  );
  assert.throws(() => f.create(f.owner, { content }), /keinen Zugriff/);
  run("UPDATE users SET disabled=0 WHERE id=?", f.viewer.id);
  run("UPDATE spaces SET visibility='private' WHERE id=?", f.sid);
  assert.equal(inlineMentionCandidates(f.owner, f.pageId).length, 1);
  assert.throws(() => f.create(f.owner, { content }), /keinen Zugriff/);
  assert.equal(
    all("SELECT id FROM inline_threads WHERE page_id=?", f.pageId).length,
    1,
  );
});
test("reply mentions notify non-participants once; edits notify only newly mentioned members with exact destinations", () => {
  const f = fixture(),
    c = f.create();
  run("INSERT INTO members VALUES(?,?,?)", f.wid, f.other.id, "viewer");
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
  f.act(reply, f.viewer);
  f.act(reply, f.viewer);
  assert.equal(
    all(
      "SELECT id FROM notifications WHERE user_id=? AND thread_id=?",
      f.other.id,
      c.threadId,
    ).length,
    1,
  );
  const n = one(
    "SELECT * FROM notifications WHERE user_id=? AND thread_id=?",
    f.other.id,
    c.threadId,
  )!;
  assert.equal(n.page_id, f.pageId);
  assert.equal(n.row_id, null);
  assert.match(String(n.body), /erwähnt/);
  f.act({
    action: "thread.edit",
    pageId: f.pageId,
    threadId: c.threadId,
    messageId: c.messageId,
    version: 1,
    content: rich(f.viewer.id),
  });
  assert.equal(
    all(
      "SELECT id FROM notifications WHERE user_id=? AND thread_id=?",
      f.viewer.id,
      c.threadId,
    ).length,
    2,
  );
  f.act({
    action: "thread.edit",
    pageId: f.pageId,
    threadId: c.threadId,
    messageId: c.messageId,
    version: 2,
    content: rich(f.viewer.id),
  });
  assert.equal(
    all(
      "SELECT id FROM notifications WHERE user_id=? AND thread_id=?",
      f.viewer.id,
      c.threadId,
    ).length,
    2,
  );
});
test("archives retain rich comments while imported mentions become historical and trigger no notifications", async () => {
  const f = fixture();
  f.create(f.owner, {
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
    before = all("SELECT id FROM notifications").length;
  const imported = await importArchive(f.owner, f.wid, bytes);
  const message = inlineThreads(f.owner, imported.pageIds[f.pageId])[0]
    .messages[0];
  assert.equal(message.body, "Please @Reader");
  assert.equal(message.content?.content?.[0].content?.[1].attrs?.userId, null);
  assert.equal(
    message.content?.content?.[0].content?.[0].marks?.[0].type,
    "bold",
  );
  assert.equal(all("SELECT id FROM notifications").length, before);
  const zip = await readZip(bytes),
    manifest = JSON.parse(zip.get("flowplan.json")!.toString());
  manifest.pages.find(
    (p: any) => p.id === f.pageId,
  ).inlineThreads[0].messages[0].body = "Mismatched";
  zip.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const count = all("SELECT id FROM pages").length;
  await assert.rejects(
    importArchive(f.owner, f.wid, await writeZip(zip)),
    /stimmen nicht überein/,
  );
  assert.equal(all("SELECT id FROM pages").length, count);
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
