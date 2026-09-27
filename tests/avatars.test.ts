import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-avatars-"));
// The picture server of this test runs on 127.0.0.1 (see the last test for
// the protection that normally refuses it).
process.env.OIDC_ALLOW_LOCAL_HTTP = "true";
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { syncAvatar, avatarFor, sniffImage } = await import("../lib/avatars");

const png = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);
const bodies: Record<string, { type: string; body: Buffer }> = {
  "/me.png": { type: "image/png", body: png },
  "/evil.svg": { type: "image/png", body: Buffer.from("<svg onload=alert(1)>") },
  "/huge.png": { type: "image/png", body: Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]) },
};
const server = createServer((req, res) => {
  const hit = bodies[req.url || ""];
  if (!hit) return void res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": hit.type }).end(hit.body);
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());

function person(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: "", disabled: 0, created_at: "", groups: [], isAdmin: false } as Identity;
}
const ana = person("Ana"),
  ben = person("Ben"),
  stranger = person("Fremd");
const wid = createWorkspace(ana.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const version = () => one<{ avatar: string | null }>("SELECT avatar FROM users WHERE id=?", ana.id)?.avatar;

test("only real raster images are recognised", () => {
  assert.equal(sniffImage(png), "image/png");
  assert.equal(sniffImage(Buffer.from("<svg/>")), null);
});

test("the picture claim is stored once, shared with co-members only, and removed with the claim", async () => {
  await syncAvatar(ana.id, `${base}/me.png`);
  const first = version();
  assert.match(String(first), /^[0-9a-f]{16}$/);
  assert.deepEqual(Buffer.from(avatarFor(ben, ana.id)!.data), png);
  assert.equal(avatarFor(ben, ana.id)!.mime, "image/png");
  assert.equal(avatarFor(stranger, ana.id), null, "no shared workspace");
  // A failing or unsafe picture keeps the previous one.
  await syncAvatar(ana.id, `${base}/evil.svg`);
  await syncAvatar(ana.id, `${base}/huge.png`);
  await syncAvatar(ana.id, `${base}/missing.png`);
  await syncAvatar(ana.id, "javascript:alert(1)");
  assert.equal(version(), first);
  // The provider stops sending a picture: back to initials.
  await syncAvatar(ana.id, undefined);
  assert.equal(version(), null);
  assert.equal(avatarFor(ben, ana.id), null);
});

test("pictures from internal addresses are refused without the local test switch", async () => {
  const before = version();
  let requests = 0;
  const probe = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "Content-Type": "image/png" }).end(png);
  });
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  delete process.env.OIDC_ALLOW_LOCAL_HTTP;
  try {
    await syncAvatar(ana.id, `http://127.0.0.1:${port}/me.png`);
    await syncAvatar(ana.id, `https://127.0.0.1:${port}/me.png`);
    await syncAvatar(ana.id, `https://localhost:${port}/me.png`);
    await syncAvatar(ana.id, "https://169.254.169.254/latest/meta-data/");
  } finally {
    process.env.OIDC_ALLOW_LOCAL_HTTP = "true";
    probe.close();
  }
  assert.equal(requests, 0, "no request reached the internal server");
  assert.equal(version(), before);
});
