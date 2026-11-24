// Failures of third-party services (#514): an HttpError marked `upstream`
// (lib/auth.ts) is counted as a request but not as a server error
// (lib/metrics.ts, the error chart, the KPI "Fehler 24 Std.", the
// recommendations) and kept apart in lib/error-details.ts
// ("Fehler bei Fremddiensten"); an unmarked 500 stays a server error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-upstream-"));
delete process.env.FLOWPLAN_METRICS;
const { all } = await import("../lib/db");
const { HttpError, upstreamError, upstreamHost, isUpstreamError } = await import("../lib/auth");
const { AiError } = await import("../lib/ai/transport");
const details = await import("../lib/error-details");
const metrics = await import("../lib/metrics");
const context = await import("../lib/request-context");
const { startRequestMetrics } = await import("../lib/request-metrics");
const { serializeError, reviveError } = await import("../lib/worker-pool");
const { storedError, restoredError } = await import("../lib/background-jobs");

// Like a route handler: HttpErrors answer with their status, anything else
// with serverError() (500).
async function serve(handler: (req: IncomingMessage) => Promise<void>) {
  startRequestMetrics();
  const server = createServer((req, res: ServerResponse) => {
    void (async () => {
      try {
        await handler(req);
        res.end("{}");
      } catch (e) {
        res.statusCode = e instanceof HttpError ? e.status : context.serverError(e);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}
const settle = async () => {
  await new Promise((r) => setTimeout(r, 30));
  await details.flushErrorDetails();
};
const minuteErrors = () => {
  const s = (globalThis as unknown as { flowplanMetrics: { current: { requests: number; errors: number; clientErrors: number } | null } }).flowplanMetrics;
  return s.current ? { requests: s.current.requests, errors: s.current.errors, clientErrors: s.current.clientErrors } : { requests: 0, errors: 0, clientErrors: 0 };
};

test("the marker: service and host only (no path, no port, IP addresses hidden)", () => {
  const e = upstreamError("Die Seite antwortet mit einem Fehler.", "oembed", "https://user:pw@video.example.org:8443/watch?v=1");
  assert.equal(e.status, 502);
  assert.deepEqual(e.upstream, { service: "oembed", host: "video.example.org" });
  assert.ok(isUpstreamError(e));
  assert.equal(upstreamHost(new URL("http://192.168.1.20:11434/api")), "[IP]");
  assert.equal(upstreamHost("api.openverse.org"), "api.openverse.org");
  assert.equal(upstreamHost("not a host!"), "");
  assert.equal(new HttpError(502, "x", { service: "Bad Service!" }).upstream?.service, "other");
  // Only 5xx are upstream failures; plain HttpErrors are not marked.
  assert.equal(new HttpError(400, "x", { service: "ai" }).upstream, undefined);
  assert.equal(new HttpError(502, "x").upstream, undefined);
  assert.ok(!isUpstreamError(new HttpError(500, "x")));
  // The AI provider: 502/504 marked, 4xx and aborts not.
  assert.deepEqual(new AiError(502, "unreachable", "https://api.openai.com/v1").upstream, { service: "ai", host: "api.openai.com" });
  assert.equal(new AiError(504, "timeout").upstream?.service, "ai");
  assert.equal(new AiError(400, "bad").upstream, undefined);
  assert.equal(new AiError(499, "aborted").upstream, undefined);
});

test("the marker survives the worker threads and stored job outcomes", () => {
  const e = upstreamError("Die Bildsuche hat nicht geantwortet.", "image-search", "api.openverse.org");
  const revived = reviveError(serializeError(e)) as InstanceType<typeof HttpError>;
  assert.deepEqual(revived.upstream, e.upstream);
  const restored = restoredError(JSON.parse(JSON.stringify(storedError(e)))) as InstanceType<typeof HttpError>;
  assert.deepEqual(restored.upstream, e.upstream);
  assert.equal(restored.status, 502);
  assert.equal((reviveError(serializeError(new HttpError(500, "x"))) as InstanceType<typeof HttpError>).upstream, undefined);
});

test("a marked upstream 502 is no 5xx but shows in the upstream list; an unmarked 500 still counts", async () => {
  await details.clearErrorDetails();
  await metrics.refreshMetricsEnabled();
  const server = await serve(async (req) => {
    const path = (req.url || "").split("?")[0];
    if (path === "/api/embed") throw upstreamError("Die Seite antwortet mit einem Fehler.", "oembed", "https://video.example.org/watch?v=secret");
    if (path === "/api/images/search") throw new HttpError(502, "Die Bildsuche hat nicht geantwortet.", { service: "image-search", host: "api.openverse.org" });
    if (path === "/api/ai/models") throw new AiError(502, "Der KI-Anbieter ist nicht erreichbar.", "http://ollama:11434");
    // An upstream failure handled, then a real bug: a 500.
    if (path === "/api/broken") {
      try {
        throw upstreamError("Der Kalenderanbieter meldet einen Fehler.", "calendar");
      } catch {}
      throw new TypeError("Cannot read properties of undefined");
    }
    // An unmarked 502 of Flowplan's own stays a server error.
    if (path === "/api/own") throw new HttpError(502, "Eigener Fehler.");
  });
  try {
    const before = minuteErrors();
    for (const [method, path] of [
      ["GET", "/api/embed?url=x"],
      ["GET", "/api/embed?url=y"],
      ["GET", "/api/images/search?q=cat"],
      ["POST", "/api/ai/models"],
    ] as const) {
      const r = await fetch(`${server.origin}${path}`, { method });
      assert.equal(r.status, 502);
    }
    await settle();
    const mid = minuteErrors();
    assert.equal(mid.requests - before.requests, 4);
    assert.equal(mid.errors - before.errors, 0, "upstream failures are no server errors");
    assert.equal(mid.clientErrors - before.clientErrors, 0);
    assert.equal((await all("SELECT * FROM error_groups")).length, 0, "nothing in the errors in detail");
    const list = await details.upstreamFailures();
    const by = (route: string) => list.items.find((i) => i.route === route);
    assert.equal(list.items.length, 3);
    assert.deepEqual(
      { service: by("GET /api/embed")?.service, host: by("GET /api/embed")?.host, count: by("GET /api/embed")?.count, inRange: by("GET /api/embed")?.inRange, status: by("GET /api/embed")?.status },
      { service: "oembed", host: "video.example.org", count: 2, inRange: 2, status: 502 },
    );
    assert.equal(by("GET /api/images/search")?.service, "image-search");
    assert.equal(by("GET /api/images/search")?.host, "api.openverse.org");
    assert.equal(by("POST /api/ai/models")?.service, "ai");
    assert.equal(by("POST /api/ai/models")?.host, "ollama");
    assert.equal(by("POST /api/ai/models")?.message, "Der KI-Anbieter ist nicht erreichbar.");
    assert.ok(Math.abs((by("GET /api/embed")?.lastSeen ?? 0) - Date.now()) < 60_000);
    // Never the path or query of the linked site.
    assert.ok(!JSON.stringify(list).includes("secret"));

    for (const path of ["/api/broken", "/api/own"]) await fetch(`${server.origin}${path}`);
    await settle();
    const end = minuteErrors();
    assert.equal(end.errors - mid.errors, 2, "a real 500 and an unmarked 502 count");
    const groups = await all<{ route: string; status: number; name: string }>("SELECT route,status,name FROM error_groups ORDER BY route");
    assert.deepEqual(
      groups.map((g) => [g.route, g.status]),
      [
        ["GET /api/broken", 500],
        ["GET /api/own", 502],
      ],
    );
    assert.equal(groups[0].name, "TypeError");
    assert.equal((await details.upstreamFailures()).items.length, 3);
  } finally {
    server.close();
  }
});

test("the time per endpoint and the commands: no error for an upstream failure", () => {
  const s = (globalThis as unknown as { flowplanMetrics: { routes: Map<string, { requests: number; errors: number }> } }).flowplanMetrics;
  s.routes.clear();
  const now = Date.now();
  metrics.noteRequest(502, 10, now, "GET /api/embed", true);
  metrics.noteRequest(500, 10, now, "GET /api/pages", false);
  metrics.noteCommand("ai.models", 10, false, now);
  const rows = [...s.routes].map(([key, r]) => [key.slice(key.indexOf("|") + 1), r.requests, r.errors]);
  assert.deepEqual(
    rows.sort(),
    [
      ["GET /api/embed", 1, 0],
      ["GET /api/pages", 1, 1],
      ["POST /api/command · ai.models", 1, 0],
    ].sort(),
  );
});

test("failing workers and jobs with an upstream failure go to the upstream list", async () => {
  await details.clearErrorDetails();
  details.captureWorkerError("calendar-sync", upstreamError("Der Kalenderanbieter meldet einen Fehler.", "calendar"));
  details.captureJobError("import", new HttpError(502, "Notion ist gerade nicht erreichbar.", { service: "notion", host: "api.notion.com" }));
  details.captureWorkerError("mail", new Error("boom"));
  await details.flushErrorDetails();
  const list = await details.upstreamFailures(Date.now(), "1h");
  assert.deepEqual(
    list.items.map((i) => [i.kind, i.route, i.service, i.host]).sort(),
    [
      ["job", "job import", "notion", "api.notion.com"],
      ["worker", "worker calendar-sync", "calendar", ""],
    ],
  );
  assert.deepEqual(
    (await all<{ route: string }>("SELECT route FROM error_groups")).map((r) => r.route),
    ["worker mail"],
  );
  // Clearing the error details clears both.
  await details.clearErrorDetails();
  assert.equal((await details.upstreamFailures()).items.length, 0);
});

test("the admin API answers the upstream list", async () => {
  const { readFileSync } = await import("node:fs");
  const handler = readFileSync(new URL("../app/api/admin/monitoring/handler.ts", import.meta.url), "utf8");
  assert.match(handler, /view"\) === "upstream"\) return Response\.json\(await upstreamFailures\(/);
});
