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

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
type Result = { id: string } & Record<string, unknown>;
const owner = await account("Olga"),
  editor = await account("Eddi"),
  writer = await account("Wanda");
const wid = await createWorkspace(owner.id, "Firma");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, writer.id, "editor");
const act = async (input: Record<string, unknown>, as = owner) => (await api.command(as, input)) as Result;
const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? String(e);
  }
};
const team = (await act({ action: "space.create", workspaceId: wid, name: "Team" })).id;
const locked = async (as: Identity, page: string) => ((await api.pageData(as, page)) as { locked?: { journalId: string; canReset?: boolean } }).locked;

test("an editor cannot put a PIN on someone else's journal", async () => {
  const journal = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Team-Tagebuch", kind: "journal" })).id;
  assert.equal(await status(async () => await act({ action: "journal.lock", pageId: journal, pin: "123456" }, editor)), 403);
  assert.equal(await locked(owner, journal), undefined);
});

test("the creator of a journal sets, changes and removes its PIN", async () => {
  const journal = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Wandas Tagebuch", kind: "journal" }, writer)).id;
  assert.equal(await status(async () => await act({ action: "journal.lock", pageId: journal, pin: "123456" }, writer)), 200);
  assert.equal(await status(async () => await act({ action: "journal.lock", pageId: journal, pin: "654321", current: "123456" }, writer)), 200);
  // Without the PIN the creator (not an owner) cannot remove it.
  assert.equal(await status(async () => await act({ action: "journal.lock", pageId: journal, pin: null }, writer)), 403);
  // Other editors cannot change it even with the PIN.
  assert.equal(await status(async () => await act({ action: "journal.lock", pageId: journal, pin: null, current: "654321" }, editor)), 403);
  assert.equal((await locked(editor, journal))?.canReset, false);
  assert.equal(await status(async () => await act({ action: "journal.lock", pageId: journal, pin: null, current: "654321" }, writer)), 200);
});

test("a workspace owner resets a PIN nobody knows, and the creator hears of it", async () => {
  const journal = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Verlorene PIN", kind: "journal" }, writer)).id;
  await act({ action: "journal.lock", pageId: journal, pin: "777777" }, writer);
  assert.equal((await locked(owner, journal))?.canReset, true);
  // Setting a new PIN over a lock still needs the old one.
  assert.equal(await status(async () => await act({ action: "journal.lock", pageId: journal, pin: "111111" })), 403);
  // The reset is confirmed once more first (lib/step-up.ts; the route
  // POST /api/auth/journal-pin-reset sets stepUp).
  assert.equal(await status(async () => await act({ action: "journal.lock", pageId: journal, pin: null })), 403);
  assert.equal(await status(async () => await act({ action: "journal.lock", pageId: journal, pin: null }, { ...owner, stepUp: true })), 200);
  assert.equal(await locked(owner, journal), undefined);
  assert.equal(await locked(writer, journal), undefined);
  assert.ok(await one("SELECT 1 FROM notifications WHERE user_id=? AND page_id=? AND kind='security'", writer.id, journal));
  // Afterwards the owner may set a PIN of their own.
  assert.equal(await status(async () => await act({ action: "journal.lock", pageId: journal, pin: "222222" })), 200);
});
