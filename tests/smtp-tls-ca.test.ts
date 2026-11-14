// An SMTP server with a certificate from a private CA (#286): without its
// CA the connection fails with a certificate error (and the message says
// where the CA goes); with SMTP_TLS_CA – file path or PEM text – it
// connects. Verification is never switched off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import nodemailer from "nodemailer";
import { certificateProblem, mailConfig, smtpOptions, tlsCaOf } from "../lib/mail";

function certificates() {
  const dir = mkdtempSync(join(tmpdir(), "smtp-ca-"));
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Test CA");
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=127.0.0.1");
  writeFileSync(join(dir, "san.cnf"), "subjectAltName=IP:127.0.0.1\n");
  run("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "2", "-extfile", "san.cnf");
  return { dir, ca: join(dir, "ca.pem"), key: readFileSync(join(dir, "server.key")), cert: readFileSync(join(dir, "server.pem")) };
}

// Just enough SMTP over TLS from the start (port 465 style) for verify().
async function smtpServer(key: Buffer, cert: Buffer) {
  const server = createServer({ key, cert }, (socket: TLSSocket) => {
    socket.write("220 test ESMTP\r\n");
    socket.on("data", (data) => {
      for (const line of data.toString().split("\r\n").filter(Boolean)) {
        if (/^(EHLO|HELO)/i.test(line)) socket.write("250-test\r\n250 OK\r\n");
        else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(r)) };
}

test("an SMTP server with a private CA: refused without SMTP_TLS_CA, connected with it (path or PEM)", async (t) => {
  const certs = certificates();
  const smtp = await smtpServer(certs.key, certs.cert);
  t.after(() => smtp.close());
  const env = { ...process.env };
  t.after(() => {
    process.env = env;
  });
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(smtp.port);
  process.env.SMTP_SECURE = "true";
  const verify = async () => {
    const transport = nodemailer.createTransport(smtpOptions(mailConfig()!, { connection: 5000, greeting: 5000, socket: 5000 }));
    try {
      return await transport.verify();
    } finally {
      transport.close();
    }
  };

  delete process.env.SMTP_TLS_CA;
  assert.equal(mailConfig()!.tlsCa, undefined);
  const refused = await verify().then(
    () => null,
    (e: Error) => e,
  );
  assert.ok(refused, "a certificate from an unknown CA is refused");
  assert.ok(certificateProblem(refused.message), refused.message);

  process.env.SMTP_TLS_CA = certs.ca;
  assert.equal(await verify(), true);

  // PEM text in one line, as in a .env file.
  process.env.SMTP_TLS_CA = readFileSync(certs.ca, "utf8").trim().replace(/\n/g, "\\n");
  assert.match(tlsCaOf(process.env.SMTP_TLS_CA)!, /^-----BEGIN CERTIFICATE-----\n/);
  assert.equal(await verify(), true);
  // The public CAs stay trusted next to the own one.
  const tls = smtpOptions(mailConfig()!).tls as { ca: string[] };
  assert.ok(tls.ca.length > 1);
});

test("certificate errors are recognised for the hint, others are not", () => {
  for (const message of [
    "unable to verify the first certificate",
    "self-signed certificate in certificate chain",
    "unable to get local issuer certificate",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
  ])
    assert.ok(certificateProblem(message), message);
  for (const message of ["connect ECONNREFUSED 10.0.0.1:25", "Invalid login: 535 Authentication failed", "Greeting never received"])
    assert.ok(!certificateProblem(message), message);
});
