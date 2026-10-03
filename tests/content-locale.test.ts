import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-locale-"));
const { run, id, all, one } = await import("../lib/db");
const { ensureWorkspace } = await import("../lib/seed");
const { withContentLocale, localeOfRequest } = await import("../lib/content-locale");
const { isAutoDayTitle, dayTitle } = await import("../lib/journal-title");

const user = (name: string) => {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return uid;
};
const titles = (uid: string) =>
  all<{ title: string }>(
    "SELECT p.title FROM pages p JOIN members m ON m.workspace_id=p.workspace_id WHERE m.user_id=? ORDER BY p.title",
    uid,
  ).map((p) => p.title);

test("the first workspace follows the reader's language", () => {
  const de = user("Jana");
  ensureWorkspace(de);
  assert.ok(titles(de).includes("Willkommen bei Flowplan"));
  const en = user("Jane");
  withContentLocale("en", () => ensureWorkspace(en));
  assert.deepEqual(titles(en), ["Meeting notes", "Product roadmap", "Team handbook", "Welcome to Flowplan"]);
  const fields = JSON.parse(
    one<{ fields: string }>(
      "SELECT d.fields FROM databases d JOIN pages p ON p.id=d.page_id JOIN members m ON m.workspace_id=p.workspace_id WHERE m.user_id=?",
      en,
    )!.fields,
  );
  assert.deepEqual(fields[1].options, ["Not started", "In progress", "Done"]);
});

test("the language of a request: cookie first, then the browser", () => {
  const req = (headers: Record<string, string>) => new Request("http://x/", { headers });
  assert.equal(localeOfRequest(req({ cookie: "a=1; flowplan-lang=en", "accept-language": "de" })), "en");
  assert.equal(localeOfRequest(req({ "accept-language": "de-DE" })), "de");
  assert.equal(localeOfRequest(req({})), "en");
});

test("journal days keep their automatic title in both languages", () => {
  assert.equal(dayTitle("2026-10-03", "de"), "Samstag, 3. Oktober 2026");
  assert.ok(isAutoDayTitle(dayTitle("2026-10-03", "en"), "2026-10-03"));
  assert.ok(!isAutoDayTitle("Urlaub", "2026-10-03"));
});

test("the English template catalog matches the German one", async () => {
  const { templateCatalog } = await import("../lib/template-catalog");
  const { templateCatalogEn } = await import("../lib/template-catalog-en");
  assert.deepEqual(Object.keys(templateCatalogEn).sort(), Object.keys(templateCatalog).sort());
  for (const [key, de] of Object.entries(templateCatalog)) {
    const en = templateCatalogEn[key];
    assert.equal(en.kind, de.kind, key);
    assert.equal(en.category, de.category, key);
    assert.deepEqual(en.fields?.map((f) => [f.id, f.type]), de.fields?.map((f) => [f.id, f.type]), key);
    assert.deepEqual(en.views?.map((v) => v.id), de.views?.map((v) => v.id), key);
    assert.equal(en.rows?.length, de.rows?.length, key);
    for (const row of en.rows || [])
      for (const [field, value] of Object.entries(row.cells)) {
        const options = en.fields?.find((f) => f.id === field)?.options;
        if (options) for (const v of [value].flat()) assert.ok(options.includes(v as string), `${key}.${field}: ${v}`);
      }
    for (const f of en.fields || [])
      for (const [, name] of (f.formula || "").matchAll(/prop\("([^"]+)"\)/g))
        assert.ok(en.fields!.some((x) => x.name === name), `${key}: ${name}`);
  }
});
