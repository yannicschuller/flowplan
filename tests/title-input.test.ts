import test from "node:test";
import assert from "node:assert/strict";
import { parseTitleInput, parseTypedDate, titleDisplayText, titleEditText, titleMode, titlePlaceholder } from "../lib/title-input";
import type { Field } from "../lib/types";

type T = (d: string, e: string) => string;
const de: T = (d) => d;
const en: T = (_d, e) => e;
const field = (type: Field["type"], extra: Partial<Field> = {}) => ({ id: "title", name: "Titel", type, ...extra }) as Field;
const read = (f: Field, text: string, t = de, extra: { current?: unknown; members?: { id: string; name: string; email: string }[] } = {}) =>
  parseTitleInput(f, text, { t, zone: "Europe/Berlin", ...extra });
const value = (f: Field, text: string, extra = {}) => {
  const r = read(f, text, de, extra);
  assert.ok(r.ok, `${f.type} "${text}": ${r.ok ? "" : r.error}`);
  return r.value;
};
const error = (f: Field, text: string, t = de, extra = {}) => {
  const r = read(f, text, t, extra);
  assert.ok(!r.ok, `${f.type} "${text}" should be refused`);
  return r.error;
};

test("title modes: every type the title can have (#463, #529)", () => {
  for (const type of ["text", "url", "email", "phone"] as const) assert.equal(titleMode(field(type)), "text");
  for (const type of ["date", "number", "select", "multiselect", "person"] as const) assert.equal(titleMode(field(type)), "typed");
  for (const type of ["checkbox", "relation", "files", "checklist", "sprint", "aliases"] as const) assert.equal(titleMode(field(type)), "editor");
  assert.equal(titleMode(field("multiselect", { tagOptions: true })), "editor");
  for (const type of ["formula", "rollup", "id", "created_at", "updated_by", "progress", "time"] as const) assert.equal(titleMode(field(type)), "readonly");
});

test("text-like titles stay text", () => {
  assert.equal(value(field("text"), "  Neue   Aufgabe "), "Neue Aufgabe");
  assert.equal(value(field("url"), "https://example.org"), "https://example.org");
  assert.equal(value(field("email"), "a@example.org"), "a@example.org");
  assert.equal(value(field("phone"), "+49 30 1234"), "+49 30 1234");
});

test("date titles: German, ISO, slashes and month names; invalid ones refused", () => {
  const f = field("date");
  assert.equal(value(f, "23.11.2026"), "2026-11-23");
  assert.equal(value(f, "23.11.26"), "2026-11-23");
  assert.equal(value(f, "1.2.2027"), "2027-02-01");
  assert.equal(value(f, "2026-11-23"), "2026-11-23");
  assert.equal(value(f, "23/11/2026"), "2026-11-23");
  assert.equal(value(f, "11/23/2026"), "2026-11-23");
  assert.equal(value(field("date", { format: "us" }), "11/03/2026"), "2026-11-03");
  assert.equal(value(f, "03/11/2026"), "2026-11-03");
  assert.equal(value(f, "23. Nov. 2026"), "2026-11-23");
  assert.equal(value(f, "23. November 2026"), "2026-11-23");
  assert.equal(value(f, "Nov 23, 2026"), "2026-11-23");
  assert.equal(value(f, "23 Dez 2026"), "2026-12-23");
  assert.equal(value(f, "29.02.2028"), "2028-02-29");
  assert.equal(value(f, ""), "");
  assert.equal(error(f, "Quatsch"), "Das ist kein Datum – z. B. 23.11.2026");
  assert.equal(error(f, "Quatsch", en), "That's not a date – e.g. 23.11.2026");
  assert.equal(error(field("date", { format: "us" }), "soon", en), "That's not a date – e.g. 11/23/2026");
  for (const bad of ["31.11.2026", "29.02.2027", "2026-13-01", "23.11.", "12", "23 Foo 2026"]) error(f, bad);
});

