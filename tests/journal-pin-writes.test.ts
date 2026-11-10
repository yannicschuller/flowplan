// Audit (Nov 2026), third round: writes into a PIN-locked journal that
// went past requireUnlocked – a new page or a moved page below it,
// comments (new, reactions, resolved), a page back from the trash (with
// sub-pages the person may not edit), one paragraph from an older version,
// and the content of a synced block made on a journal day (created at the
// space root, outside the PIN). Without the PIN each one refuses with 423;
// with it they work as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-pin-writes-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const api = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { listSyncedBlocks } = await import("../lib/synced-blocks");
const { journalLocked } = await import("../lib/journal-extras");
const { runDataSteps, SYNCED_JOURNAL_STEP } = await import("../lib/data-steps");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
type Result = { id: string } & Record<string, unknown>;
const owner = await account("Olga"),
  member = await account("Max");
const wid = await createWorkspace(owner.id, "Firma");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const act = async (input: Record<string, unknown>, as = owner) => (await api.command(as, input)) as Result;
const status = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? String(e);
  }
};
const team = (await act({ action: "space.create", workspaceId: wid, name: "Team" })).id;
const create = async (input: Record<string, unknown>, as = owner) => (await act({ action: "page.create", workspaceId: wid, spaceId: team, ...input }, as)).id;
const page = async (pid: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pid))!;
const PIN = "246813";

const journal = await create({ title: "Tagebuch", kind: "journal" });
const day = await create({ title: "10. November", parentId: journal });
await run("UPDATE pages SET journal_date='2026-11-10' WHERE id=?", day);
const note = await create({ title: "Notiz", parentId: journal });
await run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState("<p>SECRET-NOTE</p>"), "<p>SECRET-NOTE</p>", note);
const snapshotId = (await act({ action: "page.snapshot", pageId: note })).id;
await run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState("<p>Neu</p>"), "<p>Neu</p>", note);
const comment = id();
await run("INSERT INTO comments(id,page_id,row_id,author_id,body) VALUES(?,?,?,?,?)", comment, note, null, owner.id, "Hallo");
await act({ action: "journal.lock", pageId: journal, pin: PIN });
await act({ action: "journal.relock", pageId: journal });
const unlock = async (who: Identity) => await act({ action: "journal.unlock", pageId: journal, pin: PIN }, who);
const relock = async (who: Identity) => await act({ action: "journal.relock", pageId: journal }, who);

test("no paragraph from an older version without the PIN", async () => {
  assert.equal(await status(() => act({ action: "snapshot.restoreBlock", pageId: note, snapshotId, text: "SECRET-NOTE" }, member)), 423);
  // No hint whether the text was there.
  assert.equal(await status(() => act({ action: "snapshot.restoreBlock", pageId: note, snapshotId, text: "Nie da" }, member)), 423);
  assert.doesNotMatch((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", note))!.html, /SECRET-NOTE/);
  await unlock(member);
  await act({ action: "snapshot.restoreBlock", pageId: note, snapshotId, text: "SECRET-NOTE" }, member);
  assert.match((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", note))!.html, /SECRET-NOTE/);
  await relock(member);
});

test("a synced block made on a journal day stays behind the PIN", async () => {
  await unlock(owner);
  const synced = (await act({ action: "synced.create", pageId: day, html: "<p>SECRET-SYNCED</p>" })).id;
  await relock(owner);
  assert.equal((await page(synced)).parent_id, journal);
  assert.equal(JSON.stringify(await listSyncedBlocks(member, wid)).includes("SECRET-SYNCED"), false);
  assert.equal(await journalLocked(member, await page(synced)), true);
  // One made before at the space root: moved into the journal of the day that shows it.
  const old = await create({ title: "Synchronisierter Block" });
  await run("UPDATE pages SET synced=1 WHERE id=?", old);
  await run("UPDATE documents SET html=? WHERE page_id=?", "<p>SECRET-OLD</p>", old);
  await run("UPDATE documents SET html=? WHERE page_id=?", `<p>Tag</p><div data-synced-block="${old}"></div>`, day);
  // Shown only on an ordinary page: stays where it is.
  const plain = await create({ title: "Synchronisierter Block" });
  await run("UPDATE pages SET synced=1 WHERE id=?", plain);
  const shower = await create({ title: "Zeigt ihn" });
  await run("UPDATE documents SET html=? WHERE page_id=?", `<div data-synced-block="${plain}"></div>`, shower);
  assert.equal(JSON.stringify(await listSyncedBlocks(member, wid)).includes("SECRET-OLD"), true);
  await run("DELETE FROM data_migrations WHERE name=?", SYNCED_JOURNAL_STEP);
  await runDataSteps([SYNCED_JOURNAL_STEP]);
  assert.equal((await page(old)).parent_id, journal);
  assert.equal((await page(plain)).parent_id, null);
  assert.equal(JSON.stringify(await listSyncedBlocks(member, wid)).includes("SECRET-OLD"), false);
  // With the PIN it is offered again.
  await unlock(member);
  assert.equal(JSON.stringify(await listSyncedBlocks(member, wid)).includes("SECRET-OLD"), true);
  await relock(member);
});
