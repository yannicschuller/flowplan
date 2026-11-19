// Earlier answers as suggestions in forms (#374, lib/form-suggestions.ts,
// app/api/forms/[token]/suggestions/handler.ts): ranking, the privacy rules
// (members-only forms that record who answered, record and property
// permissions, own vs. all) and the rate limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-form-suggest-"));
process.env.APP_URL = "https://flowplan.example.test";
const { id, run } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { formSettings, saveFormSubmission } = await import("../lib/forms");
const { rankSuggestions, SUGGESTION_REQUESTS_PER_MINUTE } = await import("../lib/form-suggestions");
const { formConfigSchema, suggestionScope } = await import("../lib/form-settings");
const route = await import("../app/api/forms/[token]/suggestions/handler");

test("suggestions: prefix matches first, then by frequency and recency, distinct and capped", () => {
  // Newest first.
  const values = ["Bunte Wolle", "Kleber", "buntstifte", "Holzbuntstifte", "Buntstifte", "Bunte Wolle", "Buntstifte", "x".repeat(201) + "bunt"];
  assert.deepEqual(rankSuggestions(values, "Bunt"), ["buntstifte", "Bunte Wolle", "Holzbuntstifte"]);
  // Fewer than two characters: nothing.
  assert.deepEqual(rankSuggestions(values, "B"), []);
  assert.deepEqual(rankSuggestions(values, " b "), []);
  // What was typed already is not suggested.
  assert.deepEqual(rankSuggestions(["Kleber", "Klebeband"], "kleber"), []);
  // Same frequency: the more recent first.
  assert.deepEqual(rankSuggestions(["Mehl gross", "Mehlwurm"], "mehl"), ["Mehl gross", "Mehlwurm"]);
  // At most eight.
  assert.equal(rankSuggestions(Array.from({ length: 20 }, (_, i) => `Artikel ${i}`), "ar").length, 8);
});

test("suggestions are a text question's setting and stay off by default", () => {
  const field = { id: "item", name: "Artikel", type: "text" as const };
  assert.equal(suggestionScope(field, formConfigSchema.parse({})), undefined);
  assert.equal(suggestionScope(field, formConfigSchema.parse({ suggestions: { item: "own" } })), "own");
  // A long text or another property type gets none.
  assert.equal(suggestionScope(field, formConfigSchema.parse({ suggestions: { item: "all" }, questionStyles: { item: "long" } })), undefined);
  assert.equal(suggestionScope({ ...field, type: "number" }, formConfigSchema.parse({ suggestions: { item: "all" } })), undefined);
  assert.throws(() => formConfigSchema.parse({ suggestions: { item: "everyone" } }));
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function account(name: string) {
  const uid = id(),
    cookie = randomUUID();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", sha(cookie), uid, "[]", Date.now() + 3600_000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
  return { user, cookie: `flowplan_session=${cookie}` };
}
const owner = await account("suggest-owner"),
  anna = await account("suggest-anna"),
  ben = await account("suggest-ben"),
  outsider = await account("suggest-outsider");
const wid = await createWorkspace(owner.user.id, "Familie");
const sid = (await bootstrap(owner.user, wid)).spaces[0].id;
for (const m of [anna, ben]) await run("INSERT INTO members VALUES(?,?,?)", wid, m.user.id, "editor");
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner.user, body);

// A shopping list with a text question "Artikel" and an internal note.
async function shoppingList(space: string, title: string) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title })).id as string;
  const db = await database(pageId);
  await act({
    action: "database.update",
    pageId,
    version: db.version,
    fields: [...db.fields, { id: "item", name: "Artikel", type: "text" }, { id: "note", name: "Notiz", type: "text" }],
    views: db.views,
  });
  await act({ action: "form.update", pageId, enabled: true, internal: true, anonymous: false, config: { suggestions: { item: "all" } } });
  return { pageId, token: (await formSettings(pageId))!.token };
}
const list = await shoppingList(sid, "Einkauf");
const ask = async (token: string, who: { cookie: string } | null, q: string, field = "item") =>
  await route.GET(
    new Request(`https://flowplan.example.test/api/forms/${token}/suggestions?${new URLSearchParams({ field, q })}`, { headers: who ? { cookie: who.cookie } : {} }),
    { params: Promise.resolve({ token }) },
  );
const values = async (token: string, who: { cookie: string } | null, q: string, field = "item") => {
  const response = await ask(token, who, q, field);
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { suggestions: string[] };
  assert.deepEqual(Object.keys(body), ["suggestions"]);
  return body.suggestions;
};
const setForm = async (pageId: string, patch: Record<string, unknown>) => await act({ action: "form.update", pageId, ...patch });