test("date titles with a time: in the person's zone; none for a property without time", () => {
  const f = field("date");
  assert.equal(value(f, "23.11.2026 14:30"), "2026-11-23T13:30:00Z");
  assert.equal(value(f, "2026-11-23T14:30"), "2026-11-23T13:30:00Z");
  assert.equal(value(f, "23.11.2026, 9:05"), "2026-11-23T08:05:00Z");
  assert.equal(value(f, "Nov 23, 2026 2:30 PM"), "2026-11-23T13:30:00Z");
  assert.equal(value(f, "23.11.2026 14.30 Uhr"), "2026-11-23T13:30:00Z");
  // As the title shows it: "23. Nov. 2026, 14:30 (UTC+01:00)".
  assert.equal(value(f, "23. Nov. 2026, 14:30 (UTC+01:00)"), "2026-11-23T13:30:00Z");
  error(f, "23.11.2026 25:00");
  // Clocks forward: 02:30 does not exist in Berlin on 29 March 2026.
  assert.match(error(f, "29.03.2026 02:30"), /Zeitumstellung/);
  const noTime = field("date", { noTime: true });
  assert.equal(value(noTime, "23.11.2026"), "2026-11-23");
  assert.match(error(noTime, "23.11.2026 14:30"), /keine Uhrzeit/);
  assert.match(error(noTime, "23.11.2026 14:30", en), /no time/);
  // A value that has a time may keep it.
  assert.equal(value(noTime, "23.11.2026 14:30", { current: "2026-11-20T08:00:00Z" }), "2026-11-23T13:30:00Z");
  // The unchanged time keeps the stored instant.
  assert.equal(value(f, "23.11.2026 14:30", { current: "2026-11-23T13:30:00.000Z" }), "2026-11-23T13:30:00Z");
});

test("parseTypedDate: local values", () => {
  assert.equal(parseTypedDate("23.11.2026"), "2026-11-23");
  assert.equal(parseTypedDate("23.11.2026 08:15"), "2026-11-23T08:15");
  assert.equal(parseTypedDate("tomorrow"), null);
});

test("number titles: German and English writing, units, currencies, percent", () => {
  const f = field("number");
  assert.equal(value(f, "12"), 12);
  assert.equal(value(f, "1.234,5"), 1234.5);
  assert.equal(value(f, "1,234.5"), 1234.5);
  assert.equal(value(f, "-3,25"), -3.25);
  assert.equal(value(f, "−3"), -3);
  assert.equal(value(f, ""), null);
  assert.equal(error(f, "zwölf"), "Das ist keine Zahl – z. B. 1.234,5");
  assert.equal(error(f, "twelve", en), "That's not a number – e.g. 1,234.5");
  error(f, "12 kg");
  const kg = field("number", { unit: "kg" });
  assert.equal(value(kg, "12 kg"), 12);
  assert.equal(value(kg, "12,5kg"), 12.5);
  assert.equal(value(kg, "12"), 12);
  assert.equal(error(kg, "viel"), "Das ist keine Zahl – z. B. 12 kg");
  assert.equal(error(kg, "lots", en), "That's not a number – e.g. 12 kg");
  const eur = field("number", { format: "eur" });
  assert.equal(value(eur, "12,50 €"), 12.5);
  assert.equal(value(eur, "€ 1.234,00"), 1234);
  assert.equal(value(eur, "12.50 EUR"), 12.5);
  const percent = field("number", { format: "percent" });
  assert.equal(value(percent, "15 %"), 0.15);
  assert.equal(value(percent, "0,15"), 0.15);
  const rating = field("number", { rollupDisplay: "rating" });
  assert.equal(value(rating, "4"), 4);
  assert.match(error(rating, "7"), /0 bis 5/);
});

