// Idempotency keys (lib/idempotency.ts): a change is applied once per
// principal and key, retries get the stored answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-idempotency-"));
const { id, one, all, run } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { identityFromRequest, HttpError } = await import("../lib/auth");
const { createApiToken } = await import("../lib/api-tokens");
const { registerMobileDevice } = await import("../lib/mobile-devices");
const I = await import("../lib/idempotency");
const K = await import("../lib/idempotency-key");
const widgets = await import("../app/api/mobile/widgets/[action]/route");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function account(name: string) {
  const uid = id(),
    cookie = randomUUID();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", sha(cookie), uid, "[]", Date.now() + 3600_000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
  return { user, cookie, auth: { cookie: `flowplan_session=${cookie}` } as Record<string, string> };
}
const owner = account("idem-owner"),
  other = account("idem-other");
const wid = createWorkspace(owner.user.id, "Idempotency");
const sid = bootstrap(owner.user, wid).spaces[0].id;
run("INSERT INTO members VALUES(?,?,?)", wid, other.user.id, "editor");
const pageId = (command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Notes" }) as { id: string }).id;
const dbId = (command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, kind: "database", title: "Tasks" }) as { id: string }).id;
const comments = () => Number(one<{ n: number }>("SELECT COUNT(*) n FROM comments WHERE page_id=?", pageId)!.n);
const rowCount = () => Number(one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=?", dbId)!.n);

// /api/command as the catch-all route runs it: the key is reserved in the
// action's transaction (idempotencyHook), errors answer like route.ts error().
const commandRoute = I.withIdempotency(
  async (req: Request) => {
    try {
      const user = identityFromRequest(req);
      if (!user) throw new HttpError(401, "Bitte melde dich an.");
      const text = await req.text();
      return Response.json(command(user, JSON.parse(text), false, I.idempotencyHook()));
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: e instanceof HttpError ? e.status : 500 });
    }
  },
  { atomic: () => true },
);
const post = (body: unknown, headers: Record<string, string>, key?: string) =>
  commandRoute(
    new Request("http://localhost/api/command", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers, ...(key ? { "Idempotency-Key": key } : {}) },
      body: JSON.stringify(body),
    }),
  );

test("a repeat with the same key and body answers from the store: same status and body, applied once", async () => {
  const key = K.newIdempotencyKey();
  assert.ok(K.isIdempotencyKey(key));
  const before = comments();
  const body = { action: "comment.create", pageId, body: "Once" };
  const first = await post(body, owner.auth, key);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("Idempotent-Replayed"), null);
  const firstBody = await first.text();
  const second = await post(body, owner.auth, key);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("Idempotent-Replayed"), "true");
  assert.equal(await second.text(), firstBody);
  assert.equal(comments(), before + 1);
  // Without a key everything is as before: two requests, two comments.
  await post(body, owner.auth);
  await post(body, owner.auth);
  assert.equal(comments(), before + 3);
});

test("the same key with another body: 422, nothing applied", async () => {
  const key = randomUUID();
  const before = comments();
  assert.equal((await post({ action: "comment.create", pageId, body: "A" }, owner.auth, key)).status, 200);
  const other = await post({ action: "comment.create", pageId, body: "B" }, owner.auth, key);
  assert.equal(other.status, 422);
  assert.equal(((await other.json()) as { code: string }).code, "idempotency_key_reused");
  assert.equal(comments(), before + 1);
});

test("invalid keys are refused before anything happens", async () => {
  const before = comments();
  for (const key of ["short", "x".repeat(129), "has space!", "ümlaut-key"]) {
    const response = await post({ action: "comment.create", pageId, body: "Nope" }, owner.auth, key);
    assert.equal(response.status, 400, key);
    assert.equal(((await response.json()) as { code: string }).code, "idempotency_key_invalid");
  }
  assert.equal(comments(), before);
});

test("concurrent duplicates: one is applied, both get the same answer", async () => {
  const key = randomUUID();
  const before = comments();
  const body = { action: "comment.create", pageId, body: "Double click" };
  const answers = await Promise.all([post(body, owner.auth, key), post(body, owner.auth, key), post(body, owner.auth, key)]);
  assert.deepEqual(answers.map((a) => a.status), [200, 200, 200]);
  const texts = await Promise.all(answers.map((a) => a.text()));
  assert.equal(new Set(texts).size, 1);
  assert.equal(answers.filter((a) => a.headers.get("Idempotent-Replayed") === "true").length, 2);
  assert.equal(comments(), before + 1);
});

