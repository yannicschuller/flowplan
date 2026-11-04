// Instance move (lib/instance-move.ts, lib/instance-move-pull.ts,
// lib/instance-read-only.ts, app/api/move): the move token's life, the
// token-only endpoints, the resumable transfer with checksums, the
// configuration report (names and keyed hashes only), read-only mode,
// apply on restart, and internal addresses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import type { Identity } from "../lib/types";

const dir = mkdtempSync(join(tmpdir(), "flowplan-instance-move-"));
process.env.FLOWPLAN_DATA_DIR = dir;
process.env.APP_URL = "https://old.example.test";
const { run, one, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const move = await import("../lib/instance-move");
const pull = await import("../lib/instance-move-pull");
const { readOnlyRefusal, readOnlyState, MOVE_KEY } = await import("../lib/instance-read-only");
const { checkOrigin, HttpError, hash } = await import("../lib/auth");
const { applyPendingRestore } = await import("../lib/instance-restore-apply");
const { hashPassword } = await import("../lib/local-auth");
const route = await import("../app/api/move/[...path]/route");
const { handleCalDav } = await import("../lib/caldav");

function admin(name = "admin"): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `${name}:${uid}`, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, groups: ["flowplan-admins"], isAdmin: true, disabled: 0, created_at: "" } as Identity;
}
const owner = admin("owner");
const wid = createWorkspace(owner.id, "Umzug");
const space = bootstrap(owner, wid).spaces[0].id;
const pageId = (command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Vor dem Umzug" }) as { id: string }).id;
const uploads = join(dir, "uploads");
mkdirSync(uploads, { recursive: true });
const big = Buffer.alloc(300_000, 7);
for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
const bigId = id(),
  smallId = id();
writeFileSync(join(uploads, bigId), big);
writeFileSync(join(uploads, smallId), "Anhang");
writeFileSync(join(dir, "web-push-keys.json"), JSON.stringify({ publicKey: "pub", privateKey: "priv" }));

// The move endpoints behind a real HTTP server, as the target reaches them.
type Served = { server: Server; url: string; requests: { path: string; range: string; bytes: number }[]; close: () => Promise<void> };
async function serve(): Promise<Served> {
  const requests: Served["requests"] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const path = url.pathname.replace(/^\/api\/move\//, "").split("/").filter(Boolean);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
    const response = await (req.method === "POST" ? route.POST : route.GET)(request, { params: Promise.resolve({ path }) });
    const record = { path: url.pathname, range: String(req.headers.range || ""), bytes: 0 };
    requests.push(record);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body)
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        record.bytes += chunk.length;
        res.write(chunk);
      }
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, requests, close: () => new Promise((done) => server.close(() => done())) };
}
const asSource = (url: string, token: string) => ({ url, token, allowHttp: true });
const call = (method: "GET" | "POST", path: string, token = "", extra: Record<string, string> = {}, body?: string) =>
  (method === "POST" ? route.POST : route.GET)(
    new Request(`http://127.0.0.1/api/move/${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body }),
    { params: Promise.resolve({ path: path.split("?")[0].split("/") }) },
  );

test("move tokens: stored only as hash, one at a time, expire, revocable, used up by the move", async () => {
  const first = move.prepareMove(owner);
  assert.match(first.token, /^fpmove_[A-Za-z0-9_-]{43}$/);
  assert.equal(first.url, "https://old.example.test");
  const stored = one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", MOVE_KEY)!.value;
  assert.ok(!stored.includes(first.token), "the token itself is never stored");
  assert.equal(JSON.parse(stored).hash, hash(first.token));
  assert.ok(one("SELECT 1 FROM audit WHERE action='instance.move.prepare'"), "audit log entry");
  assert.equal((await call("GET", "env", first.token)).status, 200);
  // A new token replaces the earlier one.
  const second = move.prepareMove(owner);
  assert.equal((await call("GET", "env", first.token, { "x-forwarded-for": "198.51.100.1" })).status, 401);
  assert.equal((await call("GET", "env", second.token)).status, 200);
  // Expiry: 24 hours.
  const state = JSON.parse(one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", MOVE_KEY)!.value);
  assert.equal(state.expiresAt - state.createdAt, 24 * 3_600_000);
  assert.throws(() => move.authorizeMove(new Request("http://x/", { headers: { authorization: `Bearer ${second.token}`, "x-forwarded-for": "198.51.100.2" } }), "env", state.expiresAt + 1), /abgelaufen/);
  // Revocation.
  move.revokeMove(owner);
  assert.equal((await call("GET", "env", second.token, { "x-forwarded-for": "198.51.100.3" })).status, 401);
  assert.equal(move.moveSourceStatus().token!.active, false);
  // Used up by the move.
  const third = move.prepareMove(owner);
  const finished = await call("POST", "finish", third.token, { "content-type": "application/json" }, JSON.stringify({ target: "https://new.example.test/path" }));
  assert.equal(finished.status, 200);
  assert.equal(readOnlyState().movedTo, "https://new.example.test");
  assert.equal((await call("GET", "manifest", third.token, { "x-forwarded-for": "198.51.100.4" })).status, 401);
  move.unfreezeSource(owner);
  assert.equal(readOnlyState().readOnly, false);
});

test("move endpoints answer only to a valid move token and lock out guessing", async () => {
  const { token } = move.prepareMove(owner);
  for (const path of ["manifest", "env", `file/${smallId}`, "extra/web-push-keys.json", "database?snapshot=00000000-0000-0000-0000-000000000000"]) {
    assert.equal((await call("GET", path, "", { "x-forwarded-for": "203.0.113.50" })).status, 401, path);
    // A session cookie or an API token is no move token.
    assert.equal((await call("GET", path, "", { cookie: "flowplan_session=abc", authorization: "Bearer fp_123", "x-forwarded-for": "203.0.113.51" })).status, 401, path);
  }
  assert.equal((await call("POST", "freeze", "fpmove_wrong", { "x-forwarded-for": "203.0.113.52" })).status, 401);
  assert.equal(readOnlyState().readOnly, false);
  // Ten failures from one address within 15 minutes: refused even with the right token.
  for (let i = 0; i < 10; i++) await call("GET", "env", `fpmove_guess${i}`, { "x-forwarded-for": "203.0.113.60" });
  assert.equal((await call("GET", "env", token, { "x-forwarded-for": "203.0.113.60" })).status, 429);
  assert.equal((await call("GET", "env", token, { "x-forwarded-for": "203.0.113.61" })).status, 200);
  // Only uploads and the two key files, nothing else of the data folder.
  assert.equal((await call("GET", "extra/flowplan.sqlite", token)).status, 404);
  assert.equal((await call("GET", "file/..%2Fflowplan.sqlite", token)).status, 404);
  assert.equal((await call("GET", "file/does-not-exist", token)).status, 404);
  // Manifests per hour are limited.
  const s = JSON.parse(one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", MOVE_KEY)!.value);
  const req = () => new Request("http://x/", { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.70" } });
  for (let i = 0; i < 30; i++) move.authorizeMove(req(), "manifest", s.createdAt + 1000);
  assert.throws(() => move.authorizeMove(req(), "manifest", s.createdAt + 1000), (e: unknown) => e instanceof HttpError && e.status === 429);
});

test("files are served with ranges; the transfer resumes and checks every checksum", async () => {
  const { token } = move.prepareMove(owner);
  const ranged = await call("GET", `file/${bigId}`, token, { range: "bytes=1000-" });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), `bytes 1000-${big.length - 1}/${big.length}`);
  assert.equal(Buffer.from(await ranged.arrayBuffer()).compare(big.subarray(1000)), 0);
  assert.equal((await call("GET", `file/${bigId}`, token, { range: "bytes=0-10" })).status, 416);
  const served = await serve();
  try {
    const target = mkdtempSync(join(tmpdir(), "flowplan-move-file-"));
    const sha = await pull.fileSha256(join(uploads, bigId));
    // An interrupted download: 100 000 bytes are already there.
    writeFileSync(join(target, "big.part"), big.subarray(0, 100_000));
    const transferred = await pull.downloadFile(asSource(served.url, token), `/api/move/file/${bigId}`, join(target, "big"), { size: big.length, sha256: sha });
    assert.equal(transferred, big.length - 100_000);
    assert.equal(served.requests.at(-1)!.range, "bytes=100000-");
    assert.equal(readFileSync(join(target, "big")).compare(big), 0);
    assert.ok(!existsSync(join(target, "big.part")));
    // A wrong checksum never takes the file's place.
    await assert.rejects(pull.downloadFile(asSource(served.url, token), `/api/move/file/${bigId}`, join(target, "bad"), { size: big.length, sha256: "0".repeat(64) }), /Prüfsumme/);
    assert.ok(!existsSync(join(target, "bad")) && !existsSync(join(target, "bad.part")));
    // A corrupted partial file is caught as well.
    const broken = Buffer.from(big.subarray(0, 50_000));
    broken[10] ^= 1;
    writeFileSync(join(target, "corrupt.part"), broken);
    await assert.rejects(pull.downloadFile(asSource(served.url, token), `/api/move/file/${bigId}`, join(target, "corrupt"), { size: big.length, sha256: sha }), /Prüfsumme/);
    rmSync(target, { recursive: true, force: true });
  } finally {
    await served.close();
  }
});

test("the whole pull: snapshot without the move state, resumable, final sync fetches only what changed", async () => {
  const { token } = move.prepareMove(owner);
  const served = await serve();
  const staging = mkdtempSync(join(tmpdir(), "flowplan-move-staging-"));
  try {
    const progress: number[] = [];
    const first = await pull.pullInstance(asSource(served.url, token), staging, { onProgress: (p) => progress.push(p.bytesDone) });
    assert.equal(first.manifest.files.length, 2);
    assert.deepEqual(first.manifest.extras.map((f) => f.name), ["web-push-keys.json"]);
    assert.equal(readFileSync(join(staging, "uploads", bigId)).compare(big), 0);
    assert.equal(first.progress.bytesDone, first.progress.bytesTotal);
    assert.equal(first.progress.filesDone, 3);
    assert.ok(progress.length > 1);
    // The snapshot leaves out the token and the read-only state.
    const copy = new DatabaseSync(join(staging, "flowplan.sqlite"), { readOnly: true });
    assert.equal(copy.prepare("SELECT count(*) n FROM instance_settings WHERE key=?").get(MOVE_KEY)!.n, 0);
    assert.equal((copy.prepare("SELECT title FROM pages WHERE id=?").get(pageId) as { title: string }).title, "Vor dem Umzug");
    copy.close();
    // Interrupted in the middle of a file: only the rest is fetched again.
    rmSync(join(staging, "uploads", bigId));
    writeFileSync(join(staging, "uploads", `${bigId}.part`), big.subarray(0, 120_000));
    const state = JSON.parse(readFileSync(join(staging, "state.json"), "utf8"));
    delete state.done[`uploads/${bigId}`];
    writeFileSync(join(staging, "state.json"), JSON.stringify(state));
    served.requests.length = 0;
    // The source becomes read-only for the final sync; meanwhile one file
    // was added and one removed.
    command(owner, { action: "page.update", pageId, patch: { title: "Kurz vor dem Umzug" } });
    const newId = id();
    writeFileSync(join(uploads, newId), "neu");
    rmSync(join(uploads, smallId));
    assert.equal((await call("POST", "freeze", token)).status, 200);
    assert.equal(readOnlyState().readOnly, true);
    const final = await pull.pullInstance(asSource(served.url, token), staging);
    const fetched = served.requests.filter((r) => r.path.startsWith("/api/move/file/")).map((r) => [r.path.slice(15), r.range]);
    assert.deepEqual(fetched.sort(), [[bigId, "bytes=120000-"], [newId, ""]].sort());
    assert.ok(!existsSync(join(staging, "uploads", smallId)), "removed at the source, removed here");
    assert.equal(final.manifest.readOnly, true);
    const summary = pull.checkStagedDatabase(staging, final.manifest, served.url);
    assert.deepEqual([summary.files, summary.kind], [2, "move"]);
    const again = new DatabaseSync(join(staging, "flowplan.sqlite"), { readOnly: true });
    assert.equal((again.prepare("SELECT title FROM pages WHERE id=?").get(pageId) as { title: string }).title, "Kurz vor dem Umzug");
    assert.equal(again.prepare("SELECT count(*) n FROM instance_settings WHERE key=?").get(MOVE_KEY)!.n, 0, "the copy is not read-only");
    again.close();
    // Applied on the next start of the target, keeping a pre-move copy.
    const targetDir = mkdtempSync(join(tmpdir(), "flowplan-move-target-"));
    const before = new DatabaseSync(join(targetDir, "flowplan.sqlite"));
    before.exec("CREATE TABLE marker(x); INSERT INTO marker VALUES(1);");
    before.close();
    mkdirSync(join(targetDir, "uploads"));
    writeFileSync(join(targetDir, "web-push-keys.json"), "{\"own\":true}");
    pull.stageMove(targetDir, staging, summary);
    assert.ok(existsSync(join(targetDir, "restore-pending", "MOVE")) && !existsSync(staging));
    assert.ok(!existsSync(join(targetDir, "restore-pending", "state.json")));
    const previous = applyPendingRestore(targetDir)!;
    assert.match(previous, /pre-move-/);
    assert.ok(existsSync(join(previous, "flowplan.sqlite")) && existsSync(join(previous, "web-push-keys.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(targetDir, "web-push-keys.json"), "utf8")), { publicKey: "pub", privateKey: "priv" });
    assert.deepEqual(readdirSync(join(targetDir, "uploads")).sort(), [bigId, newId].sort());
    assert.ok(!existsSync(join(targetDir, "restore-pending")));
    rmSync(targetDir, { recursive: true, force: true });
  } finally {
    rmSync(join(uploads, readdirSync(uploads).find((n) => n !== bigId) || "none"), { force: true });
    writeFileSync(join(uploads, smallId), "Anhang");
    move.unfreezeSource(owner);
    rmSync(staging, { recursive: true, force: true });
    await served.close();
  }
});

test("the configuration report holds names and keyed hashes – never a value", async () => {
  const secret = "s3cr3t-value-that-must-not-leak";
  const env = { APP_URL: "https://old.example.test", S3_SECRET_ACCESS_KEY: secret, S3_BUCKET: "bucket", S3_ENDPOINT: "https://fsn1.your-objectstorage.com", SMTP_PASSWORD: secret, OIDC_ISSUER: "https://id.example.test", OIDC_CLIENT_ID: "flowplan", SESSION_INGRESS_URL: "https://other", HOME: "/root" };
  const logs: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  let report;
  try {
    report = move.envReport("fpmove_one", env);
  } finally {
    Object.assign(console, original);
  }
  const text = JSON.stringify(report);
  assert.ok(!text.includes(secret) && !text.includes("bucket\"") && !text.includes("id.example.test"));
  assert.ok(!logs.join("\n").includes(secret));
  assert.equal(report.appUrl, "https://old.example.test");
  assert.equal(report.vars.SMTP_HOST, undefined);
  assert.equal(report.vars.FLOWPLAN_SECRETS_KEY, null, "known names are reported as missing");
  assert.ok(!("SESSION_INGRESS_URL" in report.vars) && !("HOME" in report.vars), "other variables of the container are left out");
  assert.match(report.vars.S3_SECRET_ACCESS_KEY!, /^[A-Za-z0-9_-]{43}$/);
  // Keyed with the token: another move gives other hashes.
  assert.notEqual(move.envReport("fpmove_two", env).vars.S3_SECRET_ACCESS_KEY, report.vars.S3_SECRET_ACCESS_KEY);
  // Through the endpoint as well.
  const { token } = move.prepareMove(owner);
  process.env.SMTP_PASSWORD = secret;
  try {
    const answer = await (await call("GET", "env", token)).text();
    assert.ok(!answer.includes(secret));
  } finally {
    delete process.env.SMTP_PASSWORD;
  }
});

test("the pre-flight check flags keys, address, missing settings and a shared bucket", () => {
  const key = Buffer.alloc(32, 1).toString("base64"),
    other = Buffer.alloc(32, 2).toString("base64");
  const base = { APP_URL: "https://flowplan.example.test", S3_BUCKET: "b", S3_ENDPOINT: "https://e", OIDC_ISSUER: "https://id", OIDC_CLIENT_ID: "c" };
  const report = (env: Record<string, string>) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    for (const k of ["FLOWPLAN_ENCRYPTION_KEY", "FLOWPLAN_ENCRYPTION_KEY_PREVIOUS"]) if (!(k in env)) delete process.env[k];
    try {
      return move.envReport("fpmove_x", env);
    } finally {
      process.env = saved;
    }
  };
  const level = (items: ReturnType<typeof move.comparePreflight>, id: string) => items.find((i) => i.id === id);
  const same = move.comparePreflight(report({ ...base, FLOWPLAN_ENCRYPTION_KEY: key }), report({ ...base, FLOWPLAN_ENCRYPTION_KEY: key }));
  assert.equal(level(same, "encryption")!.code, "encryption.same");
  assert.equal(level(same, "secrets")!.level, "ok");
  assert.equal(level(same, "url")!.code, "url.same");
  assert.equal(level(same, "s3.bucket")!.level, "warn", "same bucket and prefix on both sides");
  const missing = move.comparePreflight(report({ ...base, FLOWPLAN_ENCRYPTION_KEY: key }), report({ APP_URL: "https://new.example.test" }));
  assert.deepEqual([level(missing, "encryption")!.level, level(missing, "encryption")!.code], ["error", "encryption.missing"]);
  assert.deepEqual([level(missing, "secrets")!.level, level(missing, "secrets")!.code], ["error", "secrets.missing"]);
  assert.deepEqual([level(missing, "url")!.level, level(missing, "url")!.target], ["warn", "https://new.example.test"]);
  assert.equal(level(missing, "env.oidc")!.level, "error");
  assert.deepEqual(level(missing, "env.s3")!.missing, ["S3_BUCKET", "S3_ENDPOINT"]);
  const differs = move.comparePreflight(report({ ...base, FLOWPLAN_ENCRYPTION_KEY: key }), report({ ...base, FLOWPLAN_ENCRYPTION_KEY: other }));
  assert.equal(level(differs, "encryption")!.code, "encryption.differs");
  const rotated = move.comparePreflight(report({ ...base, FLOWPLAN_ENCRYPTION_KEY: key }), report({ ...base, FLOWPLAN_ENCRYPTION_KEY: other, FLOWPLAN_ENCRYPTION_KEY_PREVIOUS: key }));
  assert.equal(level(rotated, "encryption")!.code, "encryption.previous");
  // The generated secrets.key moves along, so stored secrets stay readable.
  const fileKey = move.comparePreflight(report(base), report(base));
  assert.equal(level(fileKey, "secrets")!.level, "ok");
  // A database from newer code than the target's.
  const a = report(base),
    b = report(base);
  assert.equal(move.comparePreflight({ ...a, schema: b.schema + 1 }, b).find((i) => i.id === "schema")!.level, "error");
});

test("read-only mode refuses changes with 423 and lets reads and sign-in through", async () => {
  const { token } = move.prepareMove(owner);
  assert.equal(readOnlyRefusal("/api/command"), null);
  await call("POST", "freeze", token);
  assert.match(readOnlyRefusal("/api/command")!, /schreibgeschützt/);
  for (const free of ["/api/auth/login", "/api/auth/logout", "/api/auth/callback", "/api/admin/instance-move", "/api/move/finish", "/api/presence"]) assert.equal(readOnlyRefusal(free), null, free);
  for (const blocked of ["/api/auth/password-change", "/api/files", "/api/forms/x", "/api/mobile/capture/save"]) assert.ok(readOnlyRefusal(blocked), blocked);
  const request = (path: string, headers: Record<string, string> = { origin: "https://old.example.test" }) => new Request(`https://old.example.test${path}`, { method: "POST", headers });
  assert.throws(() => checkOrigin(request("/api/command")), (e: unknown) => e instanceof HttpError && e.status === 423);
  // API tokens too.
  assert.throws(() => checkOrigin(request("/api/command", { authorization: "Bearer fp_x" })), (e: unknown) => e instanceof HttpError && e.status === 423);
  assert.doesNotThrow(() => checkOrigin(request("/api/auth/login")));
  // Reads still work.
  assert.equal(bootstrap(owner, wid).spaces.length > 0, true);
  // Calendar apps cannot write.
  const caldav = await handleCalDav(new Request("https://old.example.test/api/caldav/calendars/x/y.ics", { method: "PUT", headers: { authorization: "Basic " + Buffer.from("a:b").toString("base64") }, body: "BEGIN:VCALENDAR" }));
  assert.ok(caldav.status === 401 || caldav.status === 403);
  // After the move: the message names the new address.
  await call("POST", "finish", token, {}, JSON.stringify({ target: "https://new.example.test" }));
  assert.match(readOnlyRefusal("/api/command")!, /umgezogen nach https:\/\/new\.example\.test/);
  move.setMoveRedirect(owner, true);
  assert.equal(readOnlyState().redirect, true);
  move.unfreezeSource(owner);
  assert.deepEqual(readOnlyState(), { readOnly: false, movedTo: null, redirect: false });
  assert.doesNotThrow(() => checkOrigin(request("/api/command")));
});

