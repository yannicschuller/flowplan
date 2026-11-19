// Error details of the monitoring (lib/error-details.ts, lib/request-context.ts,
// lib/request-metrics.ts, app/api/admin/monitoring): what a 5xx keeps, how
// it is grouped, kept and shown – and what it never keeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-errors-"));
const { run, one, all } = await import("../lib/db");
const details = await import("../lib/error-details");
const context = await import("../lib/request-context");
const { startRequestMetrics } = await import("../lib/request-metrics");
const { noteWorkerRun } = await import("../lib/ops-events");
const { classifyError, describeError } = await import("../lib/error-kinds");

const HOUR = 3_600_000,
  DAY = 86_400_000;
const t = (de: string) => de;
const rows = () => all<{ fingerprint: string; route: string; action: string; name: string; message: string; status: number; count: number; frames: string; occurrences: string; slots: string; db_code: string }>("SELECT * FROM error_groups ORDER BY last_seen");

// A small server like Next.js's: the request metrics follow it through the
// diagnostics channels, the handler answers like a route handler's catch.
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  startRequestMetrics();
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}
async function failingLookup(): Promise<never> {
  await new Promise((r) => setTimeout(r, 1));
  throw new TypeError("Cannot read properties of undefined (reading 'title') for anna@example.com, Authorization: Bearer abcdefgh12345678");
}
const settle = async () => {
  await new Promise((r) => setTimeout(r, 30));
  await details.flushErrorDetails();
};

test("scrubbing: no keys, tokens, passwords, e-mail or IP addresses, at most 500 characters", () => {
  const raw = [
    "login of anna.berg@example.org failed",
    "Authorization: Bearer abcdefghijklmnop",
    "password=hunter2 secret: 's3cr3t'",
    "postgres://flowplan:geheim@db.internal:5432/flowplan",
    "token fp_abcdefghijklmnopqrstuv",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "from 203.0.113.7 and 2001:db8:85a3::8a2e:370:7334",
    "user 550e8400-e29b-41d4-a716-446655440000",
    "key a3f9c2d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b2",
  ].join(" | ");
  const out = details.scrubMessage(raw);
  for (const leak of ["anna.berg@example.org", "abcdefghijklmnop", "hunter2", "s3cr3t", "geheim", "fp_abcdefghijklmnopqrstuv", "eyJhbGciOiJIUzI1NiJ9", "203.0.113.7", "550e8400-e29b", "a3f9c2d8e7b6a5f4"])
    assert.ok(!out.includes(leak), `${leak} in ${out}`);
  assert.match(out, /login of \[e-mail\] failed/);
  assert.match(out, /postgres:\/\/\[…\]@/);
  assert.equal(details.scrubMessage("x".repeat(2000)).length, 500);
  assert.equal(details.scrubMessage(undefined), "");
});

test("a throwing route handler: captured with route pattern, name, scrubbed message and frames; request id in header and body", async () => {
  await details.clearErrorDetails();
  const server = await serve(async (req, res) => {
    // What the handler read must never be kept: the body.
    for await (const _ of req);
    try {
      await failingLookup();
    } catch (e) {
      res.statusCode = context.serverError(e);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Die Anfrage konnte nicht verarbeitet werden.", requestId: context.currentRequestId() }));
    }
  });
  try {
    const r = await fetch(`${server.origin}/api/pages/5f1c3a1e-0000-4000-8000-000000000001/blocks?token=querySecret123`, { method: "POST", body: "BODYSECRET anna@example.com" });
    assert.equal(r.status, 500);
    const id = r.headers.get("x-request-id");
    assert.match(id || "", /^[A-Za-z0-9]{12}$/);
    assert.equal((await r.json()).requestId, id);
    await settle();
    const [g] = await rows();
    assert.equal(g.route, "POST /api/pages/:id/blocks");
    assert.equal(g.name, "TypeError");
    assert.match(g.message, /^Cannot read properties of undefined \(reading 'title'\) for \[e-mail\], Authorization: \[…\]$/);
    assert.equal(g.status, 500);
    assert.equal(g.count, 1);
    const frames = JSON.parse(g.frames) as { fn: string; file: string; line: number }[];
    assert.equal(frames[0].fn, "failingLookup");
    assert.equal(frames[0].file, "tests/error-details.test.ts");
    assert.ok(frames.length <= 5 && frames.every((f) => !f.file.includes("node_modules") && !f.file.startsWith("node:")));
    const [o] = JSON.parse(g.occurrences);
    assert.equal(o.requestId, id);
    assert.equal(o.status, 500);
    assert.equal(o.method, "POST");
    assert.equal(o.role, "anonymous");
    // Nothing of the request beyond its pattern: no body, query, address, id.
    const stored = JSON.stringify(await rows());
    for (const leak of ["BODYSECRET", "querySecret123", "127.0.0.1", "5f1c3a1e", "anna@example.com"]) assert.ok(!stored.includes(leak), leak);
  } finally {
    server.close();
  }
});

