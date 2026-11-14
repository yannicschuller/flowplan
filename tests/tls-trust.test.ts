// Certificate checks for SMTP and LDAP (#286, lib/tls-trust.ts): a server
// with a private-CA certificate for mail.internal, reached at 127.0.0.1.
// The CA alone fails on the name (and the hint names *_TLS_SERVERNAME), CA +
// *_TLS_SERVERNAME connects, *_TLS_REJECT_UNAUTHORIZED=false connects
// without the CA – and only "false" does that. The switch is never silent:
// the start-up log, Administration (E-Mail, LDAP) and the security overview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netServer, type Socket } from "node:net";
import { createServer as tlsServer, TLSSocket } from "node:tls";
import nodemailer from "nodemailer";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-tls-trust-"));
const { mailConfig, mailStatus, smtpOptions, smtpTlsHint } = await import("../lib/mail");
const ldap = await import("../lib/ldap");
const { ldapStatus } = await import("../lib/ldap-auth");
const { securityOverview } = await import("../lib/security-admin");
const trust = await import("../lib/tls-trust");

const TLS_KEYS = [
  "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_TLS_CA", "SMTP_TLS_SERVERNAME", "SMTP_TLS_REJECT_UNAUTHORIZED",
  "LDAP_URL", "LDAP_BASE_DN", "LDAP_TLS_CA", "LDAP_TLS_SERVERNAME", "LDAP_TLS_REJECT_UNAUTHORIZED", "LDAP_TIMEOUT_MS",
];
const clean = () => {
  for (const key of TLS_KEYS) delete process.env[key];
};

// A private CA and a server certificate for mail.internal only.
function certificates() {
  const dir = mkdtempSync(join(tmpdir(), "tls-trust-"));
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Test CA");
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=mail.internal");
  writeFileSync(join(dir, "san.cnf"), "subjectAltName=DNS:mail.internal\n");
  run("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "2", "-extfile", "san.cnf");
  return { ca: join(dir, "ca.pem"), key: readFileSync(join(dir, "server.key")), cert: readFileSync(join(dir, "server.pem")) };
}
const certs = certificates();

// Just enough SMTP for verify(): TLS from the start (465) or STARTTLS (25).
function speak(socket: Socket | TLSSocket, onStartTls?: () => void) {
  const onData = (data: Buffer) => {
    for (const line of data.toString().split("\r\n").filter(Boolean)) {
      if (/^(EHLO|HELO)/i.test(line)) socket.write(onStartTls ? "250-test\r\n250 STARTTLS\r\n" : "250-test\r\n250 OK\r\n");
      else if (/^STARTTLS/i.test(line) && onStartTls) {
        socket.off("data", onData);
        socket.write("220 go ahead\r\n", onStartTls);
        return;
      } else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
      else socket.write("250 OK\r\n");
    }
  };
  socket.on("data", onData);
  socket.on("error", () => {});
}
async function listen(server: ReturnType<typeof netServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(r)) };
}
const smtps = () =>
  listen(
    tlsServer({ key: certs.key, cert: certs.cert }, (socket) => {
      socket.write("220 test ESMTP\r\n");
      speak(socket);
    }),
  );
const smtpStartTls = () =>
  listen(
    netServer((plain) => {
      plain.write("220 test ESMTP\r\n");
      speak(plain, () => {
        const secure = new TLSSocket(plain, { isServer: true, key: certs.key, cert: certs.cert });
        secure.on("error", () => {});
        speak(secure);
      });
    }),
  );
async function verify() {
  const transport = nodemailer.createTransport(smtpOptions(mailConfig()!, { connection: 5000, greeting: 5000, socket: 5000 }));
  try {
    return await transport.verify();
  } finally {
    transport.close();
  }
}
const failure = () =>
  verify().then(
    () => null,
    (e: Error) => e,
  );

