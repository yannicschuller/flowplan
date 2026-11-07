// Audit (Nov 2026): a wrong journal PIN entered through POST /api/command
// was counted inside the command's transaction – and the 403 rolled the
// count back, so the limits (5 per 5 minutes, 20 a day, the creator told
// after the fifth) never applied. Changing a PIN checked the current one
// without any limit. Now both keep their count although the command
// refuses (lib/db.ts refuseKeeping), and parallel attempts take turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-pin-limits-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const api = await import("../lib/api");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("Olga"),
  editor = await account("Eddi"),
  writer = await account("Wanda");
const wid = await createWorkspace(owner.id, "Firma");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, writer.id, "editor");
const act = async (input: Record<string, unknown>, as = owner) => (await api.command(as, input)) as { id: string };
const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? String(e);
  }
};
const team = ((await api.bootstrap(owner, wid)) as { spaces: { id: string }[] }).spaces[0].id;
async function lockedJournal(title: string) {
  const journal = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title, kind: "journal" }, writer)).id;
  await act({ action: "journal.lock", pageId: journal, pin: "135790" }, writer);
  return journal;
}
const alerts = async (journal: string) =>
  Number((await one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND page_id=? AND kind='security'", writer.id, journal))?.n);
const failures = async (who: Identity, journal: string) =>
  Number((await one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE key=?", `pin:${who.id}:${journal}`))?.n);

test("wrong PINs through the command count: 429 after five, and the creator hears of it", async () => {
  const journal = await lockedJournal("Tagebuch");
  for (let i = 0; i < 5; i++) assert.equal(await status(() => act({ action: "journal.unlock", pageId: journal, pin: "000000" }, editor)), 403);
  assert.equal(await failures(editor, journal), 5);
  assert.equal(await alerts(journal), 1);
  // Even the right PIN waits now.
  assert.equal(await status(() => act({ action: "journal.unlock", pageId: journal, pin: "135790" }, editor)), 429);
  assert.equal(await alerts(journal), 1, "once per burst");
});

test("the current PIN when changing it has the same limits", async () => {
  const journal = await lockedJournal("Zweites Tagebuch");
  // A workspace owner who is not the creator guesses the current PIN.
  for (let i = 0; i < 5; i++)
    assert.equal(await status(() => act({ action: "journal.lock", pageId: journal, pin: "111111", current: "000000" })), 403);
  assert.equal(await failures(owner, journal), 5);
  assert.equal(await alerts(journal), 1);
  assert.equal(await status(() => act({ action: "journal.lock", pageId: journal, pin: "111111", current: "135790" })), 429);
  // The creator with the right PIN is not affected by someone else's count.
  assert.equal(await status(() => act({ action: "journal.lock", pageId: journal, pin: "222222", current: "135790" }, writer)), 200);
});

test("parallel wrong PINs take turns: no more than five are checked", async () => {
  const journal = await lockedJournal("Drittes Tagebuch");
  const results = await Promise.all(Array.from({ length: 20 }, () => status(() => act({ action: "journal.unlock", pageId: journal, pin: "000000" }, editor))));
  assert.equal(results.filter((s) => s === 403).length, 5, JSON.stringify(results));
  assert.equal(results.filter((s) => s === 429).length, 15);
  assert.equal(await failures(editor, journal), 5);
  assert.equal(await alerts(journal), 1);
});
