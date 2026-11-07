// Bodies of requests that need no sign-in are read with a limit
// (lib/request-body.ts): a large streamed body is refused with 413 after
// reading little more than the limit, also without Content-Length.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-request-body-"));
process.env.APP_URL = "https://flowplan.example.test";
const { readBodyLimited, readJsonLimited } = await import("../lib/request-body");
const tickets = await import("../app/api/tickets/[token]/route");
const auth = await import("../app/api/auth/[action]/route");

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
  const route = readFileSync(join(import.meta.dirname, "../app/api/auth/[action]/route.ts"), "utf8");
  assert.match(route, /const body = \(\) =>\s*readJsonLimited\(req, 64_000\)/);
  assert.doesNotMatch(route.slice(route.indexOf("const body = ")), /req\.json\(\)/);
  for (const file of ["../app/api/tickets/[token]/route.ts", "../app/api/forms/[token]/route.ts", "../app/api/ai/[...path]/route.ts"])
    assert.doesNotMatch(readFileSync(join(import.meta.dirname, file), "utf8"), /req\.(text|json)\(\)/, file);
});

test("the app's sign-in report stops reading a large body", async () => {
  const { req, counter } = streamed("https://flowplan.example.test/api/auth/app-sign-in-report", { length: false });
  const res = await auth.POST(req, { params: Promise.resolve({ action: "app-sign-in-report" }) });
  assert.equal(res.status, 204);
  assert.ok(counter.sent <= 16 * 1024 + 3 * CHUNK, `read ${counter.sent} bytes`);
});