test("checkbox, select, multi-select and person titles", () => {
  const check = field("checkbox");
  assert.equal(value(check, "ja"), true);
  assert.equal(value(check, "No"), false);
  assert.equal(value(check, ""), false);
  error(check, "vielleicht");
  const select = field("select", { options: ["Offen", "Erledigt"] });
  assert.equal(value(select, "erledigt"), "Erledigt");
  assert.equal(value(select, ""), "");
  assert.equal(error(select, "Später"), "Keine Option von „Titel“ – z. B. Offen, Erledigt");
  assert.equal(error(select, "Later", en), "Not an option of “Titel” – e.g. Offen, Erledigt");
  assert.match(error(field("select"), "x"), /noch keine Optionen/);
  const multi = field("multiselect", { options: ["Rot", "Grün", "Blau, hell"] });
  assert.deepEqual(value(multi, "rot, Blau, hell, Rot"), ["Rot", "Blau, hell"]);
  assert.deepEqual(value(multi, ""), []);
  error(multi, "Rot, Gelb");
  error(field("multiselect", { tagOptions: true, options: ["a"] }), "a");
  const members = [{ id: "u1", name: "Anna Muster", email: "anna@example.org" }];
  const person = field("person");
  assert.equal(value(person, "anna muster", { members }), "u1");
  assert.equal(value(person, "ANNA@example.org", { members }), "u1");
  assert.equal(error(person, "Bob", en, { members }), "No one in the workspace has that name.");
});

test("computed titles and editor-only types are not typed", () => {
  for (const type of ["formula", "rollup", "id", "relation", "files"] as const) assert.match(error(field(type), "x"), /nicht tippen/);
});

test("edit and display text: dates and numbers as the table shows them", () => {
  const date = field("date");
  assert.equal(titleEditText(date, "2026-11-23"), "23.11.2026");
  assert.equal(titleEditText(date, "2026-11-23T13:30:00Z", { zone: "Europe/Berlin" }), "23.11.2026 14:30");
  assert.equal(titleEditText(field("date", { format: "iso" }), "2026-11-23"), "2026-11-23");
  assert.equal(titleEditText(field("date", { format: "us" }), "2026-11-23"), "11/23/2026");
  assert.equal(titleEditText(field("date", { format: "eu" }), "2026-11-23"), "23.11.2026");
  assert.equal(titleDisplayText(field("date", { format: "eu" }), "2026-11-23"), "23.11.2026");
  assert.equal(titleDisplayText(date, ""), "");
  // What is shown reads back as the same value.
  for (const v of ["2026-11-23", "2026-01-05"]) {
    assert.equal(value(date, titleDisplayText(date, v)), v);
    assert.equal(value(date, titleEditText(date, v)), v);
  }
  const kg = field("number", { unit: "kg" });
  assert.equal(titleEditText(kg, 1234.5), "1234,5");
  assert.equal(titleDisplayText(kg, 1234.5), "1.234,5 kg");
  assert.equal(value(kg, titleDisplayText(kg, 1234.5)), 1234.5);
  assert.equal(titleDisplayText(field("number"), null), "");
  const percent = field("number", { format: "percent" });
  assert.equal(value(percent, titleEditText(percent, 0.15)), 0.15);
  const members = [{ id: "u1", name: "Anna", email: "a@x.org" }];
  assert.equal(titleDisplayText(field("person"), "u1", { members }), "Anna");
  assert.equal(titleEditText(field("person"), "u1", { members }), "Anna");
  assert.equal(titleEditText(field("multiselect"), ["a", "b"]), "a, b");
  assert.equal(titleDisplayText(field("text"), "Hallo"), "Hallo");
});

test("placeholders say what to type", () => {
  assert.equal(titlePlaceholder(field("date"), de), "Datum, z. B. 23.11.2026");
  assert.equal(titlePlaceholder(field("number", { unit: "kg" }), en), "Number, e.g. 12 kg");
  assert.equal(titlePlaceholder(field("text"), en), "Untitled");
});
