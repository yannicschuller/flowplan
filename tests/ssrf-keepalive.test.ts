import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
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
  // All local addresses: "localhost" resolves to ::1 first on some hosts (CI).
  await new Promise<void>((done) => server.listen(0, done));
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

test("a name with an IPv6 and an IPv4 address connects when the server answers on one family only", async () => {
  // As "localhost" on GitHub's runners: ::1 first, 127.0.0.1 second, the
  // server on 127.0.0.1 only. Every checked address goes to the connection
  // (happy eyeballs), not just the first – which would be refused.
  const server = createHttpServer((_req, res) => res.end("v4"));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const real = dns.lookup;
  const fake = ((host: string, options: unknown, callback: unknown) => {
    if (host !== "dual.flowplan.test") return (real as (...a: unknown[]) => void)(host, options, callback);
    const list = [
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ];
    process.nextTick(() => (callback as (e: null, l: typeof list) => void)(null, list));
  }) as typeof dns.lookup;
  dns.lookup = fake;
  syncBuiltinESMExports();
  try {
    const port = (server.address() as { port: number }).port;
    const answer = await safeSend(`http://dual.flowplan.test:${port}/`, "", {}, { method: "GET", allowPrivate: true, maxBytes: 100 });
    assert.equal(answer.body, "v4");
    // The check still covers every address: an internal one refuses the name.
    await assert.rejects(safeSend(`https://dual.flowplan.test:${port}/`, "", {}), /Interne/);
  } finally {
    dns.lookup = real;
    syncBuiltinESMExports();
    server.close();
  }
});
