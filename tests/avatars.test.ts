import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
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
// Not closed in an after() hook: node:test may run a top-level hook while
// the file still awaits between tests, and later tests would find the
// server gone. unref() lets the process end without it.
server.unref();

async function person(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: "", disabled: 0, created_at: "", groups: [], isAdmin: false } as Identity;
}
const ana = await person("Ana"),
  ben = await person("Ben"),
  stranger = await person("Fremd");
const wid = await createWorkspace(ana.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const version = async () => (await one<{ avatar: string | null }>("SELECT avatar FROM users WHERE id=?", ana.id))?.avatar;

test("only real raster images are recognised", () => {
  assert.equal(sniffImage(png), "image/png");
  assert.equal(sniffImage(Buffer.from("<svg/>")), null);
});

test("the picture claim is stored once, shared with co-members only, and removed with the claim", async () => {
  await syncAvatar(ana.id, `${base}/me.png`);
  const first = await version();
  assert.match(String(first), /^[0-9a-f]{16}$/);
  assert.deepEqual(Buffer.from((await avatarFor(ben, ana.id))!.data), png);
  assert.equal((await avatarFor(ben, ana.id))!.mime, "image/png");
  assert.equal(await avatarFor(stranger, ana.id), null, "no shared workspace");
  // A failing or unsafe picture keeps the previous one.
  await syncAvatar(ana.id, `${base}/evil.svg`);
  await syncAvatar(ana.id, `${base}/huge.png`);
  await syncAvatar(ana.id, `${base}/missing.png`);
  await syncAvatar(ana.id, "javascript:alert(1)");
  assert.equal(await version(), first);
  // The provider stops sending a picture: back to initials.
  await syncAvatar(ana.id, undefined);
  assert.equal(await version(), null);
  assert.equal(await avatarFor(ben, ana.id), null);
});

test("pictures from internal addresses are refused without the local test switch", async () => {
  const before = await version();
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
  assert.equal(await version(), before);
});

// Own pictures of local accounts (#559): POST/DELETE /api/avatars.
const { uploadAvatar, deleteAvatar, AVATAR_MAX_BYTES } = await import("../lib/avatars");
const local = await person("Lea");
await run("INSERT INTO local_accounts(user_id,email,password_hash,created_at) VALUES(?,?,?,?)", local.id, `${local.id}@example.test`, "x", Date.now());
await run("INSERT INTO members VALUES(?,?,?)", wid, local.id, "editor");
const versionOf = async (uid: string) => (await one<{ avatar: string | null }>("SELECT avatar FROM users WHERE id=?", uid))?.avatar ?? null;
const upload = (data: Uint8Array | string, type = "image/png") =>
  new Request("https://flowplan.example.test/api/avatars", { method: "POST", body: typeof data === "string" ? data : new Uint8Array(data), headers: { "content-type": type } });
const status = (code: number) => (e: unknown) => (e as { status?: number }).status === code;

test("a local account uploads its own picture; the type comes from the bytes, the version changes", async () => {
  // Sent as text/plain: the declared type does not matter.
  const answer = await uploadAvatar(local, upload(png, "text/plain"));
  assert.match(String(answer.avatar), /^[0-9a-f]{16}$/);
  assert.equal(await versionOf(local.id), answer.avatar);
  const seen = await avatarFor(ana, local.id);
  assert.equal(seen!.mime, "image/png");
  assert.deepEqual(Buffer.from(seen!.data), png);
  // Another picture: another version, so ?v= loads it afresh.
  const gif = Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "hex");
  const second = await uploadAvatar(local, upload(gif));
  assert.notEqual(second.avatar, answer.avatar);
  assert.equal((await avatarFor(ana, local.id))!.mime, "image/gif");
});

test("not an image, an SVG or an empty body: 400; above 2 MB: 413; the picture stays", async () => {
  const before = await versionOf(local.id);
  await assert.rejects(uploadAvatar(local, upload("<svg onload=alert(1)>", "image/svg+xml")), status(400));
  await assert.rejects(uploadAvatar(local, upload("just text")), status(400));
  await assert.rejects(uploadAvatar(local, upload(new Uint8Array(0))), status(400));
  await assert.rejects(uploadAvatar(local, upload(Buffer.concat([png, Buffer.alloc(AVATAR_MAX_BYTES)]))), status(413));
  // Also without Content-Length (chunked): stopped while it is read.
  const chunks = [png, Buffer.alloc(AVATAR_MAX_BYTES)];
  const stream = new ReadableStream<Uint8Array>({ pull: (c) => (chunks.length ? c.enqueue(new Uint8Array(chunks.shift()!)) : c.close()) });
  const chunked = new Request("https://flowplan.example.test/api/avatars", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  await assert.rejects(uploadAvatar(local, chunked), status(413));
  assert.equal(await versionOf(local.id), before);
});

test("accounts of an identity provider and API tokens are refused", async () => {
  // Ana has no local account (SSO): her picture comes from the provider.
  await syncAvatar(ana.id, `${base}/me.png`);
  const before = await versionOf(ana.id);
  assert.notEqual(before, null);
  await assert.rejects(uploadAvatar(ana, upload(png)), status(403));
  await assert.rejects(deleteAvatar(ana), status(403));
  assert.equal(await versionOf(ana.id), before);
  for (const apiScope of ["write", "read", "clipper"] as const) {
    await assert.rejects(uploadAvatar({ ...local, apiScope }, upload(png)), status(403), apiScope);
    await assert.rejects(deleteAvatar({ ...local, apiScope }), status(403), apiScope);
  }
  assert.notEqual(await versionOf(local.id), null);
});

test("a local account removes its picture: back to the initials", async () => {
  assert.deepEqual(await deleteAvatar(local), { avatar: null });
  assert.equal(await versionOf(local.id), null);
  assert.equal(await avatarFor(ana, local.id), null);
  // Removing again does no harm.
  assert.deepEqual(await deleteAvatar(local), { avatar: null });
});

test("the routes: POST and DELETE /api/avatars in the general handler, DELETE behind the origin check", () => {
  const source = readFileSync(join(import.meta.dirname, "../app/api/[...path]/handler.ts"), "utf8");
  assert.match(source, /path\[0\] === "avatars"\)\s*return NextResponse\.json\(await uploadAvatar\(user, req\)/);
  const del = source.slice(source.indexOf("async function handleDELETE"));
  assert.match(del, /await checkOrigin\(req\);\s*const user = await requireUser\(\);\s*return NextResponse\.json\(await deleteAvatar\(user\)/);
});