test("a handler still running: 409 with Retry-After, then the stored answer", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let applied = 0;
  const slow = I.withIdempotency(async (req: Request) => {
    await req.text();
    await gate;
    applied++;
    return Response.json({ id: "upload-1", applied });
  });
  const request = () =>
    new Request("http://localhost/api/upload", { method: "POST", headers: { ...owner.auth, "Idempotency-Key": "upload-key-1" }, body: "file" });
  const first = slow(request());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const busy = await slow(request());
  assert.equal(busy.status, 409);
  assert.equal(busy.headers.get("Retry-After"), "2");
  assert.equal(((await busy.json()) as { code: string }).code, "idempotency_in_progress");
  release();
  assert.equal((await first).status, 200);
  const again = await slow(request());
  assert.equal(again.headers.get("Idempotent-Replayed"), "true");
  assert.deepEqual(await again.json(), { id: "upload-1", applied: 1 });
  assert.equal(applied, 1);
});

test("a failed action keeps no key: the retry is applied", async () => {
  const key = randomUUID();
  const before = rowCount();
  const body = { action: "row.create", pageId: dbId, cells: {} };
  run("UPDATE pages SET locked=1 WHERE id=?", dbId);
  const locked = await post(body, owner.auth, key);
  assert.equal(locked.status, 409);
  assert.equal(one("SELECT 1 x FROM idempotency_keys WHERE key=?", key), undefined);
  run("UPDATE pages SET locked=0 WHERE id=?", dbId);
  assert.equal((await post(body, owner.auth, key)).status, 200);
  assert.equal(rowCount(), before + 1);
  // The same for handlers outside a transaction: a thrown error releases.
  let calls = 0;
  const flaky = I.withIdempotency(async () => {
    if (!calls++) throw new Error("disk full");
    return Response.json({ ok: true });
  });
  const request = () => new Request("http://localhost/api/upload", { method: "POST", headers: { ...owner.auth, "Idempotency-Key": "flaky-key-1" }, body: "x" });
  await assert.rejects(flaky(request()));
  assert.equal((await flaky(request())).status, 200);
  assert.equal(calls, 2);
});

test("keys expire after 24 hours and are swept", async () => {
  const key = randomUUID();
  const before = comments();
  const body = { action: "comment.create", pageId, body: "Expiring" };
  await post(body, owner.auth, key);
  run("UPDATE idempotency_keys SET created_at=? WHERE key=?", Date.now() - I.IDEMPOTENCY_TTL - 1000, key);
  // Expired: the request counts as new.
  const again = await post(body, owner.auth, key);
  assert.equal(again.headers.get("Idempotent-Replayed"), null);
  assert.equal(comments(), before + 2);
  run("UPDATE idempotency_keys SET created_at=? WHERE key=?", Date.now() - I.IDEMPOTENCY_TTL - 1000, key);
  const fresh = randomUUID();
  await post(body, owner.auth, fresh);
  assert.ok(I.sweepIdempotencyKeys() >= 1);
  assert.equal(one("SELECT 1 x FROM idempotency_keys WHERE key=?", key), undefined);
  assert.ok(one("SELECT 1 x FROM idempotency_keys WHERE key=?", fresh));
});

test("keys belong to their principal: people, API tokens and devices never share them", async () => {
  const key = randomUUID();
  const before = comments();
  const body = { action: "comment.create", pageId, body: "Mine" };
  await post(body, owner.auth, key);
  // Another person with the same key and body: their own comment.
  const theirs = await post(body, other.auth, key);
  assert.equal(theirs.headers.get("Idempotent-Replayed"), null);
  // The same person with an API token, or a second token: separate scopes.
  const token = createApiToken(owner.user, { name: "script", scope: "write" }).token;
  const token2 = createApiToken(owner.user, { name: "script 2", scope: "write" }).token;
  const viaToken = await post(body, { authorization: `Bearer ${token}` }, key);
  assert.equal(viaToken.status, 200);
  assert.equal(viaToken.headers.get("Idempotent-Replayed"), null);
  assert.equal((await post(body, { authorization: `Bearer ${token}` }, key)).headers.get("Idempotent-Replayed"), "true");
  assert.equal((await post(body, { authorization: `Bearer ${token2}` }, key)).headers.get("Idempotent-Replayed"), null);
  assert.equal(comments(), before + 4);
  const scopes = all<{ scope: string; user_id: string }>("SELECT scope,user_id FROM idempotency_keys WHERE key=? ORDER BY scope", key);
  assert.equal(scopes.length, 4);
  assert.ok(scopes.every((s) => /^[tu]:/.test(s.scope)));
  assert.ok(scopes.filter((s) => s.scope.startsWith("t:")).every((s) => s.user_id === owner.user.id));
  // Nobody signed in: no key is reserved, the handler refuses.
  const anonymous = await post(body, {}, randomUUID());
  assert.equal(anonymous.status, 401);
  assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM idempotency_keys WHERE key=?", key)!.n), 4);
});

