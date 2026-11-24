// #518: S3 requests go out with a known length. Inside Next.js the patched
// fetch passed the body of a Request object on as a stream, so a PUT went
// out chunked without Content-Length and S3 servers answered 411. The
// fetch below does the same with Request objects; the S3 server stand-in
// refuses a PUT without Content-Length, as VersityGW and AWS do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const puts: { path: string; length: string | undefined; chunked: boolean; bytes: number }[] = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url || "", "http://x");
    if (req.method === "PUT") {
      const bytes = Buffer.concat(chunks).length;
      puts.push({ path: url.pathname, length: req.headers["content-length"], chunked: req.headers["transfer-encoding"] === "chunked", bytes });
      if (!req.headers["content-length"]) return void res.writeHead(411).end();
    }
    if (req.method === "GET" && url.searchParams.get("list-type") === "2")
      return void res.writeHead(200).end("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
    res.writeHead(200).end();
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
server.unref();

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-s3-length-"));
process.env.S3_ENDPOINT = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY_ID = "key";
process.env.S3_SECRET_ACCESS_KEY = "secret";

// Like Next.js' patched fetch: a Request's body goes on as a stream.
const plain = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (input instanceof Request)
    return plain(new Request(input.url, { method: input.method, headers: input.headers, body: input.body, duplex: "half" } as RequestInit));
  return plain(input, init);
}) as typeof fetch;

await import("../lib/db");
const { runScheduledBackup, errorText } = await import("../lib/scheduled-backup");

test("the backup PUT carries Content-Length and is not chunked (#518)", async () => {
  const result = await runScheduledBackup(Date.UTC(2026, 10, 24, 3));
  assert.equal(result.error, null);
  const put = puts.find((p) => p.path.includes("/backups/"));
  assert.ok(put, "a backup was uploaded");
  assert.equal(put.chunked, false);
  assert.equal(Number(put.length), put.bytes);
  assert.ok(put.bytes > 0);
});

test("a stored error names its cause (#518)", () => {
  const error = new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
  assert.equal(errorText(error), "fetch failed: other side closed");
  assert.equal(errorText(new Error("Hochladen: HTTP 411")), "Hochladen: HTTP 411");
});
