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

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
type Result = { id: string } & Record<string, unknown>;
const owner = account("Olga"),
  colleague = account("Carla"),
  guest = account("Gustav");
const wid = createWorkspace(owner.id, "Firma");
run("INSERT INTO members VALUES(?,?,?)", wid, colleague.id, "editor");
const act = (input: Record<string, unknown>, as = owner) => command(as, input) as Result;
const team = act({ action: "space.create", workspaceId: wid, name: "Team" }).id;
const page = act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Geteilt", kind: "document" }).id;
act({ action: "page.share", pageId: page, email: guest.email, role: "editor" });
assert.ok(one("SELECT 1 FROM workspace_guests WHERE user_id=?", guest.id));

test("mention choices of a guest hold nobody but the guest", () => {
  assert.deepEqual(inlineMentionCandidates(guest, page, undefined, "").map((m) => m.email), [guest.email]);
  assert.deepEqual(inlineMentionCandidates(guest, page, undefined, "carla"), []);
  // Members still find their colleagues.
  const forMember = inlineMentionCandidates(colleague, page, undefined, "").map((m) => m.name);
  assert.deepEqual(forMember.sort(), ["Carla", "Gustav", "Olga"]);
});

test("an internal form lists no member names to a guest", () => {
  const db = act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Anfragen", kind: "database", databaseKind: "empty" }).id;
  act({ action: "page.share", pageId: db, email: guest.email, role: "editor" });
  act({ action: "form.update", pageId: db, enabled: true, internal: true });
  const token = one<{ token: string }>("SELECT token FROM forms WHERE page_id=?", db)!.token;
  assert.deepEqual(getForm(token, guest).members.map((m) => m.name), ["Gustav"]);
  assert.deepEqual(getForm(token, colleague).members.map((m) => m.name), ["Carla", "Gustav", "Olga"]);
});