test("an error Next.js caught (onRequestError) and a 5xx without an exception", async () => {
  await details.clearErrorDetails();
  const { onRequestError } = await import("../instrumentation");
  const before = process.env.NEXT_RUNTIME;
  process.env.NEXT_RUNTIME = "nodejs";
  const server = await serve(async (req, res) => {
    if (req.url?.startsWith("/api/thrown")) {
      // Next.js reports the error, then answers 500 itself.
      await onRequestError(new RangeError("Invalid time value"), { path: req.url, method: req.method || "GET" }, { routePath: "/api/[...path]", routeType: "route" });
      res.statusCode = 500;
    } else res.statusCode = 503;
    res.end("");
  });
  try {
    await (await fetch(`${server.origin}/api/thrown/abc123def`)).text();
    await (await fetch(`${server.origin}/api/maintenance`)).text();
    await settle();
    const groups = await rows();
    const thrown = groups.find((g) => g.name === "RangeError")!;
    assert.equal(thrown.route, "GET /api/thrown/:id");
    assert.equal(thrown.message, "Invalid time value");
    const plain = groups.find((g) => g.route === "GET /api/maintenance")!;
    assert.equal(plain.name, "HTTP 503");
    assert.equal(plain.status, 503);
    assert.equal(plain.frames, "[]");
  } finally {
    server.close();
    if (before === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = before;
  }
});

test("grouping: one group per route, command, error name and top frame; the last 20 occurrences", async () => {
  await details.clearErrorDetails();
  const now = Date.now();
  const boom = () => new Error("boom");
  for (let i = 0; i < 25; i++) details.captureError({ method: "POST", route: "POST /api/command", action: "row.update", status: 500, requestId: `req${i}abcd`, role: "member", error: boom(), at: now - 1000 + i });
  details.captureError({ method: "POST", route: "POST /api/command", action: "page.create", status: 500, error: boom(), at: now });
  details.captureError({ method: "GET", route: "GET /api/bootstrap", status: 500, error: boom(), at: now });
  await details.flushErrorDetails(now + 10);
  const groups = await rows();
  assert.equal(groups.length, 3);
  const update = groups.find((g) => g.action === "row.update")!;
  assert.equal(update.count, 25);
  const occurrences = JSON.parse(update.occurrences) as { requestId: string }[];
  assert.equal(occurrences.length, 20);
  assert.equal(occurrences.at(-1)!.requestId, "req24abcd");
  // Merged with what is stored: a later flush adds to the same group.
  details.captureError({ method: "POST", route: "POST /api/command", action: "row.update", status: 500, error: boom(), at: now + 5 });
  await details.flushErrorDetails(now + 20);
  assert.equal((await one<{ count: number }>("SELECT count FROM error_groups WHERE fingerprint=?", update.fingerprint))?.count, 26);
  assert.equal(details.fingerprintOf("a", "", "Error", []), details.fingerprintOf("a", "", "Error", []));
  assert.notEqual(details.fingerprintOf("a", "", "Error", []), details.fingerprintOf("b", "", "Error", []));
  // The view: counts in the range, trend buckets, newest occurrence first.
  const view = await details.errorDetails(now + 30, "24h");
  const v = view.groups.find((g) => g.action === "row.update")!;
  assert.equal(v.inRange, 26);
  assert.equal(v.occurrences[0].at, now + 5);
  assert.equal(view.step, 5 * 60_000);
  assert.ok(v.buckets.length >= 1);
  const report = details.issueReport(v);
  assert.match(report, /^Error: boom/);
  assert.match(report, /Where: POST \/api\/command · row\.update/);
  assert.doesNotMatch(report, /member/);
});

test("retention 14 days and a cap of 500 groups, the least recent go first", async () => {
  await details.clearErrorDetails();
  const now = Date.now();
  const insert = (fp: string, last: number) =>
    run("INSERT INTO error_groups(fingerprint,route,name,count,first_seen,last_seen) VALUES(?,?,?,?,?,?)", fp, "GET /api/x", "Error", 1, last, last);
  await insert("old", now - 15 * DAY);
  for (let i = 0; i < 505; i++) await insert(`g${String(i).padStart(3, "0")}`, now - DAY + i * 1000);
  await details.sweepErrorDetails(now, true);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM error_groups"))?.n, 500);
  assert.equal(await one("SELECT 1 FROM error_groups WHERE fingerprint='old'"), undefined);
  // The five oldest of the rest went.
  assert.equal(await one("SELECT 1 FROM error_groups WHERE fingerprint='g004'"), undefined);
  assert.ok(await one("SELECT 1 FROM error_groups WHERE fingerprint='g005'"));
  await details.clearErrorDetails();
  assert.equal((await details.errorDetails()).groups.length, 0);
});

test("a failing write or capture never throws, and memory is bounded", async () => {
  await details.clearErrorDetails();
  // A value that is no Error, a cyclic object, an error whose stack throws.
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const nasty = new Error("x");
  Object.defineProperty(nasty, "stack", { get: () => { throw new Error("no stack"); } });
  for (const error of ["plain text", 42, null, cyclic, nasty]) assert.doesNotThrow(() => details.captureError({ route: "GET /api/x", status: 500, error }));
  for (let i = 0; i < 1500; i++) details.captureError({ route: "GET /api/flood", status: 500 });
  await details.flushErrorDetails();
  const flood = await one<{ count: number }>("SELECT count FROM error_groups WHERE route='GET /api/flood'");
  assert.ok(flood && flood.count < 1000);
  assert.doesNotThrow(() => context.serverError(new Error("outside a request")));
  assert.equal(context.serverError(null), 500);
});

test("the database's error code, workers and MCP tools, the caller's role", async () => {
  await details.clearErrorDetails();
  let dbError: unknown;
  try {
    await one("SELECT * FROM no_such_table_here");
  } catch (e) {
    dbError = e;
  }
  assert.match(details.databaseCode(dbError), /^(SQLite \d+|PostgreSQL 42P01)/);
  assert.equal(details.databaseCode(new Error("x")), "");
  assert.equal(details.databaseCode({ code: "23505", severity: "ERROR" }), "PostgreSQL 23505");
  await noteWorkerRun("issue-sync", new Error("GitHub answered 502"));
  context.withRequestContext({ id: "abcdef123456", method: "POST", route: "POST /api/mcp" }, () => details.captureHandledError(new Error("tool broke"), "mcp.search_pages"));
  details.captureError({ route: "GET /api/x", status: 500, error: dbError });
  await details.flushErrorDetails();
  const groups = await rows();
  const worker = groups.find((g) => g.route === "worker issue-sync")!;
  assert.equal(worker.message, "GitHub answered 502");
  const mcp = groups.find((g) => g.action === "mcp.search_pages")!;
  assert.equal(JSON.parse(mcp.occurrences)[0].role, "mcp");
  assert.equal(JSON.parse(mcp.occurrences)[0].requestId, "abcdef123456");
  assert.match(groups.find((g) => g.route === "GET /api/x")!.db_code, /^(SQLite|PostgreSQL) /);
  // Roles only, never the person.
  const ctx = { id: "x", method: "GET", route: "GET /api/bootstrap" } as Parameters<typeof context.roleOf>[0];
  context.withRequestContext(ctx, () => context.noteRequestCaller({ isAdmin: true }));
  assert.equal(context.roleOf(ctx), "admin");
  context.withRequestContext(ctx, () => context.noteRequestCaller({ isAdmin: true, apiScope: "write" }));
  assert.equal(context.roleOf(ctx), "token");
  assert.equal(context.roleOf({ id: "x", method: "GET", route: "GET /api/share/:id" }), "guest");
  assert.equal(context.roleOf({ id: "x", method: "GET", route: "GET /api/pages" }), "anonymous");
});

test("stack frames: mapped to the source with the build's source map, else the compiled file", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowplan-maps-"));
  const chunk = join(dir, "chunk.js");
  writeFileSync(chunk, "function o(){throw new Error('x')}\n");
  // Line 1, column 1 of the chunk is line 1, column 1 of lib/api.ts.
  writeFileSync(`${chunk}.map`, JSON.stringify({ version: 3, sources: ["turbopack:///[project]/lib/api.ts"], names: [], mappings: "AAAA" }));
  const stack = `Error: x\n    at o (${chunk}:1:1)\n    at next (/app/node_modules/next/dist/server.js:1:2)\n    at node:internal/process/task_queues:95:5\n    at other (${join(dir, "plain.js")}:3:7)`;
  const frames = details.stackFrames(stack);
  assert.deepEqual(frames[0], { fn: "o", file: "lib/api.ts", line: 1, column: 1, mapped: true });
  assert.equal(frames[1].mapped, false);
  assert.equal(frames[1].line, 3);
  assert.equal(frames.length, 2);
  assert.equal(details.frameText(frames[0]), "o (lib/api.ts:1:1)");
});

