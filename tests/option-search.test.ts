// Finding select options by typing and creating the typed one (#423):
// the pure search, and database.update refusing a second spelling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";
import { MAX_FIELD_OPTIONS, duplicateNewOptions, foldOption, searchOptions } from "../lib/option-search";

const options = ["Offen", "In Arbeit", "Erledigt", "Café", "Arbeitsgruppe"];

test("search: case and accents aside, the exact one first, then prefixes, then the rest", () => {
  assert.equal(foldOption("  Café  Crème "), "cafe creme");
  assert.deepEqual(searchOptions(options, "").matches, options);
  assert.deepEqual(searchOptions(options, "cafe").matches, ["Café"]);
  assert.deepEqual(searchOptions(options, "ARBEIT").matches, ["Arbeitsgruppe", "In Arbeit"]);
  assert.deepEqual(searchOptions(options, "in  arbeit").matches, ["In Arbeit"]);
  assert.deepEqual(searchOptions(options, "erledigt").matches, ["Erledigt"]);
  assert.deepEqual(searchOptions(options, "xyz").matches, []);
  // Chosen values of a multi-select are left out, but still count as there.
  const chosen = searchOptions(options, "offen", { exclude: ["Offen"], canCreate: true });
  assert.deepEqual(chosen.matches, []);
  assert.equal(chosen.exact, "Offen");
  assert.equal(chosen.create, undefined);
});

test("create: only when allowed, typed, new and within the limits", () => {
  assert.equal(searchOptions(options, "Wartet").create, undefined);
  assert.equal(searchOptions(options, " Wartet  auf  Kunde ", { canCreate: true }).create, "Wartet auf Kunde");
  assert.equal(searchOptions(options, "   ", { canCreate: true }).create, undefined);
  // Another spelling of an existing option picks that one instead.
  assert.equal(searchOptions(options, "cafe", { canCreate: true }).create, undefined);
  assert.equal(searchOptions(options, "IN ARBEIT", { canCreate: true }).create, undefined);
  assert.equal(searchOptions(options, "x".repeat(100), { canCreate: true }).create, "x".repeat(100));
  assert.equal(searchOptions(options, "x".repeat(101), { canCreate: true }).create, undefined);
  const full = Array.from({ length: MAX_FIELD_OPTIONS }, (_, i) => `o${i}`);
  assert.equal(searchOptions(full, "neu", { canCreate: true }).create, undefined);
});

test("duplicateNewOptions: a new second spelling, not an old one", () => {
  const f = (opts: string[]) => [{ id: "s", type: "select", options: opts }];
  assert.equal(duplicateNewOptions(f(["Offen", "Neu"]), f(["Offen"])), undefined);
  assert.deepEqual(duplicateNewOptions(f(["Offen", "offen"]), f(["Offen"])), { field: "s", option: "offen" });
  assert.deepEqual(duplicateNewOptions(f(["Cafe", "Café"]), []), { field: "s", option: "Cafe" });
  // Stored like that before (an old import): left alone.
  assert.equal(duplicateNewOptions(f(["Rot", "rot", "Blau"]), f(["Rot", "rot"])), undefined);
  assert.equal(duplicateNewOptions([{ id: "t", type: "text", options: ["a", "A"] }], []), undefined);
});

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-option-search-"));
const { id, run } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { englishMessage } = await import("../lib/i18n-errors");

test("database.update: a new option of another spelling is refused, a new one stored with a colour", async () => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "owner", "owner@example.test");
  const owner: Identity = { id: uid, name: "owner", email: "owner@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" };
  const wid = await createWorkspace(owner.id, "Options");
  const boot = await bootstrap(owner, wid);
  const act = (body: Record<string, unknown>) => command(owner, body);
  const pageId = ((await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Aufgaben", kind: "database" })) as { id: string }).id;
  const update = async (opts: string[]) => {
    const d = await database(pageId);
    const fields: Field[] = [{ id: "title", name: "Name", type: "text" }, { id: "phase", name: "Phase", type: "select", options: opts }];
    return act({ action: "database.update", pageId, version: d.version, fields, views: d.views });
  };
  await update(["Offen", "Erledigt"]);
  await assert.rejects(update(["Offen", "Erledigt", "offen"]), (e: Error) => {
    assert.equal(e.message, "Die Option „offen“ gibt es in „Phase“ schon.");
    assert.equal(englishMessage(e.message), "The option “offen” already exists in “Phase”.");
    return true;
  });
  await update(["Offen", "Erledigt", "Wartet"]);
  const phase = (await database(pageId)).fields[1];
  assert.deepEqual(phase.options, ["Offen", "Erledigt", "Wartet"]);
  assert.ok(phase.optionColors?.Wartet);
});
