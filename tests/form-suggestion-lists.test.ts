// Fixed suggestion lists for a form's text questions (#385,
// lib/form-suggestion-list.ts): cleaning and limits, the order when merged
// with earlier answers, validation on saving and what a public form page
// gets – the lists of the questions it asks, nothing more.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-form-lists-"));
process.env.APP_URL = "https://flowplan.example.test";
const { id, run } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { formSettings, getForm } = await import("../lib/forms");
const { formConfigSchema, suggestionList } = await import("../lib/form-settings");
const {
  cleanSuggestionList,
  matchSuggestionList,
  mergeSuggestions,
  suggestionListFromText,
  suggestionListProblem,
  SUGGESTION_LIST_MAX,
  SUGGESTION_LIST_ITEM_MAX,
} = await import("../lib/form-suggestion-list");
const route = await import("../app/api/forms/[token]/suggestions/route");

test("lists are trimmed, without empty lines and duplicates, the first spelling kept", () => {
  assert.deepEqual(cleanSuggestionList(["  Berlin ", "", "   ", "berlin", "Bad   Homburg", "BERLIN", "Hamburg"]), ["Berlin", "Bad Homburg", "Hamburg"]);
  assert.deepEqual(suggestionListFromText("Kiel\r\n\nLübeck\nkiel\n"), ["Kiel", "Lübeck"]);
  assert.equal(suggestionListProblem(Array.from({ length: SUGGESTION_LIST_MAX }, (_, i) => `Ort ${i}`)), undefined);
  assert.equal(suggestionListProblem(Array.from({ length: SUGGESTION_LIST_MAX + 1 }, (_, i) => `Ort ${i}`)), "count");
  assert.equal(suggestionListProblem(["x".repeat(SUGGESTION_LIST_ITEM_MAX + 1)]), "length");
});

test("the schema cleans lists, drops empty ones and refuses too many or too long entries", () => {
  const config = formConfigSchema.parse({ suggestionLists: { city: [" Kiel", "kiel", "", "Lübeck "], empty: ["", "  "] } });
  assert.deepEqual(config.suggestionLists, { city: ["Kiel", "Lübeck"] });
  assert.deepEqual(formConfigSchema.parse({}).suggestionLists, {});
  // Parsing again changes nothing (stored settings are parsed on reading).
  assert.deepEqual(formConfigSchema.parse(config).suggestionLists, config.suggestionLists);
  // Duplicates do not count towards the limit.
  const many = Array.from({ length: SUGGESTION_LIST_MAX }, (_, i) => `Ort ${i}`);
  assert.equal(formConfigSchema.parse({ suggestionLists: { city: [...many, ...many] } }).suggestionLists.city.length, SUGGESTION_LIST_MAX);
  assert.throws(() => formConfigSchema.parse({ suggestionLists: { city: [...many, "Noch einer"] } }));
  assert.throws(() => formConfigSchema.parse({ suggestionLists: { city: ["x".repeat(SUGGESTION_LIST_ITEM_MAX + 1)] } }));
  // Whitespace around an entry does not count.
  assert.doesNotThrow(() => formConfigSchema.parse({ suggestionLists: { city: [` ${"x".repeat(SUGGESTION_LIST_ITEM_MAX)} `] } }));
  assert.throws(() => formConfigSchema.parse({ suggestionLists: { city: "Kiel" } }));
  assert.throws(() => formConfigSchema.parse({ suggestionLists: { city: [42] } }));
  assert.throws(() => formConfigSchema.parse({ suggestionLists: Object.fromEntries(Array.from({ length: 81 }, (_, i) => [`f${i}`, ["a"]])) }));
});

test("matching: from the first character, prefix matches first, each in the author's order", () => {
  const list = ["Hamburg", "Bad Homburg", "Hannover", "Homberg", "Halle"];
  assert.deepEqual(matchSuggestionList(list, "h"), ["Hamburg", "Hannover", "Homberg", "Halle", "Bad Homburg"]);
  assert.deepEqual(matchSuggestionList(list, "HOM"), ["Homberg", "Bad Homburg"]);
  assert.deepEqual(matchSuggestionList(list, "  burg "), ["Hamburg", "Bad Homburg"]);
  // What was typed already is no suggestion.
  assert.deepEqual(matchSuggestionList(list, "halle"), []);
  assert.deepEqual(matchSuggestionList(list, "xyz"), []);
  // An empty field (browsing with the arrow key): the start of the list.
  assert.deepEqual(matchSuggestionList(list, "", 3), ["Hamburg", "Bad Homburg", "Hannover"]);
  assert.deepEqual(matchSuggestionList(undefined, "h"), []);
  assert.equal(matchSuggestionList(Array.from({ length: 30 }, (_, i) => `Ort ${i}`), "ort").length, 8);
});

