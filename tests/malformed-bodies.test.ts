// Bodies that are not what they claim to be are the sender's mistake: a
// deliberate 400, never a 500 (found by API fuzzing). JSON that does not
// parse sent to /api/command (and the other JSON routes of the general
// handler).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-malformed-bodies-"));
process.env.APP_URL = "https://flowplan.example.test";
const { inRequestScope } = await import("./helpers/next-request");
const { run, id } = await import("../lib/db");
const { createSession, cookieName } = await import("../lib/auth");
const { createWorkspace } = await import("../lib/seed");
const general = await import("../app/api/[...path]/handler");

const APP = "https://flowplan.example.test";
const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "body", "body@example.test");
await createWorkspace(uid, "Bodies");
const { token } = await createSession(uid, [], undefined, {}, new Headers());

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
