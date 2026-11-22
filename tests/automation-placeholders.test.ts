// The placeholder picker of the database rules (#413,
// lib/automation-placeholders.ts): what it offers and what it inserts –
// always text the rules' resolver (lib/record-placeholders.ts) reads back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinLang, builtinToken, fieldToken, insertToken, opensPicker, rulePlaceholders } from "../lib/automation-placeholders";
import { mapPlaceholders, placeholderTarget } from "../lib/record-placeholders";
import type { Field } from "../lib/types";

const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open"] },
  { id: "due", name: "Fällig am (Kunde)", type: "date" },
  { id: "odd", name: "Preis {netto}", type: "number" },
  { id: "secret", name: "Gehalt", type: "number", access: { read: "owners" } },
  { id: "twin", name: "status", type: "text" },
];
const key = (token: string) => token.slice(2, -2);

test("record rules: the readable properties, then the six built-ins", () => {
  const items = rulePlaceholders(fields, { scheduled: false, lang: "de" });
  assert.deepEqual(
    items.map((i) => i.token),
    ["{{Name}}", "{{Status}}", "{{Fällig am (Kunde)}}", "{{field:odd}}", "{{field:twin}}", "{{Titel}}", "{{Heute}}", "{{Jetzt}}", "{{Ersteller}}", "{{Ich}}", "{{Datenbank}}"],
  );
  // Every token finds what it was offered for.
  for (const item of items) {
    const target = placeholderTarget(key(item.token), fields);
    if (item.kind === "field") assert.equal(target && "field" in target && target.field.id, item.id.slice(6), item.token);
    else assert.equal(target && "builtin" in target && target.builtin, item.builtin, item.token);
  }
});

test("scheduled rules: no record, so only date, time, who saved it and the database", () => {
  const items = rulePlaceholders(fields, { scheduled: true, lang: "en" });
  assert.deepEqual(items.map((i) => i.token), ["{{Today}}", "{{Now}}", "{{Me}}", "{{Database}}"]);
});

test("a property named like a built-in hides that name: another language's name is offered", () => {
  const shadow: Field[] = [{ id: "t", name: "Heute", type: "text" }];
  assert.equal(fieldToken(shadow[0], shadow), "{{Heute}}");
  assert.equal(builtinToken("today", shadow, "de"), "{{Today}}");
  const all: Field[] = ["Heute", "Today", "Aujourd’hui", "Сегодня"].map((name, i) => ({ id: `f${i}`, name, type: "text" }));
  assert.equal(builtinToken("today", all, "de"), null);
  assert.equal(builtinLang("zh"), "en");
  assert.equal(builtinLang("ru"), "ru");
  assert.equal(builtinToken("today", [], "ru"), "{{Сегодня}}");
  assert.equal(builtinLang("fr-FR"), "fr");
  assert.equal(builtinLang("de-CH"), "de");
});

test("names with spaces and special characters fill in; braces go by id", () => {
  const filled = mapPlaceholders("{{Fällig am (Kunde)}} / {{field:odd}} / {{ status }}", (k) => {
    const target = placeholderTarget(k, fields);
    return target && "field" in target ? target.field.id : undefined;
  });
  assert.equal(filled, "due / odd / status");
  // Too long for the pattern: by id.
  const long: Field = { id: "long", name: "x".repeat(121), type: "text" };
  assert.equal(fieldToken(long, [long]), "{{field:long}}");
  const unnamed: Field = { id: "nn", name: "  ", type: "text" };
  assert.equal(fieldToken(unnamed, [unnamed]), "{{field:nn}}");
});

test("inserting: at the cursor, over the selection, a typed {{ becomes part of it, never past the limit", () => {
  assert.deepEqual(insertToken("Hallo ", 6, 6, "{{Name}}"), { text: "Hallo {{Name}}", caret: 14 });
  assert.deepEqual(insertToken("Hallo Welt", 6, 10, "{{Name}}"), { text: "Hallo {{Name}}", caret: 14 });
  assert.deepEqual(insertToken("A {{ B", 4, 4, "{{Status}}"), { text: "A {{Status}} B", caret: 12 });
  assert.deepEqual(insertToken("", 0, 0, "{{Heute}}"), { text: "{{Heute}}", caret: 9 });
  assert.equal(insertToken("12345", 5, 5, "{{Name}}", 10), null);
  assert.equal(opensPicker("A {", "A {{", 4), true);
  assert.equal(opensPicker("A {{", "A {{{", 5), false);
  assert.equal(opensPicker("A ", "A {", 3), false);
});
