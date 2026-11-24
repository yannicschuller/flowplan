// Bodies of requests that need no sign-in are read with a limit
// (lib/request-body.ts): a large streamed body is refused with 413 after
// reading little more than the limit, also without Content-Length.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-request-body-"));
process.env.APP_URL = "https://flowplan.example.test";
const { readBodyLimited, readJsonLimited } = await import("../lib/request-body");
const tickets = await import("../app/api/tickets/[token]/handler");
const auth = await import("../app/api/auth/[action]/handler");

const CHUNK = 16 * 1024;
// A 2 MB body in 16 KB chunks; `sent` counts what the server pulled.
function streamed(url: string, { length = true, mb = 2 } = {}) {
  const counter = { sent: 0 };
  const chunk = new Uint8Array(CHUNK).fill(0x61);
  const total = mb * 1024 * 1024;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (counter.sent >= total) return c.close();
      counter.sent += CHUNK;
      c.enqueue(chunk);
    },
  });
  const headers: Record<string, string> = { origin: "https://flowplan.example.test", "content-type": "application/json" };
  if (length) headers["content-length"] = String(total);
  const req = new Request(url, { method: "POST", body, duplex: "half", headers } as RequestInit);
  return { req, counter };
}

test("readBodyLimited refuses a declared size above the limit without reading", async () => {
  const { req, counter } = streamed("https://flowplan.example.test/x");
  await assert.rejects(readBodyLimited(req, 64 * 1024), (e: { status?: number }) => e.status === 413);
  assert.ok(counter.sent <= 2 * CHUNK, `read ${counter.sent} bytes`);
});

test("readBodyLimited stops a chunked body at the limit", async () => {
  const { req, counter } = streamed("https://flowplan.example.test/x", { length: false });
  await assert.rejects(readBodyLimited(req, 64 * 1024), (e: { status?: number }) => e.status === 413);
  assert.ok(counter.sent <= 64 * 1024 + 3 * CHUNK, `read ${counter.sent} bytes`);
});

test("readJsonLimited reads a small body and treats an empty one as {}", async () => {
  const req = new Request("https://flowplan.example.test/x", { method: "POST", body: JSON.stringify({ a: 1 }) });
  assert.deepEqual(await readJsonLimited(req, 100), { a: 1 });
  assert.deepEqual(await readJsonLimited(new Request("https://flowplan.example.test/x", { method: "POST" }), 100), {});
  await assert.rejects(readJsonLimited(new Request("https://flowplan.example.test/x", { method: "POST", body: "{" }), 100), SyntaxError);
});

test("a ticket reply to an unknown link is refused before the body is read", async () => {
  const { req, counter } = streamed("https://flowplan.example.test/api/tickets/nope");
  const res = await tickets.POST(req, { params: Promise.resolve({ token: "nope" }) });
  assert.equal(res.status, 404);
  assert.ok(counter.sent <= 2 * CHUNK, `read ${counter.sent} bytes`);
});

test("a well-formed but unknown ticket link is refused before reading a chunked body", async () => {
  const { req, counter } = streamed("https://flowplan.example.test/api/tickets/x", { length: false });
  const res = await tickets.POST(req, { params: Promise.resolve({ token: "a".repeat(32) }) });
  assert.equal(res.status, 404);
  assert.ok(counter.sent <= 2 * CHUNK, `read ${counter.sent} bytes`);
});

// The other sign-in actions need the request scope of Next (cookies,
// headers) to run; their shared body reader is checked in the source.
test("the sign-in route reads every JSON body with a limit", () => {
  const route = readFileSync(join(import.meta.dirname, "../app/api/auth/[action]/handler.ts"), "utf8");
  assert.match(route, /const body = \(\) =>\s*readJsonLimited\(req, 64_000\)/);
  assert.doesNotMatch(route.slice(route.indexOf("const body = ")), /req\.json\(\)/);
  for (const file of ["../app/api/tickets/[token]/handler.ts", "../app/api/forms/[token]/handler.ts", "../app/api/ai/[...path]/handler.ts"])
    assert.doesNotMatch(readFileSync(join(import.meta.dirname, file), "utf8"), /req\.(text|json)\(\)/, file);
});

test("the app's sign-in report stops reading a large body", async () => {
  const { req, counter } = streamed("https://flowplan.example.test/api/auth/app-sign-in-report", { length: false });
  const res = await auth.POST(req, { params: Promise.resolve({ action: "app-sign-in-report" }) });
  assert.equal(res.status, 204);
  assert.ok(counter.sent <= 16 * 1024 + 3 * CHUNK, `read ${counter.sent} bytes`);
});

// #485: handlers that checked only Content-Length and then read the whole
// body. A chunked body (no Content-Length) now stops near the route's cap,
// before any token or signature is looked at.
const R = "../app/api";
const git = await import(`${R}/git/[token]/handler`);
const slack = await import(`${R}/webhooks/slack/[id]/handler`);
const issueHook = await import(`${R}/issue-sync/hook/[token]/handler`);
const share = await import(`${R}/share/[token]/handler`);
const shareBoard = await import(`${R}/share/[token]/board/handler`);
const shareNotebook = await import(`${R}/share/[token]/notebook/handler`);
const shareUnlock = await import(`${R}/share/[token]/unlock/handler`);
const scim = await import(`${R}/scim/v2/[...path]/handler`);
const general = await import(`${R}/[...path]/handler`);
const clipper = await import(`${R}/clipper/[action]/handler`);
const { limitedRequest } = await import("../lib/request-body");
const P = (o: object) => ({ params: Promise.resolve(o) });