test("step-up: password for password accounts, a fresh sign-in for SSO, never an API token", async () => {
  const local = admin("local");
  run("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,created_at) VALUES(?,?,?,?,?,?)", local.id, local.email, await hashPassword("korrekt-pferd-batterie"), 1, 1, Date.now());
  const req = (cookie = "") => new Request("https://old.example.test/api/admin/instance-move", { headers: cookie ? { cookie } : {} });
  await assert.rejects(move.requireStepUp(local, req(), "", "de"), /Passwort/);
  await assert.rejects(move.requireStepUp(local, req(), "falsch", "de"), (e: unknown) => e instanceof HttpError && e.status === 401);
  assert.equal(await move.requireStepUp(local, req(), "korrekt-pferd-batterie", "de"), "password");
  assert.equal(move.stepUpKind(local), "password");
  const sso = admin("sso");
  assert.equal(move.stepUpKind(sso), "recent-sign-in");
  const session = (created: number) => {
    const token = id();
    run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at) VALUES(?,?,?,?,?)", hash(token), sso.id, "[]", Date.now() + 3_600_000, created);
    return `flowplan_session=${token}`;
  };
  await assert.rejects(move.requireStepUp(sso, req(session(Date.now() - 20 * 60_000)), "", "de"), /erneut an/);
  assert.equal(await move.requireStepUp(sso, req(session(Date.now() - 60_000)), "", "de"), "recent-sign-in");
  await assert.rejects(move.requireStepUp({ ...sso, apiScope: "write" }, req(session(Date.now())), "", "de"), /API-Token/);
});

