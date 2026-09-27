import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-synced-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { listSyncedBlocks } = await import("../lib/synced-blocks");
const { searchWorkspace } = await import("../lib/search-index");

const uid = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Anna", "anna@example.test");
const anna = { id: uid, name: "Anna", email: "anna@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = createWorkspace(anna.id, "Team");
const space = bootstrap(anna, wid).spaces[0].id;
const page = (title: string) =>
  (command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title, kind: "document" }) as { id: string }).id;
const first = page("Onboarding");
const second = page("Handbuch");

test("a synced block is a page outside the tree, shown on several pages", () => {
  const { id: synced } = command(anna, {
    action: "synced.create",
    pageId: first,
    html: "<p>Kontakt: support@example.test</p><script>x</script>",
  }) as { id: string };
  assert.equal(bootstrap(anna, wid).pages.some((p) => p.id === synced), false, "not in the page tree");
  const embed = `<div data-synced-block="${synced}"></div>`;
  for (const host of [first, second])
    run("UPDATE documents SET html=?,state=? WHERE page_id=?", `<p>Text</p>${embed}`, htmlState(`<p>Text</p>${embed}`), host);
  // The reference survives the document schema.
  assert.match(String((pageData(anna, second) as { html: string }).html), new RegExp(`data-synced-block="${synced}"`));
  const data = pageData(anna, synced) as { html: string; syncedUsage: { count: number; origin: { title: string } } };
  assert.doesNotMatch(data.html, /script/);
  assert.equal(data.syncedUsage.count, 2);
  assert.equal(data.syncedUsage.origin.title, "Onboarding");
  const listed = listSyncedBlocks(anna, wid);
  assert.equal(listed[0].id, synced);
  assert.match(listed[0].preview, /Kontakt/);
  assert.equal(listed[0].origin, "Onboarding");
});

test("search finds synced text on the page it was created on", async () => {
  const results = searchWorkspace(anna, wid, "support@example");
  assert.equal(results.length, 1);
  assert.equal((results[0] as { id: string }).id, first);
  assert.equal((results[0] as { title: string }).title, "Onboarding");
});
