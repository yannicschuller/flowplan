// A journal PIN keeps the journal private (lib/journal-extras.ts):
// setting one revokes the share links, publications and public forms of
// the journal and every page below it – also the journal's pages in links
// and publications of pages above – records it in the security log and
// says how many. New links, publications and public forms are refused,
// and nothing of it goes out through an older link. Removing a PIN nobody
// knows (the owner's reset) needs a fresh confirmation (lib/step-up.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-pin-shares-"));
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { publicTree } = await import("../lib/publication");
const { getForm } = await import("../lib/forms");
const { JOURNAL_RESET_STEP_UP } = await import("../lib/journal-extras");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("Olga"),
  writer = account("Wanda");
const wid = createWorkspace(owner.id, "Firma");
run("INSERT INTO members VALUES(?,?,?)", wid, writer.id, "editor");
const act = (input: Record<string, unknown>, as = owner) => command(as, input) as Record<string, unknown> & { id: string };
const status = (fn: () => unknown) => {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? String(e);
  }
};
const space = act({ action: "space.create", workspaceId: wid, name: "Team" }).id;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("setting a PIN revokes the journal's links, publications and public forms and says how many", async () => {
  const parent = act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Handbuch" }).id;
  const journal = act({ action: "page.create", workspaceId: wid, spaceId: space, parentId: parent, title: "Tagebuch", kind: "journal" }).id;
  const below = act({ action: "page.create", workspaceId: wid, spaceId: space, parentId: journal, title: "Notiz" }).id;
  const db = act({ action: "page.create", workspaceId: wid, spaceId: space, parentId: journal, title: "Gewohnheiten", kind: "database" }).id;
  const sibling = act({ action: "page.create", workspaceId: wid, spaceId: space, parentId: parent, title: "Anderes" }).id;
  // Of the journal: a link on it, a link on a page below, a publication
  // below, a public form. Above it: a link and a publication with sub-pages.
  const journalLink = (act({ action: "share.create", pageId: journal, name: "Familie", role: "viewer" }) as unknown as { token: string }).token;
  const belowLink = (act({ action: "share.create", pageId: below, name: "Notiz", role: "viewer" }) as unknown as { token: string }).token;
  act({ action: "page.publish", pageId: below, enabled: true });
  act({ action: "form.update", pageId: db, enabled: true, internal: false, anonymous: true });
  const formToken = one<{ token: string }>("SELECT token FROM forms WHERE page_id=?", db)!.token;
  const parentLink = (act({ action: "share.create", pageId: parent, name: "Alle", role: "viewer", includeChildren: true }) as unknown as { token: string }).token;
  act({ action: "page.publish", pageId: parent, enabled: true, includeChildren: true });
  const parentToken = one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", parent)!.public_token;
  assert.ok(publicTree(parentLink).pages.some((p) => p.id === below));
  assert.ok(getForm(formToken, null));
  // A form only for members stays.
  const internalDb = act({ action: "page.create", workspaceId: wid, spaceId: space, parentId: journal, title: "Intern", kind: "database" }).id;
  act({ action: "form.update", pageId: internalDb, enabled: true, internal: true });

  const result = act({ action: "journal.lock", pageId: journal, pin: "123456" });
  // 2 links of the journal, 1 publication below, 1 public form, the
  // parent's link and publication without the journal: 6.
  assert.equal(result.revoked, 6);
  assert.equal(one("SELECT 1 FROM share_links WHERE token IN (?,?)", journalLink, belowLink), undefined);
  assert.equal(one<{ public_token: string | null }>("SELECT public_token FROM pages WHERE id=?", below)!.public_token, null);
  assert.equal(one("SELECT 1 FROM publications WHERE page_id=?", below), undefined);
  assert.equal(one<{ enabled: number }>("SELECT enabled FROM forms WHERE page_id=?", db)!.enabled, 0);
  assert.equal(one<{ enabled: number }>("SELECT enabled FROM forms WHERE page_id=?", internalDb)!.enabled, 1);
  // The parent stays shared and published – without the journal.
  for (const token of [parentLink, parentToken]) {
    const pages = publicTree(token).pages.map((p) => p.id);
    assert.ok(pages.includes(parent) && pages.includes(sibling));
    assert.ok(!pages.includes(journal) && !pages.includes(below) && !pages.includes(db));
  }
  // Recorded in the activity and the security log.
  assert.match(one<{ detail: string }>("SELECT detail FROM audit WHERE action='journal.lock.revoke' AND resource_id=?", journal)!.detail, /^6:/);
  await tick();
  assert.ok(all<{ detail: string }>("SELECT detail FROM security_events WHERE kind='share.revoked'").some((e) => e.detail.includes(journal)));

  // Changing the PIN finds nothing left to revoke.
  assert.equal(act({ action: "journal.lock", pageId: journal, pin: "654321", current: "123456" }).revoked, 0);
});

