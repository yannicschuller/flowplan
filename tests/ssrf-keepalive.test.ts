import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ssrf-"));
const { safeFetch, safeSend } = await import("../lib/safe-fetch");

// A self-signed certificate for localhost, made for this run.
function certificate() {
  try {
    const dir = mkdtempSync(join(tmpdir(), "flowplan-ssrf-cert-"));
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
  } catch {
    return null;
  }
}
const tls = certificate();

test("an untrusted request never reuses a connection a trusted one opened to an internal host", { skip: !tls && "openssl missing" }, async () => {
  let connections = 0;
  const server = createServer(tls!, (_req, res) => res.end("internal"));
  server.on("connection", () => connections++);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const url = `https://localhost:${(server.address() as { port: number }).port}/`;
    await assert.rejects(safeFetch(url), /Interne/);
    assert.equal((await safeFetch(url, { allowPrivate: true })).body, "internal");
    await assert.rejects(safeFetch(url), /Interne/);
    await assert.rejects(safeSend(url, "", {}), /Interne/);
    assert.equal(connections, 1);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    server.closeAllConnections();
    server.close();
  }
});

test("safeSend refuses internal IP addresses, which skip the lookup", async () => {
  for (const url of ["https://127.0.0.1:1/", "https://[::1]:1/", "https://[::ffff:169.254.169.254]/"])
    await assert.rejects(safeSend(url, "{}", {}), /Interne/, url);
});