test("SMTP: CA alone fails on the name, CA + SMTP_TLS_SERVERNAME connects, REJECT_UNAUTHORIZED=false connects without a CA", async (t) => {
  const smtp = await smtps();
  t.after(() => smtp.close());
  t.after(clean);
  clean();
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(smtp.port);
  process.env.SMTP_SECURE = "true";

  // (a) The CA is trusted, but the certificate is for mail.internal.
  process.env.SMTP_TLS_CA = certs.ca;
  const mismatch = await failure();
  assert.ok(mismatch, "a certificate for another name is refused");
  assert.ok(trust.hostnameProblem(mismatch.message), mismatch.message);
  assert.match(smtpTlsHint(mismatch.message), /SMTP_TLS_SERVERNAME/);
  assert.match(smtpTlsHint(mismatch.message), /SMTP_TLS_CA/);

  // (b) Checked against the name in the certificate: connects (and SNI is
  // that name, never the IP).
  process.env.SMTP_TLS_SERVERNAME = "mail.internal";
  assert.equal(mailConfig()!.tlsServername, "mail.internal");
  assert.equal(smtpOptions(mailConfig()!).tls.servername, "mail.internal");
  assert.equal(await verify(), true);
  // A wrong name still fails.
  process.env.SMTP_TLS_SERVERNAME = "other.internal";
  assert.ok(trust.hostnameProblem((await failure())!.message));

  // (c) No CA, no name, verification off: connects.
  delete process.env.SMTP_TLS_CA;
  delete process.env.SMTP_TLS_SERVERNAME;
  const unknown = await failure();
  assert.ok(unknown && trust.certificateProblem(unknown.message), String(unknown?.message));
  assert.match(smtpTlsHint(unknown.message), /SMTP_TLS_CA/);
  process.env.SMTP_TLS_REJECT_UNAUTHORIZED = "false";
  assert.equal(smtpOptions(mailConfig()!).tls.rejectUnauthorized, false);
  assert.equal(await verify(), true);

  // (d) Any other value keeps verification on.
  for (const value of ["0", "no", "off", "False-ish", "", "true", "falsch"]) {
    process.env.SMTP_TLS_REJECT_UNAUTHORIZED = value;
    assert.equal(smtpOptions(mailConfig()!).tls.rejectUnauthorized, true, value);
  }
  process.env.SMTP_TLS_REJECT_UNAUTHORIZED = "0";
  assert.ok(await failure(), "0 does not switch verification off");
  // "false" in any letter case, with spaces around it, does.
  process.env.SMTP_TLS_REJECT_UNAUTHORIZED = " False ";
  assert.equal(await verify(), true);
});

test("SMTP over STARTTLS (port 25 relay): the same options apply after the upgrade", async (t) => {
  const smtp = await smtpStartTls();
  t.after(() => smtp.close());
  t.after(clean);
  clean();
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(smtp.port);
  process.env.SMTP_SECURE = "false";
  const refused = await failure();
  assert.ok(refused && trust.certificateProblem(refused.message), String(refused?.message));
  process.env.SMTP_TLS_CA = certs.ca;
  process.env.SMTP_TLS_SERVERNAME = "mail.internal";
  assert.equal(await verify(), true);
  delete process.env.SMTP_TLS_CA;
  delete process.env.SMTP_TLS_SERVERNAME;
  process.env.SMTP_TLS_REJECT_UNAUTHORIZED = "false";
  assert.equal(await verify(), true);
});

test("LDAP: options from the environment (CA, servername, verification)", (t) => {
  t.after(clean);
  clean();
  process.env.LDAP_URL = "ldaps://10.0.0.5";
  process.env.LDAP_BASE_DN = "dc=example,dc=org";
  let config = ldap.ldapConfig()!;
  assert.equal(config.tlsRejectUnauthorized, true);
  assert.equal(config.tlsServername, undefined);
  // An IP is never sent as SNI, and Node's own check applies.
  let options = ldap.ldapTlsOptions("10.0.0.5", config);
  assert.equal(options.servername, undefined);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal("checkServerIdentity" in options, false);
  assert.equal(ldap.ldapTlsOptions("ldap.example.org", config).servername, "ldap.example.org");

  process.env.LDAP_TLS_CA = readFileSync(certs.ca, "utf8").trim().replace(/\n/g, "\\n");
  process.env.LDAP_TLS_SERVERNAME = " dc1.corp.local ";
  config = ldap.ldapConfig()!;
  options = ldap.ldapTlsOptions("10.0.0.5", config);
  assert.match(options.ca!, /^-----BEGIN CERTIFICATE-----\n/);
  assert.equal(options.servername, "dc1.corp.local");
  assert.equal(typeof options.checkServerIdentity, "function");
  // The contacts sync uses the same server configuration.
  assert.equal(ldap.ldapServerConfig("ou=contacts,dc=example,dc=org")!.tlsServername, "dc1.corp.local");

  for (const [value, off] of [["false", true], ["FALSE", true], [" false\n", true], ["0", false], ["no", false], ["off", false], ["", false]] as const) {
    process.env.LDAP_TLS_REJECT_UNAUTHORIZED = value;
    assert.equal(ldap.ldapTlsOptions("10.0.0.5", ldap.ldapConfig()!).rejectUnauthorized, !off, JSON.stringify(value));
  }
  // A config without the fields (older callers) verifies.
  assert.equal(ldap.ldapTlsOptions("x", { tlsCa: undefined }).rejectUnauthorized, true);
});

