import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formConfigSchema,
  questionStyle,
  validateFormValues,
} from "../lib/form-settings";
import type { Field } from "../lib/types";

const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "note", name: "Nachricht", type: "text" },
  { id: "topic", name: "Thema", type: "select", options: ["Lob", "Kritik"] },
  { id: "score", name: "Zufriedenheit", type: "number" },
  { id: "phone", name: "Telefon", type: "phone" },
];
const config = formConfigSchema.parse({
  questionStyles: {
    note: "long",
    topic: "buttons",
    score: "scale",
    phone: "scale",
  },
});

test("question styles fit their property types", () => {
  assert.equal(questionStyle(fields[1], config), "long");
  assert.equal(questionStyle(fields[2], config), "buttons");
  assert.equal(questionStyle(fields[3], config), "scale");
  // A scale does not apply to a phone number and is ignored.
  assert.equal(questionStyle(fields[4], config), undefined);
  assert.throws(() =>
    formConfigSchema.parse({ questionStyles: { note: "slider" } }),
  );
});

test("scales, long texts and phone numbers are validated", () => {
  const ok = validateFormValues(fields, config, {
    title: "Kim",
    note: "Zeile eins\nZeile zwei",
    topic: "Lob",
    score: 9,
    phone: "+49 (30) 123-456",
  });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.cells.note, "Zeile eins\nZeile zwei");
  for (const [key, value] of [
    ["score", 11],
    ["score", 0],
    ["score", 2.5],
    ["phone", "bitte anrufen"],
    ["topic", "Anderes"],
  ] as const)
    assert.ok(
      validateFormValues(fields, config, { [key]: value }).errors[key],
      `${key}=${value}`,
    );
  // Without the scale style any number is fine.
  assert.deepEqual(
    validateFormValues(fields, formConfigSchema.parse({}), { score: 42 })
      .errors,
    {},
  );
});
