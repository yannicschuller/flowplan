import { test } from "node:test";
import assert from "node:assert/strict";
import { publicFieldIds } from "../lib/shared-content";
import { formulaReferences } from "../lib/formula";
import type { Field } from "../lib/types";

test("formulas are public only when everything they read is public", () => {
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "price", name: "Preis", type: "number" },
    { id: "qty", name: "Menge", type: "number" },
    { id: "owner", name: "Zuständig", type: "person" },
    {
      id: "total",
      name: "Summe",
      type: "formula",
      formula: 'prop("price") * prop("qty")',
    },
    {
      id: "double",
      name: "Doppelt",
      type: "formula",
      formula: 'prop("Summe") * 2',
    },
    {
      id: "who",
      name: "Wer",
      type: "formula",
      formula: 'concat("Von ", prop("owner"))',
    },
    {
      id: "dyn",
      name: "Dynamisch",
      type: "formula",
      formula: 'prop(concat("pri", "ce"))',
    },
    { id: "a", name: "A", type: "formula", formula: 'prop("b")' },
    { id: "b", name: "B", type: "formula", formula: 'prop("a")' },
    { id: "broken", name: "Kaputt", type: "formula", formula: "1 +" },
    { id: "missing", name: "Fehlt", type: "formula", formula: 'prop("gone")' },
    { id: "clock", name: "Heute", type: "formula", formula: "today()" },
  ];
  assert.deepEqual([...publicFieldIds(fields)].sort(), [
    "clock",
    "double",
    "price",
    "qty",
    "title",
    "total",
  ]);
  const refs = formulaReferences('prop("x") + y')!;
  assert.deepEqual([refs.names.sort(), refs.dynamic], [["x", "y"], false]);
  assert.equal(formulaReferences("1 +"), null);
});