await saveFormSubmission(list.pageId, anna.user, { item: "Buntstifte", note: "geheim-anna" });
await saveFormSubmission(list.pageId, anna.user, { item: "Buntstifte" });
await saveFormSubmission(list.pageId, ben.user, { item: "Bunte Wolle", note: "geheim-ben" });
await saveFormSubmission(list.pageId, owner.user, { item: "Buntpapier" });
// The owner's record is private: Anna and Ben may not read it.
const privateRow = (await act({ action: "row.create", pageId: list.pageId, cells: { item: "Bunter Geheimtipp" } })).id as string;
await act({ action: "row.access", pageId: list.pageId, rowId: privateRow, access: "private", grants: [] });

test("all answers: only from records the person may read, and only the asked property", async () => {
  const anna1 = await values(list.token, anna, "bunt");
  assert.deepEqual(anna1, ["Buntstifte", "Buntpapier", "Bunte Wolle"]);
  assert.ok(!anna1.includes("Bunter Geheimtipp"));
  assert.ok(!JSON.stringify(anna1).includes("geheim"));
  // The owner sees the private record too.
  assert.ok((await values(list.token, owner, "bunt")).includes("Bunter Geheimtipp"));
  // Contains matches come after prefix matches.
  assert.deepEqual(await values(list.token, anna, "wolle"), ["Bunte Wolle"]);
  // Fewer than two characters: nothing asked.
  assert.deepEqual(await values(list.token, anna, "b"), []);
});

test("own answers: only records the person created", async () => {
  await setForm(list.pageId, { config: { suggestions: { item: "own" } } });
  assert.deepEqual(await values(list.token, anna, "bunt"), ["Buntstifte"]);
  assert.deepEqual(await values(list.token, ben, "bunt"), ["Bunte Wolle"]);
  await setForm(list.pageId, { config: { suggestions: { item: "all" } } });
});

test("questions without the switch, other properties and long texts give nothing", async () => {
  assert.equal((await ask(list.token, anna, "geheim", "note")).status, 404);
  assert.equal((await ask(list.token, anna, "bunt", "title")).status, 404);
  assert.equal((await ask(list.token, anna, "bunt", "nope")).status, 404);
  await setForm(list.pageId, { config: { suggestions: { item: "all" }, questionStyles: { item: "long" } } });
  assert.equal((await ask(list.token, anna, "bunt")).status, 404);
  await setForm(list.pageId, { config: { suggestions: { item: "all" } } });
});

test("anonymous and public forms, and visitors without an account, get none", async () => {
  assert.equal((await ask(list.token, null, "bunt")).status, 401);
  await setForm(list.pageId, { anonymous: true });
  assert.equal((await ask(list.token, anna, "bunt")).status, 403);
  await setForm(list.pageId, { anonymous: false, internal: false });
  assert.equal((await ask(list.token, anna, "bunt")).status, 403);
  assert.equal((await ask(list.token, null, "bunt")).status, 401);
  await setForm(list.pageId, { internal: true });
  // Not a member of the workspace: refused like the form itself.
  assert.equal((await ask(list.token, outsider, "bunt")).status, 403);
  assert.equal((await values(list.token, anna, "bunt")).length, 3);
});

test("a property with a read rule is no longer asked and suggests nothing", async () => {
  const db = await database(list.pageId);
  await act({ action: "database.update", pageId: list.pageId, version: db.version, fields: db.fields.map((f) => (f.id === "item" ? { ...f, access: { read: "owners" } } : f)), views: db.views });
  assert.equal((await ask(list.token, anna, "bunt")).status, 404);
  const after = await database(list.pageId);
  await act({ action: "database.update", pageId: list.pageId, version: after.version, fields: after.fields.map((f) => (f.id === "item" ? { ...f, access: undefined } : f)), views: after.views });
  assert.equal((await values(list.token, anna, "bunt")).length, 3);
});

test("a member who may not read the database gets no values, not even their own", async () => {
  const secret = (await act({ action: "space.create", workspaceId: wid, name: "Eltern", private: true })).id as string;
  const hidden = await shoppingList(secret, "Geschenke");
  await saveFormSubmission(hidden.pageId, owner.user, { item: "Buntes Fahrrad" });
  // Ben can still send the members-only form, but cannot read its records.
  await saveFormSubmission(hidden.pageId, ben.user, { item: "Buntes Buch" });
  assert.deepEqual(await values(hidden.token, ben, "bunt"), []);
  await setForm(hidden.pageId, { config: { suggestions: { item: "own" } } });
  assert.deepEqual(await values(hidden.token, ben, "bunt"), []);
  assert.deepEqual(await values(hidden.token, owner, "bunt"), ["Buntes Fahrrad"]);
});

test("suggestions are rate-limited per person", async () => {
  let last = 200;
  for (let i = 0; i <= SUGGESTION_REQUESTS_PER_MINUTE; i++) last = (await ask(list.token, ben, `bu${i}`)).status;
  assert.equal(last, 429);
  // Someone else is not affected.
  assert.equal((await ask(list.token, anna, "bunt")).status, 200);
});