test("the person sees the request id of a server error", () => {
  const c = classifyError({ message: "Auf dem Server ist etwas schiefgelaufen. Bitte erneut versuchen. Fehler-ID: Ab3dE6gH9jK1", status: 500 });
  assert.deepEqual(c, { kind: "server", requestId: "Ab3dE6gH9jK1" });
  assert.equal(describeError(c, t).detail, "Fehler-ID: Ab3dE6gH9jK1");
  assert.equal(describeError({ kind: "server" }, t).detail, undefined);
  const ui = readFileSync(join(import.meta.dirname, "../components/ui.tsx"), "utf8");
  assert.match(ui, /withRequestId\(tr\("Auf dem Server ist etwas schiefgelaufen/);
  const catchAll = readFileSync(join(import.meta.dirname, "../app/api/[...path]/handler.ts"), "utf8");
  assert.match(catchAll, /requestId = status >= 500 \? currentRequestId\(\)/);
});

test("the admin API: administrators only, writes with an origin check", () => {
  const route = readFileSync(join(import.meta.dirname, "../app/api/admin/monitoring/handler.ts"), "utf8");
  assert.match(route, /const admin = async \(\) => requireOpsAdmin\(await requireUser\(\)\)/);
  const get = route.slice(route.indexOf("export const GET"), route.indexOf("const postSchema"));
  assert.ok(get.indexOf("await admin()") < get.indexOf('view") === "errors"'));
  const post = route.slice(route.indexOf("export const POST"));
  assert.ok(post.indexOf("await checkOrigin(req)") < post.indexOf("clearErrorDetails()"));
  assert.ok(post.indexOf("await admin()") < post.indexOf("clearErrorDetails()"));
  // Every route handler's catch notes the exception (no bare `: 500`).
  const missing: string[] = [];
  for (const file of ["app/api/[...path]/handler.ts", "app/api/ai/[...path]/handler.ts", "app/api/admin/monitoring/handler.ts", "app/api/share/[token]/handler.ts"]) {
    const text = readFileSync(join(import.meta.dirname, "..", file), "utf8");
    if (/instanceof HttpError \? e\.status : 500\b/.test(text)) missing.push(file);
  }
  assert.deepEqual(missing, []);
});

test("the test endpoint exists only in the browser specs' build", () => {
  const catchAll = readFileSync(join(import.meta.dirname, "../app/api/[...path]/handler.ts"), "utf8");
  assert.match(catchAll, /if \(e2eBuild\) \{\n\s+const kind = e2eFailure\(/);
  const failure = readFileSync(join(import.meta.dirname, "../lib/e2e-failure.ts"), "utf8");
  assert.match(failure, /!demoSignInAllowed\(\)\) return null/);
});