test("secrets are never replayed: a new API token is applied once, a repeat gets 409", async () => {
  const key = randomUUID();
  const count = () => Number(one<{ n: number }>("SELECT COUNT(*) n FROM api_tokens WHERE user_id=?", owner.user.id)!.n);
  const before = count();
  const body = { action: "token.create", name: "ci", scope: "read" };
  const first = await post(body, owner.auth, key);
  assert.equal(first.status, 200);
  assert.match(((await first.json()) as { token: string }).token, /^fp_/);
  const stored = one<{ response: string | null; stored: string }>("SELECT response,stored FROM idempotency_keys WHERE key=?", key)!;
  assert.equal(stored.response, null);
  assert.equal(stored.stored, "secret");
  const second = await post(body, owner.auth, key);
  assert.equal(second.status, 409);
  const answer = (await second.json()) as { code: string; token?: string };
  assert.equal(answer.code, "idempotency_already_applied");
  assert.equal(answer.token, undefined);
  assert.equal(count(), before + 1);
  // Detected by the answer as well, for handlers outside command().
  assert.equal(I.containsSecret({ id: "x", webhook: { secret: "s" } }), true);
  assert.equal(I.containsSecret({ id: "x", url: "/api/files/1" }), false);
});

test("answers beyond 64 KB keep only their status", async () => {
  const big = I.withIdempotency(async () => Response.json({ text: "x".repeat(I.MAX_STORED_RESPONSE) }));
  const request = () => new Request("http://localhost/api/import/zip", { method: "POST", headers: { ...owner.auth, "Idempotency-Key": "big-answer-1" }, body: "zip" });
  assert.equal((await big(request())).status, 200);
  const again = await big(request());
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as { code: string }).code, "idempotency_already_applied");
});

test("multipart bodies: a retry with a new boundary is the same request", async () => {
  let applied = 0;
  const upload = I.withIdempotency(async (req: Request) => {
    const form = await req.formData();
    applied++;
    return Response.json({ name: (form.get("file") as File).name });
  });
  const request = (content: string) => {
    const form = new FormData();
    form.set("pageId", pageId);
    form.set("file", new File([content], "a.txt", { type: "text/plain" }));
    return new Request("http://localhost/api/upload", { method: "POST", headers: { ...owner.auth, "Idempotency-Key": "multipart-1" }, body: form });
  };
  assert.equal((await upload(request("hello"))).status, 200);
  const retry = await upload(request("hello"));
  assert.equal(retry.headers.get("Idempotent-Replayed"), "true");
  assert.equal((await upload(request("other content"))).status, 422);
  assert.equal(applied, 1);
});

test("CRDT syncs go without a key; the server ignores one", async () => {
  const generation = String(one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pageId)!.generation);
  const key = randomUUID();
  const update = Buffer.from(htmlState("<p>Synced</p>")).toString("base64");
  const body = { action: "document.sync", workspaceId: wid, pageId, generation, update };
  assert.equal((await post(body, owner.auth, key)).status, 200);
  assert.equal(one("SELECT 1 x FROM idempotency_keys WHERE key=?", key), undefined);
  assert.equal(K.idempotencyKeyOf(body, true), undefined);
  const comment = { action: "comment.create", pageId, body: "x" };
  assert.equal(K.idempotencyKeyOf(comment, true), K.idempotencyKeyOf(comment));
  const draft = K.draftKey("comment:p", "hello");
  assert.equal(K.draftKey("comment:p", "hello"), draft);
  K.draftSent("comment:p");
  assert.notEqual(K.draftKey("comment:p", "hello"), draft);
});

test("offline queue replay: the queued change goes with the key of the failed attempt – one record", async () => {
  // The online attempt reached the server, the answer was lost (the
  // connection dropped): the change went into the queue with its key.
  const rowId = randomUUID();
  const body = { action: "row.create", pageId: dbId, rowId, cells: {}, templateId: null };
  const key = K.idempotencyKeyOf(body, true)!;
  const before = rowCount();
  assert.equal((await post(body, owner.auth, key)).status, 200);
  // components/offline-queue.tsx flush(): the same request, the same key –
  // twice, as after a second reconnect before the queue was saved.
  for (let i = 0; i < 2; i++) {
    const replay = await post({ action: "row.create", pageId: dbId, rowId, cells: {}, templateId: null }, owner.auth, key);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("Idempotent-Replayed"), "true");
  }
  assert.equal(rowCount(), before + 1);
  assert.ok(database(dbId));
  // A comment queued the same way.
  const commentKey = randomUUID();
  const start = comments();
  for (let i = 0; i < 3; i++) await post({ action: "comment.create", pageId, body: "Queued" }, owner.auth, commentKey);
  assert.equal(comments(), start + 1);
});

