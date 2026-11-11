// The form endpoint (app/api/forms/[token]/route.ts) called as Next.js
// does: read-only API tokens change nothing, and every uploaded file is
// charged to a storage bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-form-route-"));
process.env.APP_URL = "https://flowplan.example.test";
const { id, one, run } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { createApiToken } = await import("../lib/api-tokens");
const { formSettings } = await import("../lib/forms");
const { setUserLimits, userBytes } = await import("../lib/user-limits");
const route = await import("../app/api/forms/[token]/route");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function account(name: string) {
  const uid = id(),
    cookie = randomUUID();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", sha(cookie), uid, "[]", Date.now() + 3600_000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
  return { user, cookie: `flowplan_session=${cookie}` };
}
const owner = await account("form-owner"),
  viewer = await account("form-viewer");
const wid = await createWorkspace(owner.user.id, "Forms");
const sid = (await bootstrap(owner.user, wid)).spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.user.id, "viewer");
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner.user, body);
const dbId = (await act({ action: "page.create", workspaceId: wid, spaceId: sid, kind: "database", title: "Requests" })).id as string;
const d = await database(dbId);
await act({ action: "database.update", pageId: dbId, version: d.version, fields: [...d.fields, { id: "att", name: "Anhang", type: "files" }], views: d.views });
await act({ action: "form.update", pageId: dbId, enabled: true, internal: true, anonymous: false });
const formToken = (await formSettings(dbId))!.token;
const readToken = (await createApiToken(viewer.user, { name: "Lesen", scope: "read" })).token;
const writeToken = (await createApiToken(viewer.user, { name: "Schreiben", scope: "write" })).token;

const origin = { origin: "https://flowplan.example.test" };
const ctx = () => ({ params: Promise.resolve({ token: formToken }) });
const url = `https://flowplan.example.test/api/forms/${formToken}`;
const json = (method: string, headers: Record<string, string>, body?: unknown) =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json", ...(body === undefined ? {} : { "content-length": String(JSON.stringify(body).length) }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const rowCount = async () => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=?", dbId))!.n);
const drafts = async (userId: string) => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM form_drafts WHERE user_id=?", userId))!.n);

test("a read-only API token can neither answer a form nor save or discard a draft", async () => {
  const bearer = { authorization: `Bearer ${readToken}` };
  const before = await rowCount();
  const answer = await route.POST(json("POST", bearer, { cells: { title: "Per Lese-Token" } }), ctx());
  assert.equal(answer.status, 403);
  assert.equal(await rowCount(), before);
  const put = await route.PUT(json("PUT", bearer, { cells: { title: "Entwurf" } }), ctx());
  assert.equal(put.status, 403);
  assert.equal(await drafts(viewer.user.id), 0);
  // Reading the own draft stays possible.
  assert.equal((await route.GET(json("GET", bearer), ctx())).status, 200);
  // A draft saved by the session is not discarded by the read token.
  assert.equal((await route.PUT(json("PUT", { cookie: viewer.cookie, ...origin }, { cells: { title: "Entwurf" } }), ctx())).status, 200);
  assert.equal(await drafts(viewer.user.id), 1);
  assert.equal((await route.DELETE(json("DELETE", bearer), ctx())).status, 403);
  assert.equal(await drafts(viewer.user.id), 1);
});

test("the session and a write token still answer forms and keep drafts", async () => {
  const before = await rowCount();
  assert.equal((await route.POST(json("POST", { cookie: viewer.cookie, ...origin }, { cells: { title: "Per Sitzung" } }), ctx())).status, 200);
  const bearer = { authorization: `Bearer ${writeToken}` };
  assert.equal((await route.POST(json("POST", bearer, { cells: { title: "Per Schreib-Token" } }), ctx())).status, 200);
  assert.equal(await rowCount(), before + 2);
  assert.equal((await route.DELETE(json("DELETE", bearer), ctx())).status, 200);
  assert.equal(await drafts(viewer.user.id), 0);
});

// Multipart answer with one file of `bytes` bytes.
async function upload(headers: Record<string, string>, bytes: number, title: string) {
  const form = new FormData();
  form.set("payload", JSON.stringify({ cells: { title } }));
  form.append("file:att", new File([Buffer.alloc(bytes, 97)], "notiz.txt", { type: "text/plain" }));
  const encoded = new Response(form),
    body = Buffer.from(await encoded.arrayBuffer());
  return new Request(url, {
    method: "POST",
    headers: { ...headers, "content-type": encoded.headers.get("content-type")!, "content-length": String(body.length) },
    body,
  });
}
const anonymousRows = async () => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM anonymous_uploads WHERE scope=?", `form:${formToken}`))!.n);

test("signed-in uploads count against the personal storage limit, named and anonymous forms alike", async () => {
  await setUserLimits(viewer.user.id, { storageMb: 1 });
  const session = { cookie: viewer.cookie, ...origin };
  // Below the limit: stored and owned by the submitter.
  assert.equal((await route.POST(await upload(session, 600_000, "Klein"), ctx())).status, 200);
  assert.equal(await userBytes(viewer.user.id), 600_000);
  // Beyond it: refused, nothing stored.
  const files = async () => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM files WHERE page_id=?", dbId))!.n);
  const before = await files();
  const full = await route.POST(await upload(session, 600_000, "Zu groß"), ctx());
  assert.equal(full.status, 413);
  assert.equal(await files(), before);
  // An anonymous form stores no owner, but the submitter's limit applies all
  // the same, and the bytes also draw on the form's anonymous budget.
  await act({ action: "form.update", pageId: dbId, enabled: true, internal: true, anonymous: true });
  assert.equal((await route.POST(await upload(session, 600_000, "Anonym zu groß"), ctx())).status, 413);
  assert.equal(await files(), before);
  assert.equal(await anonymousRows(), 0);
  await setUserLimits(viewer.user.id, {});
  assert.equal((await route.POST(await upload(session, 600_000, "Anonym"), ctx())).status, 200);
  assert.equal(await files(), before + 1);
  assert.equal(await userBytes(viewer.user.id), 600_000);
  assert.equal(await anonymousRows(), 1);
});

test("a required property that later gets a write rule is no longer asked nor required", async () => {
  const { saveFormSubmission } = await import("../lib/forms");
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: sid, kind: "database", title: "Feedback" })).id as string;
  let db = await database(pageId);
  const title = db.fields[0].id;
  await act({ action: "database.update", pageId, version: db.version, fields: [...db.fields, { id: "note", name: "Interne Notiz", type: "text" }], views: db.views });
  await act({ action: "form.update", pageId, enabled: true, internal: false, anonymous: true, config: { requiredFields: ["note"] } });
  await assert.rejects(async () => await saveFormSubmission(pageId, null, { [title]: "ohne Notiz" }), (e: { status?: number }) => e.status === 400);
  db = await database(pageId);
  await act({ action: "database.update", pageId, version: db.version, fields: db.fields.map((f) => (f.id === "note" ? { ...f, access: { write: "owners" } } : f)), views: db.views });
  await saveFormSubmission(pageId, null, { [title]: "hallo" });
  // The restricted property itself stays closed to the form.
  await assert.rejects(async () => await saveFormSubmission(pageId, null, { [title]: "hallo", note: "x" }), (e: { status?: number }) => e.status === 403);
});
