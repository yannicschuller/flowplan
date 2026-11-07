// Audit (Nov 2026): any editor of a shared journal could set a PIN on it,
// and without the PIN nobody – creator, workspace owner – could open,
// change or remove the lock. Now only the journal's creator and the
// workspace's owners set or change a PIN; owners also remove one they do
// not know (the creator is notified).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-pin-owner-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const api = await import("../lib/api");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
type Result = { id: string } & Record<string, unknown>;
const owner = account("Olga"),
  editor = account("Eddi"),
  writer = account("Wanda");
const wid = createWorkspace(owner.id, "Firma");
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, writer.id, "editor");
const act = (input: Record<string, unknown>, as = owner) => api.command(as, input) as Result;
const status = (fn: () => unknown) => {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? String(e);
  }
};
const team = act({ action: "space.create", workspaceId: wid, name: "Team" }).id;
const locked = (as: Identity, page: string) => (api.pageData(as, page) as { locked?: { journalId: string; canReset?: boolean } }).locked;

test("an editor cannot put a PIN on someone else's journal", () => {
  const journal = act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Team-Tagebuch", kind: "journal" }).id;
  assert.equal(status(() => act({ action: "journal.lock", pageId: journal, pin: "123456" }, editor)), 403);
  assert.equal(locked(owner, journal), undefined);
});

test("the creator of a journal sets, changes and removes its PIN", () => {
  const journal = act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Wandas Tagebuch", kind: "journal" }, writer).id;
  assert.equal(status(() => act({ action: "journal.lock", pageId: journal, pin: "123456" }, writer)), 200);
  assert.equal(status(() => act({ action: "journal.lock", pageId: journal, pin: "654321", current: "123456" }, writer)), 200);
  // Without the PIN the creator (not an owner) cannot remove it.
  assert.equal(status(() => act({ action: "journal.lock", pageId: journal, pin: null }, writer)), 403);
  // Other editors cannot change it even with the PIN.
  assert.equal(status(() => act({ action: "journal.lock", pageId: journal, pin: null, current: "654321" }, editor)), 403);
  assert.equal(locked(editor, journal)?.canReset, false);
  assert.equal(status(() => act({ action: "journal.lock", pageId: journal, pin: null, current: "654321" }, writer)), 200);
});

test("a workspace owner resets a PIN nobody knows, and the creator hears of it", () => {
  const journal = act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Verlorene PIN", kind: "journal" }, writer).id;
  act({ action: "journal.lock", pageId: journal, pin: "777777" }, writer);
  assert.equal(locked(owner, journal)?.canReset, true);
  // Setting a new PIN over a lock still needs the old one.
  assert.equal(status(() => act({ action: "journal.lock", pageId: journal, pin: "111111" })), 403);
  assert.equal(status(() => act({ action: "journal.lock", pageId: journal, pin: null })), 200);
  assert.equal(locked(owner, journal), undefined);
  assert.equal(locked(writer, journal), undefined);
  assert.ok(one("SELECT 1 FROM notifications WHERE user_id=? AND page_id=? AND kind='security'", writer.id, journal));
  // Afterwards the owner may set a PIN of their own.
  assert.equal(status(() => act({ action: "journal.lock", pageId: journal, pin: "222222" })), 200);
});