test("merged with earlier answers: the fixed list first, no duplicates, at most eight", () => {
  assert.deepEqual(mergeSuggestions(["Buntstifte", "Bunte Kreide"], ["buntstifte", "Bunte Wolle", "Bunte  Kreide"]), ["Buntstifte", "Bunte Kreide", "Bunte Wolle"]);
  assert.deepEqual(mergeSuggestions([], ["Kleber"]), ["Kleber"]);
  assert.equal(mergeSuggestions(Array.from({ length: 6 }, (_, i) => `a${i}`), Array.from({ length: 6 }, (_, i) => `b${i}`)).length, 8);
  assert.deepEqual(mergeSuggestions(Array.from({ length: 6 }, (_, i) => `a${i}`), ["b0", "b1", "b2"]).slice(6), ["b0", "b1"]);
});

test("only one-line text questions have a list", () => {
  const field = { id: "city", name: "Ort", type: "text" as const };
  const config = formConfigSchema.parse({ suggestionLists: { city: ["Kiel"] } });
  assert.deepEqual(suggestionList(field, config), ["Kiel"]);
  assert.equal(suggestionList(field, { ...config, questionStyles: { city: "long" } }), undefined);
  assert.equal(suggestionList({ ...field, type: "number" }, config), undefined);
  assert.equal(suggestionList({ ...field, id: "other" }, config), undefined);
});

// A workspace with a database "Anmeldung": name, city and an internal note.
const owner = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", owner, owner, "Lists", "lists@example.test");
const user = { id: owner, name: "Lists", email: "lists@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as never;
const wid = await createWorkspace(owner, "Verein");
const sid = (await bootstrap(user, wid)).spaces[0].id;
const act = async (body: Record<string, unknown>): Promise<any> => await command(user, body);
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: sid, kind: "database", title: "Anmeldung" })).id as string;
const db = await database(pageId);
await act({
  action: "database.update",
  pageId,
  version: db.version,
  fields: [...db.fields, { id: "city", name: "Ort", type: "text" }, { id: "note", name: "Notiz", type: "text" }],
  views: db.views,
});

test("saving a form stores the cleaned lists and refuses lists over the limits", async () => {
  await act({ action: "form.update", pageId, enabled: true, internal: true, anonymous: false, config: { suggestionLists: { city: ["Kiel ", "kiel", "Lübeck", ""] } } });
  assert.deepEqual((await formSettings(pageId))!.config.suggestionLists, { city: ["Kiel", "Lübeck"] });
  await assert.rejects(act({ action: "form.update", pageId, config: { suggestionLists: { city: Array.from({ length: SUGGESTION_LIST_MAX + 1 }, (_, i) => `Ort ${i}`) } } }));
  await assert.rejects(act({ action: "form.update", pageId, config: { suggestionLists: { city: ["x".repeat(SUGGESTION_LIST_ITEM_MAX + 1)] } } }));
  // The refused saves left the list as it was.
  assert.deepEqual((await formSettings(pageId))!.config.suggestionLists, { city: ["Kiel", "Lübeck"] });
});

test("a public anonymous form gets the lists of the questions it asks, but no earlier answers", async () => {
  await act({
    action: "form.update",
    pageId,
    enabled: true,
    internal: false,
    anonymous: true,
    config: { hiddenFields: ["note"], suggestionLists: { city: ["Kiel", "Lübeck"], note: ["intern-geheim"], gone: ["weg"] } },
  });
  const token = (await formSettings(pageId))!.token;
  // A visitor without an account, as the public form page loads it.
  const form = await getForm(token, null);
  assert.deepEqual(form.config.suggestionLists, { city: ["Kiel", "Lübeck"] });
  assert.ok(!JSON.stringify(form).includes("intern-geheim"));
  // A long text question has none either.
  await act({ action: "form.update", pageId, config: { questionStyles: { city: "long" }, suggestionLists: { city: ["Kiel"] } } });
  assert.deepEqual((await getForm(token, null)).config.suggestionLists, {});
  // The endpoint for earlier answers is unchanged: nothing for this form.
  const response = await route.GET(new Request(`https://flowplan.example.test/api/forms/${token}/suggestions?field=city&q=ki`), { params: Promise.resolve({ token }) });
  assert.equal(response.status, 401);
});
