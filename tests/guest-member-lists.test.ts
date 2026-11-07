// Audit (Nov 2026): a guest who was shared one page got the names and
// e-mail addresses of the workspace's members through the mention choices
// of inline comments (GET /api/threads/mentions), and member names through
// an internal form, although bootstrap and the share dialog show guests
// nobody but themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-guest-lists-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { inlineMentionCandidates } = await import("../lib/inline-comments");
const { getForm } = await import("../lib/forms");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
type Result = { id: string } & Record<string, unknown>;
const owner = await account("Olga"),
  colleague = await account("Carla"),
  guest = await account("Gustav");
const wid = await createWorkspace(owner.id, "Firma");
await run("INSERT INTO members VALUES(?,?,?)", wid, colleague.id, "editor");
const act = async (input: Record<string, unknown>, as = owner) => (await command(as, input)) as Result;
const team = (await act({ action: "space.create", workspaceId: wid, name: "Team" })).id;
const page = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Geteilt", kind: "document" })).id;
await act({ action: "page.share", pageId: page, email: guest.email, role: "editor" });
assert.ok(await one("SELECT 1 FROM workspace_guests WHERE user_id=?", guest.id));

test("mention choices of a guest hold nobody but the guest", async () => {
  assert.deepEqual((await inlineMentionCandidates(guest, page, undefined, "")).map((m) => m.email), [guest.email]);
  assert.deepEqual(await inlineMentionCandidates(guest, page, undefined, "carla"), []);
  // Members still find their colleagues.
  const forMember = (await inlineMentionCandidates(colleague, page, undefined, "")).map((m) => m.name);
  assert.deepEqual(forMember.sort(), ["Carla", "Gustav", "Olga"]);
});

test("an internal form lists no member names to a guest", async () => {
  const db = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Anfragen", kind: "database", databaseKind: "empty" })).id;
  await act({ action: "page.share", pageId: db, email: guest.email, role: "editor" });
  await act({ action: "form.update", pageId: db, enabled: true, internal: true });
  const token = (await one<{ token: string }>("SELECT token FROM forms WHERE page_id=?", db))!.token;
  assert.deepEqual((await getForm(token, guest)).members.map((m) => m.name), ["Gustav"]);
  assert.deepEqual((await getForm(token, colleague)).members.map((m) => m.name), ["Carla", "Gustav", "Olga"]);
});
