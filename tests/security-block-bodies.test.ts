// #484: proxy.ts leaves requests with a body out (its matcher), so the
// address block of Administration → Sicherheit also applies in the API's
// catch-all dispatcher and to the cookie-only sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-block-bodies-"));
process.env.FLOWPLAN_TRUSTED_PROXIES = "1";
process.env.APP_URL = "https://flowplan.example.test";
const { run, id } = await import("../lib/db");
const events = await import("../lib/security-events");
const { sessionIdentityFromRequest } = await import("../lib/auth");
const route = await import("../app/api/[...path]/route");

const BLOCKED = "203.0.113.7";
const FREE = "198.51.100.20";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Blocked", "blocked@example.test");
const session = randomUUID();
await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", sha(session), uid, "[]", Date.now() + 3600_000);
await run(
  "INSERT INTO security_blocks(id,kind,value,label,reason,created_by,created_at,until) VALUES(?,?,?,?,?,?,?,NULL)",
  id(), "network", events.networkOf(BLOCKED), "test", "test", uid, Date.now(),
);
events.invalidateSecurityBlocks();

const post = (path: string, address: string, extra: Record<string, string> = {}) => {
  const body = JSON.stringify({ password: "guess" });
  return new Request(`https://flowplan.example.test/api/${path}`, {
    method: "POST",
    headers: {
      "x-forwarded-for": address,
      origin: "https://flowplan.example.test",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      ...extra,
    },
    body,
  });
};
const ctx = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });

test("a blocked address gets 403 from the dispatcher for a request with a body", async () => {
  for (const path of ["share/zz/unlock", "whiteboards/00000000-0000-4000-8000-000000000000/comments", "command"]) {
    const res = await route.POST(post(path, BLOCKED) as never, ctx(path));
    assert.equal(res.status, 403, path);
    assert.equal(await res.text(), "Forbidden");
  }
  // Chunked, without Content-Length.
  const chunked = new Request("https://flowplan.example.test/api/git/zz", {
    method: "POST",
    headers: { "x-forwarded-for": BLOCKED },
    body: new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array(10)), c.close()) }),
    duplex: "half",
  } as RequestInit);
  assert.equal((await route.POST(chunked as never, ctx("git/zz"))).status, 403);
});

test("other addresses still reach the handler", async () => {
  const res = await route.POST(post("share/zz/unlock", FREE) as never, ctx("share/zz/unlock"));
  assert.notEqual(res.status, 403);
});

test("the cookie-only sign-in counts a blocked address as signed out", async () => {
  const cookie = { cookie: `flowplan_session=${encodeURIComponent(session)}` };
  const free = await sessionIdentityFromRequest(post("x", FREE, cookie));
  assert.equal(free?.id, uid);
  assert.equal(await sessionIdentityFromRequest(post("x", BLOCKED, cookie)), null);
});
