import { nowText } from "../lib/db-driver/dialect";
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
} = await import("../lib/push");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
async function account(name: string) {
  const uid = id(),
    token = id();
  await run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.test`,
  );
  await run(
    "INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)",
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
test("push registration binds a valid device to an authenticated session and rejects SSRF destinations", async () => {
  const { user, token } = await account("push-owner");
  const sub = subscription();
  await assert.rejects(async () => await subscribePush(user, "missing-session", sub), /Sitzung/);
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
  await subscribePush(user, token, sub);
  assert.equal(
    (await one<{ user_id: string }>(
      "SELECT user_id FROM push_subscriptions WHERE endpoint=?",
      sub.endpoint,
    ))!.user_id,
    user.id,
  );
  await unsubscribePush((await account("other-user")).user, sub.endpoint);
  assert.ok(
    await one("SELECT id FROM push_subscriptions WHERE endpoint=?", sub.endpoint),
  );
  await run("DELETE FROM sessions WHERE token=?", token);
  assert.equal(
    await one("SELECT id FROM push_subscriptions WHERE endpoint=?", sub.endpoint),
    undefined,
  );
  assert.equal(pushKeys().publicKey, pushKeys().publicKey);
});
test("comments enqueue encrypted web push once, omit private content and recheck page permission before sending", async () => {
  const owner = await account("author"),
    recipient = await account("recipient");
  const wid = await createWorkspace(owner.user.id, "Push workspace");
  await run("INSERT INTO members VALUES(?,?,?)", wid, recipient.user.id, "editor");
  const page = (await bootstrap(owner.user, wid)).pages[0];
  const sub = subscription();
  await subscribePush(recipient.user, recipient.token, sub);
  // Comments reach the page's followers (lib/comment-recipients.ts).
  await command(recipient.user, { action: "page.follow", pageId: page.id, follow: true });
  await command(owner.user, {
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
  await command(owner.user, {
    action: "comment.create",
    pageId: page.id,
    body: "Second comment",
  });
  await run(
    "DELETE FROM members WHERE workspace_id=? AND user_id=?",
    wid,
    recipient.user.id,
  );
  await flushPushQueue(async () => {
    assert.fail("Revoked access must not receive push");
  });
  await unsubscribePush(recipient.user, sub.endpoint);
});
test("push retries transient failures, removes expired devices and suppresses read notifications", async () => {
  const { user, token } = await account("retry-user"),
    sub = subscription();
  await subscribePush(user, token, sub);
  await run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", id(), user.id, "Retry me");
  await flushPushQueue(async () => {
    throw { statusCode: 503 };
  });
  const job = (await one<{ id: number; attempts: number; available_at: number }>(
    "SELECT d.* FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id WHERE s.endpoint=?",
    sub.endpoint,
  ))!;
  assert.equal(job.attempts, 1);
  assert.ok(job.available_at > Date.now());
  await run("UPDATE push_deliveries SET available_at=0 WHERE id=?", job.id);
  await flushPushQueue(async () => {
    throw { statusCode: 410 };
  });
  assert.equal(
    await one("SELECT id FROM push_subscriptions WHERE endpoint=?", sub.endpoint),
    undefined,
  );
  await subscribePush(user, token, subscription());
  await run(
    "INSERT INTO notifications(id,user_id,body,read_at) VALUES(?,?,?,?)",
    id(),
    user.id,
    "Read already", nowText(),
  );
  await flushPushQueue(async () => {
    assert.fail("Read notifications must not be pushed");
  });
  await run("UPDATE sessions SET expires=0 WHERE token=?", token);
  await flushPushQueue(async () => {
    assert.fail("Expired sessions must not receive push");
  });
  assert.equal(
    await one("SELECT id FROM push_subscriptions WHERE user_id=?", user.id),
    undefined,
  );
});

test("push opens exact row threads and drops deleted or mismatched destinations", async () => {
  const owner = await account("thread-push-owner"),
    recipient = await account("thread-push-reader");
  const wid = await createWorkspace(owner.user.id, "Thread push");
  await run("INSERT INTO members VALUES(?,?,?)", wid, recipient.user.id, "viewer");
  const boot = await bootstrap(owner.user, wid);
  const page = (await command(owner.user, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Private title",
    kind: "database",
  })) as { id: string };
  const row = (await command(owner.user, {
    action: "row.create",
    pageId: page.id,
    cells: { title: "Secret entry" },
  })) as { id: string };
  await command(recipient.user, { action: "page.follow", pageId: page.id, follow: true });
  const { rowDocumentData } = await import("../lib/row-documents");
  const { htmlState } = await import("../lib/document-server");
  const { withCommentDocument } = await import("../lib/inline-comments");
  const { commentAnchor } = await import("../lib/comment-positions");
  await rowDocumentData(owner.user, page.id, row.id);
  const html = "<p>Review words</p>";
  await run(
    "UPDATE row_documents SET html=?,state=? WHERE row_id=?",
    html,
    htmlState(html),
    row.id,
  );
  const tid = id();
  await subscribePush(recipient.user, recipient.token, subscription());
  await command(owner.user, {
    action: "thread.create",
    pageId: page.id,
    rowId: row.id,
    threadId: tid,
    messageId: id(),
    body: "Secret review",
    anchor: await withCommentDocument(page.id, row.id, (b, g) =>
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
    await run(
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