test("LDAP over ldaps://: name mismatch with a hint, servername connects, switched off connects", async (t) => {
  // Only the handshake matters: LdapConnection.open resolves once it is done.
  const sockets = new Set<TLSSocket>();
  const server = await listen(
    tlsServer({ key: certs.key, cert: certs.cert }, (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
    }),
  );
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    void server.close();
  });
  t.after(clean);
  const open = (extra: Partial<import("../lib/ldap").LdapConfig>) =>
    ldap.LdapConnection.open({ url: `ldaps://127.0.0.1:${server.port}`, startTls: false, timeoutMs: 5000, ...extra }).then((conn) => conn.close());
  const ca = readFileSync(certs.ca, "utf8");
  await assert.rejects(open({}), /LDAP_TLS_CA/);
  await assert.rejects(open({ tlsCa: ca }), (e: Error) => /altnames/.test(e.message) && /LDAP_TLS_SERVERNAME/.test(e.message));
  await open({ tlsCa: ca, tlsServername: "mail.internal" });
  await open({ tlsRejectUnauthorized: false });
  // The same through the environment.
  clean();
  process.env.LDAP_URL = `ldaps://127.0.0.1:${server.port}`;
  process.env.LDAP_BASE_DN = "dc=example,dc=org";
  process.env.LDAP_TLS_CA = certs.ca;
  process.env.LDAP_TLS_SERVERNAME = "mail.internal";
  await ldap.LdapConnection.open(ldap.ldapConfig()!).then((conn) => conn.close());
});

test("switched off is never silent: start-up log once, Administration and the security overview", async (t) => {
  t.after(clean);
  clean();
  const runtime = globalThis as { flowplanTlsWarned?: boolean };
  // Without a server the switch is moot: no warning.
  process.env.SMTP_TLS_REJECT_UNAUTHORIZED = "false";
  assert.deepEqual(trust.unverifiedTls(), []);
  process.env.SMTP_HOST = "relay.lan";
  process.env.LDAP_URL = "ldaps://192.168.1.10";
  process.env.LDAP_BASE_DN = "dc=home,dc=lan";
  process.env.LDAP_TLS_REJECT_UNAUTHORIZED = "no";
  assert.deepEqual(trust.unverifiedTls(), ["SMTP"]);
  process.env.LDAP_TLS_REJECT_UNAUTHORIZED = "false";
  assert.deepEqual(trust.unverifiedTls(), ["SMTP", "LDAP"]);

  delete runtime.flowplanTlsWarned;
  const lines: string[] = [];
  assert.equal(trust.warnUnverifiedTlsOnce((l) => lines.push(l)), 2);
  assert.match(lines[0], /SMTP_TLS_REJECT_UNAUTHORIZED=false.*NOT verified.*SMTP_TLS_CA.*SMTP_TLS_SERVERNAME/);
  assert.match(lines[1], /LDAP_TLS_REJECT_UNAUTHORIZED=false/);
  // Once per process.
  assert.equal(trust.warnUnverifiedTlsOnce((l) => lines.push(l)), 0);
  assert.equal(lines.length, 2);
  delete runtime.flowplanTlsWarned;

  const mail = await mailStatus();
  assert.equal(mail.tlsUnverified, true);
  const directory = await ldapStatus();
  assert.equal(directory.tlsUnverified, true);
  assert.deepEqual((await securityOverview()).setup.tlsUnverified, ["SMTP", "LDAP"]);

  delete process.env.SMTP_TLS_REJECT_UNAUTHORIZED;
  delete process.env.LDAP_TLS_REJECT_UNAUTHORIZED;
  process.env.SMTP_TLS_SERVERNAME = "mail.internal";
  assert.equal((await mailStatus()).tlsUnverified, false);
  assert.equal((await mailStatus()).tlsServername, "mail.internal");
  assert.equal((await ldapStatus()).tlsUnverified, false);
  assert.deepEqual((await securityOverview()).setup.tlsUnverified, []);
  assert.deepEqual(trust.tlsWarnings(), []);
});