// [name, path, content type, cap in MB the body may reach at most, call]
const chunkedCases: [string, string, string, number, (r: Request) => Promise<Response>][] = [
  ["git webhook", "/api/git/zz", "application/json", 5, (r) => git.POST(r, P({ token: "zz" }))],
  ["Slack events", "/api/webhooks/slack/zz", "application/json", 1, (r) => slack.POST(r, P({ id: "zz" }))],
  ["issue webhook", "/api/issue-sync/hook/zz", "application/json", 5, (r) => issueHook.POST(r, P({ token: "zz" }))],
  ["share", "/api/share/zz", "application/json", 2.1, (r) => share.POST(r, P({ token: "zz" }))],
  ["share board", "/api/share/zz/board", "application/json", 5.7, (r) => shareBoard.POST(r, P({ token: "zz" }))],
  ["share notebook", "/api/share/zz/notebook", "application/json", 12, (r) => shareNotebook.POST(r, P({ token: "zz" }))],
  ["share unlock", "/api/share/zz/unlock", "application/json", 0.01, (r) => shareUnlock.POST(r, P({ token: "zz" }))],
  ["SCIM", "/api/scim/v2/Users", "application/scim+json", 1.05, (r) => scim.POST(r, P({ path: ["Users"] }))],
  ["emergency deny", "/api/emergency/deny", "application/x-www-form-urlencoded", 0.02, (r) => general.POST(r, P({ path: ["emergency", "deny"] }))],
  ["dead man's here", "/api/deadman/here", "application/x-www-form-urlencoded", 0.02, (r) => general.POST(r, P({ path: ["deadman", "here"] }))],
];
for (const [name, path, type, capMb, call] of chunkedCases)
  test(`${name}: a chunked body stops at the route's limit`, async () => {
    const { req, counter } = streamed(`https://flowplan.example.test${path}`, { length: false, mb: 24 });
    req.headers.set("content-type", type);
    const res = await call(req);
    assert.equal(res.status, 413, `${name} answered ${res.status}`);
    assert.ok(counter.sent <= capMb * 1024 * 1024 + 4 * CHUNK, `${name} read ${counter.sent} bytes`);
  });

// Its other routes need the request scope of Next (requireUser); every
// body other than a multipart upload is limited before any of them runs.
test("the general handler limits every other body while it is read", () => {
  const source = readFileSync(join(import.meta.dirname, "../app/api/[...path]/handler.ts"), "utf8");
  assert.match(source, /else if \(maxBody < Number\.MAX_SAFE_INTEGER\) req = limitedRequest\(req, maxBody\);/);
});

test("limitedRequest keeps a small body readable and stops a large chunked one", async () => {
  const small = limitedRequest(new Request("https://flowplan.example.test/x", { method: "POST", body: "a=1&token=t", headers: { "content-type": "application/x-www-form-urlencoded" } }), 100);
  assert.equal((await small.formData()).get("token"), "t");
  assert.equal(limitedRequest(new Request("https://flowplan.example.test/x"), 1).body, null);
  const { req, counter } = streamed("https://flowplan.example.test/x", { length: false });
  await assert.rejects(limitedRequest(req, 64 * 1024).text(), (e: { status?: number }) => e.status === 413);
  assert.ok(counter.sent <= 64 * 1024 + 4 * CHUNK, `read ${counter.sent} bytes`);
  const declared = streamed("https://flowplan.example.test/x");
  assert.throws(() => limitedRequest(declared.req, 64 * 1024), (e: { status?: number }) => e.status === 413);
});

test("the clipper's save stops a chunked body at its limit", async () => {
  const { run, id } = await import("../lib/db");
  const { createApiToken } = await import("../lib/api-tokens");
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "clip", "clip@example.test");
  const user = { id: uid, name: "clip", email: "clip@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" };
  const token = (await createApiToken(user as never, { name: "Browser", scope: "clipper" })).token;
  const { req, counter } = streamed("https://flowplan.example.test/api/clipper/save", { length: false, mb: 24 });
  req.headers.set("authorization", `Bearer ${token}`);
  const res = await clipper.POST(req, P({ action: "save" }));
  assert.equal(res.status, 413);
  assert.ok(counter.sent <= 3_000_000 + 4 * CHUNK, `read ${counter.sent} bytes`);
});

// Every handler reads its body through lib/request-body.ts or a stream
// with its own count – never the whole body first.
test("no API handler reads a whole body without a limit", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === "handler.ts") files.push(join(dir, entry.name));
  };
  walk(join(import.meta.dirname, "../app/api"));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /req\.text\(\)/, file);
    assert.doesNotMatch(source, /content-length"\) \|\| 0\) > [^\n]*\n[^\n]*req\.(text|json|formData|arrayBuffer)\(\)/, file);
  }
});
