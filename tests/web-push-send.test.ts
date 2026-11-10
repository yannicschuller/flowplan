// Web Push without the legacy url.parse() (#195): sendWebPush (lib/push.ts)
// sends the same request as web-push's sendNotification – encrypted body,
// TTL, urgency, VAPID for the endpoint's origin – and Node.js reports no
// DEP0169 deprecation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, globalAgent } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-web-push-"));
const { sendWebPush, pushKeys } = await import("../lib/push");

function certificate() {
  try {
    const dir = mkdtempSync(join(tmpdir(), "flowplan-web-push-cert-"));
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
  } catch {
    return null;
  }
}
const tls = certificate();

const subscriptionKeys = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
};

test("sendWebPush sends the encrypted message with VAPID for the endpoint's origin", { skip: !tls && "openssl missing" }, async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error & { code?: string }) => warnings.push(warning.code || warning.name);
  process.on("warning", onWarning);
  const seen: { method?: string; url?: string; headers?: Record<string, unknown>; length?: number }[] = [];
  let status = 201;
  const server = createServer(tls!, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, length: Buffer.concat(chunks).length });
      res.statusCode = status;
      res.end(status === 410 ? "gone" : "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const before = globalAgent.options.ca;
  globalAgent.options.ca = tls!.cert;
  try {
    const origin = `https://localhost:${(server.address() as { port: number }).port}`;
    const keys = pushKeys();
    const options = {
      vapidDetails: { ...keys, subject: "https://flowplan.example.test" },
      TTL: 600,
      timeout: 5000,
      contentEncoding: "aes128gcm" as const,
      urgency: "normal" as const,
    };
    const result = await sendWebPush({ endpoint: `${origin}/push/abc?x=1`, keys: subscriptionKeys() }, '{"title":"Flowplan"}', options);
    assert.equal(result.statusCode, 201);
    const [request] = seen;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/push/abc?x=1");
    assert.equal(request.headers!["ttl"], "600");
    assert.equal(request.headers!["urgency"], "normal");
    assert.equal(request.headers!["content-encoding"], "aes128gcm");
    assert.ok(request.length! > 0, "an encrypted body");
    assert.equal(Number(request.headers!["content-length"]), request.length);
    const authorization = String(request.headers!["authorization"]);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
    assert.ok(match, authorization);
    assert.equal(match[2], keys.publicKey);
    const claims = JSON.parse(Buffer.from(match[1].split(".")[1], "base64url").toString("utf8"));
    assert.equal(claims.aud, origin);
    assert.equal(claims.sub, "https://flowplan.example.test");
    // A gone subscription: the status code as with web-push (404/410 remove it).
    status = 410;
    await assert.rejects(
      sendWebPush({ endpoint: `${origin}/push/gone`, keys: subscriptionKeys() }, "{}", options),
      (error: { statusCode?: number; body?: string }) => error.statusCode === 410 && error.body === "gone",
    );
    await new Promise((r) => setImmediate(r));
    assert.ok(!warnings.includes("DEP0169"), `no url.parse() deprecation: ${warnings.join(", ")}`);
  } finally {
    globalAgent.options.ca = before;
    process.off("warning", onWarning);
    server.close();
  }
});
