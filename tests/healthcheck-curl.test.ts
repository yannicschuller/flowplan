// The image's `curl` is a stand-in for health checks (docker/healthcheck-curl.mjs):
// the calls Coolify and common compose files make give the same exit codes
// as curl – 0 for a healthy answer, 22 with -f on an HTTP error, 7 without
// a connection – and the real curl/libcurl stay out of the image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

// Asynchronous: the test process also serves the HTTP answers.
const run = (...args: string[]) =>
  new Promise<{ status: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, ["docker/healthcheck-curl.mjs", ...args]);
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (status) => resolve({ status, stdout }));
  });

test("the health-check curl answers like curl for the calls health checks make", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/api/health") res.end('{"status":"ok"}');
    else {
      res.statusCode = 503;
      res.end("down");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // Coolify's HTTP check.
  const coolify = await run("-s", "-X", "GET", "-f", `${base}/api/health`);
  assert.equal(coolify.status, 0);
  assert.equal(coolify.stdout, '{"status":"ok"}');
  assert.equal((await run("-s", "-X", "GET", "-f", `${base}/down`)).status, 22);
  // Without -f an HTTP error still counts as an answer, as with curl.
  assert.equal((await run("-s", `${base}/down`)).status, 0);
  // Compose-style checks.
  assert.equal((await run("-fsS", `${base}/api/health`)).status, 0);
  assert.equal((await run("-fsSL", "-o", "/dev/null", `${base}/down`)).status, 22);
  assert.equal((await run("--fail", "--silent", "--head", `${base}/api/health`)).status, 0);
  // Nothing listening.
  assert.equal((await run("-sf", "http://127.0.0.1:9/api/health")).status, 7);
  // Only http(s).
  assert.equal((await run("-s", "file:///etc/passwd")).status, 2);
});

test("the image has no real curl or libcurl, only the stand-in", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  // curl only fetches the PostgreSQL repository key in the stage pgclient;
  // the runtime stage never installs it and fails the build if it is there.
  const runtime = dockerfile.slice(dockerfile.indexOf(" AS runtime"));
  assert.ok(runtime.length > 0 && dockerfile.includes(" AS runtime"));
  assert.doesNotMatch(runtime, /apt-get install[^\n]*\bcurl\b/);
  assert.match(runtime, /! dpkg -l perl 'libperl\*' 'libcurl\*' curl postgresql-client-common/);
  assert.match(dockerfile, /COPY --chmod=755 docker\/healthcheck-curl\.mjs \/usr\/local\/bin\/curl/);
});
