// Bodies that are not what they claim to be are the sender's mistake: a
// deliberate 400, never a 500 (found by API fuzzing). JSON that does not
// parse sent to /api/command (and the other JSON routes of the general
// handler); a multipart body that is cut off or has the wrong boundary sent
// to the phone's capture save and the other form routes
// (lib/request-body.ts readFormData).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-malformed-bodies-"));
process.env.APP_URL = "https://flowplan.example.test";
const { inRequestScope } = await import("./helpers/next-request");
const { run, id } = await import("../lib/db");
const { createSession, cookieName, hash, HttpError } = await import("../lib/auth");
const { createWorkspace } = await import("../lib/seed");
const { registerMobileDevice } = await import("../lib/mobile-devices");
const { readFormData, limitedRequest } = await import("../lib/request-body");
const general = await import("../app/api/[...path]/handler");
const capture = await import("../app/api/mobile/capture/[action]/handler");

const APP = "https://flowplan.example.test";
const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "body", "body@example.test");
const user = { id: uid, name: "body", email: "body@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as never;
await createWorkspace(uid, "Bodies");
const { token } = await createSession(uid, [], undefined, {}, new Headers());
const { deviceToken } = await registerMobileDevice(user, hash(token), { installationId: randomUUID(), platform: "ios" });

async function post(path: string[], body: string, contentType = "application/json") {
  const req = new Request(`${APP}/api/${path.join("/")}`, {
    method: "POST",
    body,
    headers: { origin: APP, cookie: `${cookieName}=${token}`, "content-type": contentType },
  });
  const { value } = await inRequestScope(req, () => general.POST(req as never, { params: Promise.resolve({ path }) }));
  return value;
}

test("/api/command: a body that is not JSON is a 400, a valid one still answers", async () => {
  for (const body of ["{", '{"action":', '{"action":"page.create",}', " ", '{"action":"x"}{}', "\u0000"]) {
    const res = await post(["command"], body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error, "Ungültige Eingabe.");
  }
  const unknown = await post(["command"], '{"action":"no.such.action"}');
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, "Unbekannte Aktion.");
  const ok = await post(["command"], JSON.stringify({ action: "profile.motion", motion: "reduced" }));
  assert.equal(ok.status, 200);
});

const boundary = "----bodiesBoundary";
const cut = `--${boundary}\r\nContent-Disposition: form-data; name="place"\r\n\r\npages\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nPNG`;

test("the phone's capture save: a cut or mismatched multipart body is a 400", async () => {
  for (const [body, type] of [
    [cut, `multipart/form-data; boundary=${boundary}`],
    [`${cut}\r\n--${boundary}--\r\n`, "multipart/form-data; boundary=other"],
    ["not a form", `multipart/form-data; boundary=${boundary}`],
  ]) {
    const req = new Request(`${APP}/api/mobile/capture/save`, {
      method: "POST",
      body,
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": type, "content-length": String(Buffer.byteLength(body)) },
    });
    const res = await capture.POST(req, { params: Promise.resolve({ action: "save" }) });
    assert.equal(res.status, 400, `${type}: ${body.slice(0, 30)}`);
  }
});

test("readFormData: 400 for a body that is no form, the limit's 413 kept, a form read", async () => {
  const form = (body: string, type = `multipart/form-data; boundary=${boundary}`) => new Request(`${APP}/x`, { method: "POST", body, headers: { "content-type": type } });
  await assert.rejects(readFormData(form(cut)), (e: unknown) => e instanceof HttpError && e.status === 400);
  await assert.rejects(readFormData(form("a=1", "application/json")), (e: unknown) => e instanceof HttpError && e.status === 400);
  const big = `--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\n${"x".repeat(5000)}\r\n--${boundary}--\r\n`;
  await assert.rejects(readFormData(limitedRequest(form(big), 1000)), (e: unknown) => e instanceof HttpError && e.status === 413);
  const read = await readFormData(form(`--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\neins\r\n--${boundary}--\r\n`));
  assert.equal(read.get("a"), "eins");
});
