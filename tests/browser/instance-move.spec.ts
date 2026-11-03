import { test, expect } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Instance move end to end with two instances (two data folders, two
// ports): a workspace with a page and an upload moves from the source to
// the target. Two phases around a restart of the target, which applies
// the move:
//   TEST_BASE_URL / FLOWPLAN_DATA_DIR             source
//   TEST_TARGET_URL / TEST_TARGET_DATA_DIR         target (FLOWPLAN_MOVE_ALLOW_PRIVATE=true)
//   TEST_MOVE_STATE                               file shared by both phases
//   TEST_MOVE_PHASE=move | verify
const source = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const target = process.env.TEST_TARGET_URL || "";
const sourceDir = process.env.FLOWPLAN_DATA_DIR || "";
const targetDir = process.env.TEST_TARGET_DATA_DIR || "";
const stateFile = process.env.TEST_MOVE_STATE || "";
const phase = process.env.TEST_MOVE_PHASE || "move";
test.skip(!target || !sourceDir || !targetDir || !stateFile, "Needs two test servers (see the comment above).");
test.describe.configure({ mode: "serial" });

// An administrator session written straight into an instance's database.
function adminSession(dir: string, name: string) {
  const db = new DatabaseSync(join(dir, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `move-e2e:${uid}`, name, `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires,created_at) VALUES(?,?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 3_600_000, Date.now());
  db.close();
  return `flowplan_session=${token}`;
}
const call = async (origin: string, cookie: string, path: string, body?: unknown) => {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, origin, "accept-language": "de", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, data: (await response.json().catch(() => null)) as any };
};
async function until<T>(fn: () => Promise<T>, ok: (value: T) => boolean, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (ok(value)) return value;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(value)}`);
    await new Promise((done) => setTimeout(done, 500));
  }
}

test("phase 1: prepare on the source, pull, pre-flight, final sync and apply on the target", async () => {
  test.skip(phase !== "move");
  test.setTimeout(300_000);
  const cookie = adminSession(sourceDir, "Quelle Admin");
  // Opening the app creates the person's workspace.
  await fetch(`${source}/`, { headers: { cookie } });
  const boot = (await call(source, cookie, "/api/bootstrap")).data as { workspace: { id: string }; spaces: { id: string }[] };
  const title = `Umzug ${randomUUID().slice(0, 8)}`;
  const page = (await call(source, cookie, "/api/command", { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title })).data as { id: string };
  const content = randomBytes(256 * 1024);
  const form = new FormData();
  form.set("pageId", page.id);
  form.set("file", new Blob([content], { type: "application/octet-stream" }), "anhang.bin");
  const upload = await fetch(`${source}/api/upload`, { method: "POST", headers: { cookie, origin: source }, body: form });
  expect(upload.status).toBe(200);
  const file = (await upload.json()) as { id: string };
  // Only administrators, and only with the move token.
  const nobody = await fetch(`${source}/api/admin/instance-move`);
  expect(nobody.status).toBe(401);
  expect((await fetch(`${source}/api/move/manifest`)).status).toBe(401);
  // The instance's Web Push keys move along (written on first use).
  if (!existsSync(join(sourceDir, "web-push-keys.json"))) writeFileSync(join(sourceDir, "web-push-keys.json"), JSON.stringify({ publicKey: "e2e-public", privateKey: "e2e-private" }));
  const prepared = await call(source, cookie, "/api/admin/instance-move", { action: "prepare" });
  expect(prepared.status).toBe(200);
  const token = prepared.data.token as string;
  expect(token).toMatch(/^fpmove_/);
  // The token is shown once: the status never contains it.
  expect(JSON.stringify((await call(source, cookie, "/api/admin/instance-move")).data)).not.toContain(token);
  // Target: a fresh instance with its first admin.
  const targetCookie = adminSession(targetDir, "Ziel Admin");
  expect(((await call(target, targetCookie, "/api/admin/instance-move")).data.target as { content: { fresh: boolean } }).content.fresh).toBe(true);
  const started = await call(target, targetCookie, "/api/admin/instance-move", { action: "start", url: source, token });
  expect(started.status, JSON.stringify(started.data)).toBe(200);
  const status = () => call(target, targetCookie, "/api/admin/instance-move").then((r) => r.data.target as { job: unknown; incoming: { firstCopyAt: number | null; finalAt: number | null; error: string | null } });
  const first = await until(status, (s) => !s.job && (!!s.incoming.firstCopyAt || !!s.incoming.error));
  expect(first.incoming.error).toBeNull();
  const preflight = await call(target, targetCookie, "/api/admin/instance-move", { action: "preflight" });
  expect(preflight.status).toBe(200);
  const items = preflight.data.items as { id: string; level: string }[];
  expect(items.find((i) => i.id === "encryption")).toBeTruthy();
  expect(items.find((i) => i.id === "url")?.level).toBe("warn");
  expect(JSON.stringify(preflight.data)).not.toContain(token);
  // A change after the first copy still arrives with the final sync.
  const late = `${title} – zuletzt`;
  expect((await call(source, cookie, "/api/command", { action: "page.update", pageId: page.id, patch: { title: late } })).status).toBe(200);
  expect((await call(target, targetCookie, "/api/admin/instance-move", { action: "final" })).status).toBe(200);
  // The source is read-only now: reads work, changes are refused with 423.
  const refused = await call(source, cookie, "/api/command", { action: "page.update", pageId: page.id, patch: { title: "zu spät" } });
  expect(refused.status).toBe(423);
  expect(refused.data.error).toContain("schreibgeschützt");
  expect((await call(source, cookie, `/api/pages/${page.id}`)).status).toBe(200);
  expect(((await call(source, cookie, "/api/maintenance")).data.move as { readOnly: boolean }).readOnly).toBe(true);
  const final = await until(status, (s) => !s.job && (!!s.incoming.finalAt || !!s.incoming.error));
  expect(final.incoming.error).toBeNull();
  const applied = await call(target, targetCookie, "/api/admin/instance-move", { action: "apply" });
  expect(applied.status, JSON.stringify(applied.data)).toBe(200);
  expect(applied.data.notified).toBe(true);
  expect(existsSync(join(targetDir, "restore-pending", "MOVE"))).toBe(true);
  // The source points to its new address; the token is used up.
  expect(((await call(source, cookie, "/api/maintenance")).data.move as { movedTo: string }).movedTo).toBe(new URL(target).origin);
  expect((await fetch(`${source}/api/move/env`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  const home = await (await fetch(`${source}/`, { headers: { cookie, "accept-language": "de" } })).text();
  expect(home).toContain('class="move-banner"');
  expect(home).toContain(new URL(target).origin);
  writeFileSync(stateFile, JSON.stringify({ cookie, page: page.id, title: late, file: file.id, sha: createHash("sha256").update(content).digest("hex") }));
});

test("phase 2: after the restart the target holds the moved instance", async () => {
  test.skip(phase !== "verify");
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as { cookie: string; page: string; title: string; file: string; sha: string };
  expect(existsSync(join(targetDir, "restore-pending"))).toBe(false);
  expect(readdirSync(targetDir).some((n) => n.startsWith("pre-move-"))).toBe(true);
  // The source's sessions came along: the same sign-in works on the target.
  const page = await call(target, state.cookie, `/api/pages/${state.page}`);
  expect(page.status).toBe(200);
  expect((page.data as { page?: { title: string }; title?: string }).page?.title ?? (page.data as { title?: string }).title).toBe(state.title);
  const file = await fetch(`${target}/api/files/${state.file}`, { headers: { cookie: state.cookie } });
  expect(file.status).toBe(200);
  expect(createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex")).toBe(state.sha);
  // The target is neither read-only nor holding the token.
  const move = (await call(target, state.cookie, "/api/maintenance")).data.move as { readOnly: boolean };
  expect(move.readOnly).toBe(false);
  expect((await call(target, state.cookie, "/api/command", { action: "page.update", pageId: state.page, patch: { title: `${state.title} (neu)` } })).status).toBe(200);
  // The web push keys moved too.
  expect(readFileSync(join(targetDir, "web-push-keys.json"), "utf8")).toBe(readFileSync(join(sourceDir, "web-push-keys.json"), "utf8"));
});