test("the target refuses internal addresses unless FLOWPLAN_MOVE_ALLOW_PRIVATE=true, and runs the whole move from another instance", async () => {
  // The source: a second instance in its own process and data folder.
  const child = spawn(process.execPath, ["--import", "tsx", "--import", "./tests/helpers/cleanup.mjs", "tests/helpers/move-source-server.ts"], { stdio: ["ignore", "pipe", "inherit"] });
  const other = await new Promise<{ url: string; token: string; pageId: string; fileId: string }>((done, fail) => {
    let text = "";
    child.stdout!.on("data", (c: Buffer) => {
      text += c.toString();
      if (text.includes("\n")) done(JSON.parse(text.split("\n")[0]));
    });
    child.once("exit", (code) => fail(new Error(`source exited with ${code}`)));
  });
  const sourceState = async () => (await (await fetch(`${other.url}/state`)).json()) as { readOnly: boolean; movedTo: string | null };
  const target = admin("target");
  try {
    delete process.env.FLOWPLAN_MOVE_ALLOW_PRIVATE;
    await assert.rejects(move.startIncoming(target, { url: other.url, token: other.token, confirm: true }), /https:\/\//);
    await assert.rejects(move.startIncoming(target, { url: "https://127.0.0.1:1", token: other.token, confirm: true }), /FLOWPLAN_MOVE_ALLOW_PRIVATE/);
    await assert.rejects(move.startIncoming(target, { url: "https://[::1]:1", token: other.token, confirm: true }), /FLOWPLAN_MOVE_ALLOW_PRIVATE/);
    await assert.rejects(move.startIncoming(target, { url: "https://10.1.2.3:1", token: other.token, confirm: true }), /FLOWPLAN_MOVE_ALLOW_PRIVATE/);
    // A name that resolves to an internal address is refused at the lookup.
    await assert.rejects(move.startIncoming(target, { url: "https://localhost:1", token: other.token, confirm: true }), /Interne Adressen/);
    process.env.FLOWPLAN_MOVE_ALLOW_PRIVATE = "true";
    // Not an empty instance: only with confirmation.
    assert.equal(move.instanceContent().fresh, false);
    await assert.rejects(move.startIncoming(target, { url: other.url, token: other.token }), /bestätige/);
    await assert.rejects(move.startIncoming(target, { url: other.url, token: "fpmove_" + "x".repeat(43), confirm: true }), /Umzugstoken/);
    // This instance's own token: it would pull from itself.
    const own = move.prepareMove(owner);
    await assert.rejects(move.startIncoming(target, { url: "https://old.example.test", token: own.token, confirm: true }), /dieser Instanz/);
    move.revokeMove(owner);
    // The whole move.
    await move.startIncoming(target, { url: other.url, token: other.token, confirm: true });
    await move.moveJobDone();
    const status = move.moveTargetStatus();
    assert.ok(status.incoming!.firstCopyAt, status.incoming!.error || "");
    await assert.rejects(move.applyIncoming(target), /letzten Stand/);
    const report = await move.preflight();
    assert.ok(report.items.some((i) => i.id === "encryption") && report.items.some((i) => i.id === "reach.smtp"));
    assert.equal(report.items.find((i) => i.id === "url")!.level, "warn", "source.example.test → old.example.test");
    assert.ok(!JSON.stringify(report).includes(other.token));
    assert.equal((await sourceState()).readOnly, false);
    await move.finalSync(target);
    assert.equal((await sourceState()).readOnly, true, "the source is read-only for the final sync");
    assert.equal(readOnlyState().readOnly, false, "the target is not");
    await move.moveJobDone();
    assert.ok(move.moveTargetStatus().incoming!.finalAt);
    const applied = await move.applyIncoming(target);
    assert.equal(applied.notified, true);
    assert.deepEqual([applied.summary.pages >= 1, applied.summary.files], [true, 1]);
    assert.ok(existsSync(join(dir, "restore-pending", "READY")) && existsSync(join(dir, "restore-pending", "MOVE")));
    assert.equal(readFileSync(join(dir, "restore-pending", "uploads", other.fileId), "utf8"), "Datei der Quelle");
    const staged = new DatabaseSync(join(dir, "restore-pending", "flowplan.sqlite"), { readOnly: true });
    assert.equal((staged.prepare("SELECT title FROM pages WHERE id=?").get(other.pageId) as { title: string }).title, "Auf der Quelle");
    staged.close();
    assert.equal((await sourceState()).movedTo, "https://old.example.test", "the source learnt the target's address");
    assert.ok(one("SELECT 1 FROM audit WHERE action='instance.move.applied'"));
    // The token is used up.
    await assert.rejects(pull.moveJson(asSource(other.url, other.token), "/api/move/env"), /Umzugstoken/);
  } finally {
    delete process.env.FLOWPLAN_MOVE_ALLOW_PRIVATE;
    rmSync(join(dir, "restore-pending"), { recursive: true, force: true });
    move.cancelIncoming(target);
    child.kill("SIGTERM");
  }
});