test("a journal with a PIN is not shared, published or given a public form – entered or not", () => {
  const journal = act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Privat", kind: "journal" }).id;
  const below = act({ action: "page.create", workspaceId: wid, spaceId: space, parentId: journal, title: "Seite" }).id;
  const db = act({ action: "page.create", workspaceId: wid, spaceId: space, parentId: journal, title: "Tabelle", kind: "database" }).id;
  act({ action: "journal.lock", pageId: journal, pin: "246810" });
  // The owner has just entered the PIN and still may not share.
  for (const pageId of [journal, below]) {
    assert.equal(status(() => act({ action: "share.create", pageId, name: "Link", role: "viewer" })), 423);
    assert.equal(status(() => act({ action: "page.publish", pageId, enabled: true })), 423);
  }
  assert.equal(status(() => act({ action: "form.update", pageId: db, enabled: true, internal: false })), 423);
  // A form for members is fine; unpublishing too.
  assert.equal(status(() => act({ action: "form.update", pageId: db, enabled: true, internal: true })), 200);
  assert.equal(status(() => act({ action: "page.publish", pageId: below, enabled: false })), 200);
  // A page above shares and publishes, the journal stays out.
  const top = act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Oben" }).id;
  run("UPDATE pages SET parent_id=? WHERE id=?", top, journal);
  const link = (act({ action: "share.create", pageId: top, name: "Oben", role: "viewer", includeChildren: true }) as unknown as { token: string }).token;
  assert.deepEqual(publicTree(link).pages.map((p) => p.id), [top]);
  assert.equal(one("SELECT 1 FROM share_link_pages WHERE token=? AND page_id=?", link, journal), undefined);
});

test("a shared page moved into a journal with a PIN is no longer served", () => {
  const journal = act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Später", kind: "journal" }).id;
  act({ action: "journal.lock", pageId: journal, pin: "135790" });
  const page = act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Wandert" }).id;
  const link = (act({ action: "share.create", pageId: page, name: "Link", role: "viewer" }) as unknown as { token: string }).token;
  act({ action: "page.publish", pageId: page, enabled: true });
  const token = one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", page)!.public_token;
  assert.equal(publicTree(link).root.id, page);
  run("UPDATE pages SET parent_id=? WHERE id=?", journal, page);
  assert.equal(status(() => publicTree(link)), 404);
  assert.equal(status(() => publicTree(token)), 404);
});

test("the owner's reset of a PIN nobody knows needs a fresh confirmation", () => {
  const journal = act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Vergessen", kind: "journal" }, writer).id;
  act({ action: "journal.lock", pageId: journal, pin: "777777" }, writer);
  // Without step-up (an API token, a plain command): refused with the hint.
  assert.throws(() => act({ action: "journal.lock", pageId: journal, pin: null }), (e: Error) => e.message === JOURNAL_RESET_STEP_UP);
  assert.ok(one("SELECT lock_hash FROM journal_settings WHERE page_id=? AND lock_hash IS NOT NULL", journal));
  // Confirmed (POST /api/auth/journal-pin-reset after confirmStep): removed.
  assert.equal(status(() => command({ ...owner, stepUp: true }, { action: "journal.lock", pageId: journal, pin: null })), 200);
  assert.equal(one("SELECT 1 FROM journal_settings WHERE page_id=? AND lock_hash IS NOT NULL", journal), undefined);
  // Who knows the PIN removes it as before, without step-up.
  act({ action: "journal.lock", pageId: journal, pin: "888888" }, writer);
  assert.equal(status(() => act({ action: "journal.lock", pageId: journal, pin: null, current: "888888" }, writer)), 200);
});

test("the reset route confirms the step before it removes the PIN", () => {
  const route = readFileSync(join(import.meta.dirname, "../app/api/auth/[action]/route.ts"), "utf8");
  const start = route.indexOf('if (action === "journal-pin-reset") {');
  assert.ok(start > 0);
  const block = route.slice(start, start + 600);
  assert.match(block, /await confirm\(\);[\s\S]*command\(\{ \.\.\.user, stepUp: true \}, \{ action: "journal\.lock", pageId, pin: null \}\)/);
  // Only that route sets stepUp.
  assert.equal((route.match(/stepUp: true/g) || []).length, 1);
  // The UI asks in the step-up dialog of the sign-in methods.
  const ui = readFileSync(join(import.meta.dirname, "../components/journal-parts.tsx"), "utf8");
  assert.match(ui, /StepUpDialog/);
  assert.match(ui, /post\("journal-pin-reset", \{ pageId: journalId, confirm \}\)/);
});