test("widget actions through the route: one record per tap, the device's own scope", async () => {
  const { deviceToken } = registerMobileDevice(owner.user, sha(owner.cookie), { installationId: randomUUID(), platform: "ios" });
  const ctx = { params: Promise.resolve({ action: "action" }) };
  const tap = (key: string, title = "Call Anna") =>
    widgets.POST(
      new Request("http://localhost/api/mobile/widgets/action?lang=en", {
        method: "POST",
        headers: { authorization: `Bearer ${deviceToken}`, "Idempotency-Key": key },
        body: JSON.stringify({ action: "capture.note", targetId: dbId, title }),
      }),
      ctx,
    );
  const before = rowCount();
  const key = randomUUID();
  const first = await tap(key);
  assert.equal(first.status, 200, await first.clone().text());
  const retry = await tap(key);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get("Idempotent-Replayed"), "true");
  assert.deepEqual(await retry.json(), await first.json());
  assert.equal(rowCount(), before + 1);
  assert.equal((await tap(key, "Other title")).status, 422);
  assert.ok(one<{ scope: string }>("SELECT scope FROM idempotency_keys WHERE key=?", key)!.scope.startsWith("d:"));
  // The data refresh only reads: no key is kept.
  const dataKey = randomUUID();
  await widgets.POST(
    new Request("http://localhost/api/mobile/widgets/data", {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "Idempotency-Key": dataKey },
      body: JSON.stringify({ today: "2026-01-01", zone: "UTC", widgets: [] }),
    }),
    { params: Promise.resolve({ action: "data" }) },
  );
  assert.equal(one("SELECT 1 x FROM idempotency_keys WHERE key=?", dataKey), undefined);
});

test("deleting an account removes its keys", () => {
  const gone = account("idem-gone");
  run(
    "INSERT INTO idempotency_keys(scope,key,user_id,request_hash,status,stored,created_at) VALUES(?,?,?,?,'done','body',?)",
    `u:${gone.user.id}`,
    "gone-key-1",
    gone.user.id,
    "h",
    Date.now(),
  );
  run("DELETE FROM users WHERE id=?", gone.user.id);
  assert.equal(one("SELECT 1 x FROM idempotency_keys WHERE key='gone-key-1'"), undefined);
});

test("OpenAPI: every operation that takes the key documents the header, 409/422 and the replay header", async () => {
  const { openApiDocument, idempotentOperations } = await import("../lib/openapi");
  const doc = openApiDocument() as { paths: Record<string, Record<string, Record<string, any>>> };
  const found = new Set<string>();
  for (const item of Object.values(doc.paths))
    for (const op of Object.values(item)) {
      if (!idempotentOperations.has(op.operationId)) {
        assert.ok(!op["x-idempotent"], op.operationId);
        continue;
      }
      found.add(op.operationId);
      assert.equal(op["x-idempotent"], true);
      assert.ok(op.parameters.some((p: { name: string; in: string }) => p.name === "Idempotency-Key" && p.in === "header"), op.operationId);
      assert.ok(op.responses["409"] && op.responses["422"], op.operationId);
      const ok = Object.entries(op.responses).find(([status]) => status.startsWith("2"))![1] as { headers?: Record<string, unknown> };
      assert.ok(ok.headers?.["Idempotent-Replayed"], op.operationId);
    }
  assert.deepEqual([...found].sort(), [...idempotentOperations].sort());
});

test("space.reorder with a key: a retry answers from the store, the order is applied once", async () => {
  const second = (command(owner.user, { action: "space.create", workspaceId: wid, name: "Second" }) as { id: string }).id;
  const order = [second, sid];
  const key = K.newIdempotencyKey();
  const first = await post({ action: "space.reorder", workspaceId: wid, order }, owner.auth, key);
  assert.equal(first.status, 200);
  const answer = await first.text();
  assert.deepEqual(JSON.parse(answer).order, order);
  const positions = () => all<{ id: string; position: number }>("SELECT id,position FROM spaces WHERE workspace_id=? ORDER BY id", wid);
  const before = positions();
  const retry = await post({ action: "space.reorder", workspaceId: wid, order }, owner.auth, key);
  assert.equal(retry.headers.get("Idempotent-Replayed"), "true");
  assert.equal(await retry.text(), answer);
  assert.deepEqual(positions(), before);
  // Another order with the same key is refused.
  assert.equal((await post({ action: "space.reorder", workspaceId: wid, order: [sid, second] }, owner.auth, key)).status, 422);
  // Editors may not reorder.
  assert.equal((await post({ action: "space.reorder", workspaceId: wid, order: [sid, second] }, other.auth)).status, 403);
});
