import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-push-"));
const { one, run, id } = await import("../lib/db");
const {
  subscribePush,
  unsubscribePush,
  validatePushSubscription,
  flushPushQueue,
  pushKeys,
  testPush,
} = await import("../lib/push");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
function account(name: string) {
  const uid = id(),
    token = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.test`,
  );
  run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    token,
    uid,
    "[]",
    Date.now() + 3600000,
  );
  return {
    user: {
      id: uid,
      name,
      email: `${name}@example.test`,
      groups: [],
      isAdmin: false,
      disabled: 0,
      created_at: "",
    } as Identity,
    token,
  };
}
function subscription() {
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  return {
    endpoint: `https://web.push.apple.com/${id()}`,
    keys: {
      p256dh: curve.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
}
test("push registration binds a valid device to an authenticated session and rejects SSRF destinations", () => {
  const { user, token } = account("push-owner");
  const sub = subscription();
  assert.throws(() => subscribePush(user, "missing-session", sub), /Sitzung/);
  for (const endpoint of [
    "http://web.push.apple.com/a",
    "https://127.0.0.1/a",
    "https://web.push.apple.com.evil.test/a",
    "https://user@web.push.apple.com/a",
    "https://web.push.apple.com:444/a",
  ])
    assert.throws(
      () => validatePushSubscription({ ...sub, endpoint }),
      /Push-Dienst/,
    );
  subscribePush(user, token, sub);
  assert.equal(
    one<{ user_id: string }>(
      "SELECT user_id FROM push_subscriptions WHERE endpoint=?",
      sub.endpoint,
    )!.user_id,
    user.id,
  );
  unsubscribePush(account("other-user").user, sub.endpoint);
  assert.ok(
    one("SELECT id FROM push_subscriptions WHERE endpoint=?", sub.endpoint),
  );
  run("DELETE FROM sessions WHERE token=?", token);
  assert.equal(
    one("SELECT id FROM push_subscriptions WHERE endpoint=?", sub.endpoint),
    undefined,
  );
  assert.equal(pushKeys().publicKey, pushKeys().publicKey);
});
test("comments enqueue encrypted web push once, omit private content and recheck page permission before sending", async () => {
  const owner = account("author"),
    recipient = account("recipient");
  const wid = createWorkspace(owner.user.id, "Push workspace");
  run("INSERT INTO members VALUES(?,?,?)", wid, recipient.user.id, "editor");
  const page = bootstrap(owner.user, wid).pages[0];
  const sub = subscription();
  subscribePush(recipient.user, recipient.token, sub);
  command(owner.user, {
    action: "comment.create",
    pageId: page.id,
    body: "Confidential document text",
  });
  const sent: string[] = [];
  await flushPushQueue(async (subscription, payload, options) => {
    assert.equal(subscription.endpoint, sub.endpoint);
    assert.equal(options.contentEncoding, "aes128gcm");
    sent.push(payload);
  });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /Confidential|author|Push workspace/);
  assert.equal(JSON.parse(sent[0]).url, `/#page=${page.id}`);
  await flushPushQueue(async () => {
    throw new Error("Already delivered");
  });
  command(owner.user, {
    action: "comment.create",
    pageId: page.id,
    body: "Second comment",
  });
  run(
    "DELETE FROM members WHERE workspace_id=? AND user_id=?",
    wid,
    recipient.user.id,
  );
  await flushPushQueue(async () => {
    assert.fail("Revoked access must not receive push");
  });
  unsubscribePush(recipient.user, sub.endpoint);
});
test("push retries transient failures, removes expired devices and suppresses read notifications", async () => {
  const { user, token } = account("retry-user"),
    sub = subscription();
  subscribePush(user, token, sub);
  testPush(user, token);
  assert.throws(() => testPush(user, token), /Minute/);
  await flushPushQueue(async () => {
    throw { statusCode: 503 };
  });
  const job = one<{ id: number; attempts: number; available_at: number }>(
    "SELECT d.* FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id WHERE s.endpoint=?",
    sub.endpoint,
  )!;
  assert.equal(job.attempts, 1);
  assert.ok(job.available_at > Date.now());
  run("UPDATE push_deliveries SET available_at=0 WHERE id=?", job.id);
  await flushPushQueue(async () => {
    throw { statusCode: 410 };
  });
  assert.equal(
    one("SELECT id FROM push_subscriptions WHERE endpoint=?", sub.endpoint),
    undefined,
  );
  subscribePush(user, token, subscription());
  run(
    "INSERT INTO notifications(id,user_id,body,read_at) VALUES(?,?,?,CURRENT_TIMESTAMP)",
    id(),
    user.id,
    "Read already",
  );
  await flushPushQueue(async () => {
    assert.fail("Read notifications must not be pushed");
  });
  run("UPDATE sessions SET expires=0 WHERE token=?", token);
  await flushPushQueue(async () => {
    assert.fail("Expired sessions must not receive push");
  });
  assert.equal(
    one("SELECT id FROM push_subscriptions WHERE user_id=?", user.id),
    undefined,
  );
});

test("push opens exact row threads and drops deleted or mismatched destinations", async () => {
  const owner = account("thread-push-owner"),
    recipient = account("thread-push-reader");
  const wid = createWorkspace(owner.user.id, "Thread push");
  run("INSERT INTO members VALUES(?,?,?)", wid, recipient.user.id, "viewer");
  const boot = bootstrap(owner.user, wid);
  const page = command(owner.user, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Private title",
    kind: "database",
  }) as { id: string };
  const row = command(owner.user, {
    action: "row.create",
    pageId: page.id,
    cells: { title: "Secret entry" },
  }) as { id: string };
  const { rowDocumentData } = await import("../lib/row-documents");
  const { htmlState } = await import("../lib/document-server");
  const { withCommentDocument } = await import("../lib/inline-comments");
  const { commentAnchor } = await import("../lib/comment-positions");
  rowDocumentData(owner.user, page.id, row.id);
  const html = "<p>Review words</p>";
  run(
    "UPDATE row_documents SET html=?,state=? WHERE row_id=?",
    html,
    htmlState(html),
    row.id,
  );
  const tid = id();
  subscribePush(recipient.user, recipient.token, subscription());
  command(owner.user, {
    action: "thread.create",
    pageId: page.id,
    rowId: row.id,
    threadId: tid,
    messageId: id(),
    body: "Secret review",
    anchor: withCommentDocument(page.id, row.id, (b, g) =>
      commentAnchor(b, 1, 7, g),
    ),
  });
  const sent: string[] = [];
  await flushPushQueue(async (_s, payload) => {
    sent.push(payload);
  });
  assert.equal(sent.length, 1);
  assert.equal(
    JSON.parse(sent[0]).url,
    `/#page=${page.id}&row=${row.id}&thread=${tid}`,
  );
  assert.doesNotMatch(sent[0], /Secret|Private|Review words/);
  for (const [rid, thread] of [
    [id(), tid],
    [row.id, id()],
    [null, tid],
  ])
    run(
      "INSERT INTO notifications(id,user_id,body,page_id,row_id,thread_id) VALUES(?,?,?,?,?,?)",
      id(),
      recipient.user.id,
      "Stale",
      page.id,
      rid,
      thread,
    );
  await flushPushQueue(async () => {
    assert.fail("Missing or mismatched destinations must not be delivered");
  });
});
