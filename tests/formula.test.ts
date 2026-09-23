import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formula,
  evaluateFormula,
  compileFormula,
  validateFormula,
  rewriteFormulaReferences,
  FormulaFault,
  hasClockFormulas,
} from "../lib/formula";
import { numericSummary } from "../lib/database-summary";
import { formulaFunctions } from "../lib/formula-catalog";
import {
  formulaSuggestions,
  formulaCompletionRange,
  insertFormulaSuggestion,
} from "../lib/formula-suggestions";
import {
  computedCells,
  computedCellsDetailed,
  queryRows,
} from "../lib/database";
import type { Field, Row, Identity, View } from "../lib/types";

const fixed = { now: new Date("2026-09-23T23:30:00Z") };
test("time-dependent formulas include related schemas but ignore function names inside literals", () => {
  const field = (formula: string): Field => ({
    id: "f",
    name: "F",
    type: "formula",
    formula,
  });
  assert.equal(hasClockFormulas([field('"now()"')]), false);
  assert.equal(hasClockFormulas([field('formatDate(NOW(), "YYYY")')]), true);
  assert.equal(
    hasClockFormulas([], { related: [field('if(true, today(), "")')] }),
    true,
  );
  assert.equal(hasClockFormulas([field("now(")]), false);
});
test("numeric summaries include computed numbers, disclose errors and reject mixed text results", () => {
  const f: Field = { id: "f", name: "F", type: "formula" };
  const rows = (...values: unknown[]) => values.map((f) => row({ f }));
  assert.deepEqual(numericSummary(f, rows(100, 60, null, "#DIV/0")), {
    sum: 160,
    count: 2,
    errors: 1,
  });
  assert.equal(numericSummary(f, rows(100, "60")), null);
  assert.equal(numericSummary(f, rows([1, 2])), null);
  assert.equal(numericSummary(f, rows(null)), null);
  assert.deepEqual(numericSummary({ ...f, type: "number" }, rows("3", 2)), {
    sum: 5,
    count: 2,
    errors: 0,
  });
  assert.equal(
    numericSummary(f, rows(Number.MAX_VALUE, Number.MAX_VALUE))?.sum,
    null,
  );
});
function row(cells: Record<string, unknown>): Row {
  return {
    id: "row",
    page_id: "page",
    cells,
    position: 0,
    created_at: "",
    updated_at: "",
    created_by: "",
    updated_by: "",
    version: 1,
  };
}
test("formula lexer consumes every character and reports the exact invalid source span", () => {
  for (const source of [
    "1 @ + 2",
    "1 ^ 2",
    "1 2",
    "1 +",
    "sum(1,)",
    "unknown(1)",
    '"unclosed',
    '"bad\\q"',
    '"bad\\u123"',
    "sum(1 {)}",
    "(1 {)}",
    "{}",
    "1e",
    "1..2",
    "",
  ]) {
    const result = compileFormula(source);
    assert.equal(result.ok, false, source);
  }
  const result = evaluateFormula("1 @ + 2", {});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.start, 2);
    assert.equal(result.error.end, 3);
    assert.match(result.error.message, /Ungültiges Zeichen/);
  }
  assert.equal(formula(".5 + 1e2 - +2", {}), 98.5);
  assert.equal(formula("{)} + {+}", { ")": 3, "+": 4 }), 7);
  assert.equal(formula("Größe * 2", { Größe: 3 }), 6);
  assert.equal(formula("{Netto Aufwand} + 1", { "Netto Aufwand": 4 }), 5);
});
test("formula strings decode escapes and cannot execute JavaScript or access object properties", () => {
  assert.equal(formula('"A\\nB\\t\\u00e4\\uD83D\\uDE00"', {}), "A\nB\tä😀");
  assert.equal(formula("'it\\'s \\\\ fine'", {}), "it's \\ fine");
  for (const source of [
    "globalThis.process.exit()",
    'constructor("return process")()',
    'prop("x").constructor',
    'prop("x")[0]',
    "(()=>1)()",
    "new Date()",
  ])
    assert.equal(formula(source, { x: [1] }), "#ERROR", source);
  assert.equal(formula("toString", {}), "#PROPERTY");
  assert.equal(formula('prop("__proto__")', {}), "#PROPERTY");
});
test("every documented function example works and arities are validated even in inactive branches", () => {
  assert.equal(formulaFunctions.length, 58);
  assert.equal(
    new Set(formulaFunctions.map((f) => f.name.toLowerCase())).size,
    58,
  );
  for (const fn of formulaFunctions) {
    const result = evaluateFormula(fn.example, { Aufwand: 4 }, fixed);
    assert.equal(result.ok, true, `${fn.name}: ${JSON.stringify(result)}`);
  }
  for (const source of [
    "prop()",
    "round(1, 2, 3)",
    "if(true, 1)",
    "ifs(true, 1)",
    "now(1)",
    "if(false, unknown(), 1)",
    "if(false, round(), 1)",
  ])
    assert.equal(formula(source, {}), "#ERROR", source);
  assert.equal(formula("RoUnD(10 / 3, 2)", {}), 3.33);
});
test("conditional functions and boolean operators resolve only necessary dependencies", () => {
  let reads = 0;
  const cells = Object.defineProperty({}, "forbidden", {
    get() {
      reads++;
      throw new FormulaFault({
        code: "#ACCESS",
        message: "Keine Freigabe",
        start: 0,
        end: 0,
      });
    },
  });
  const cases: [string, unknown][] = [
    ["if(false, forbidden, 9)", 9],
    ["if(true, 9, forbidden)", 9],
    ["ifs(false, forbidden, true, 7, forbidden)", 7],
    ["false && forbidden", false],
    ["true || forbidden", true],
    ["and(false, forbidden)", false],
    ["or(true, forbidden)", true],
    ['coalesce("", false, forbidden)', false],
    ["coalesce(null, 0, forbidden)", 0],
    ["if(false, 1 / 0, 5)", 5],
  ];
  for (const [source, expected] of cases)
    assert.deepEqual(formula(source, cells), expected, source);
  assert.equal(reads, 0);
  assert.equal(formula("if(true, forbidden, 9)", cells), "#ACCESS");
  assert.equal(reads, 1);
  assert.equal(formula("false || 1 / 0", cells), "#DIV/0");
});
test("numeric functions preserve legacy results, reject invalid types and propagate arithmetic failures", () => {
  const cases: [string, unknown][] = [
    ['sum(1, list(2, "3"), null, false)', 6],
    ["average(2, 4, 6)", 4],
    ["min(3, 1, 2)", 1],
    ["max(3, 1, 2)", 3],
    ["ceil(-2.4)", -2],
    ["floor(-2.4)", -3],
    ["sqrt(9)", 3],
    ["pow(2, 8)", 256],
    ["sign(-2)", -1],
    ["abs(-3)", 3],
    ["mod(-10, 3)", -1],
    ['toNumber("12.5") + 1', 13.5],
    ["round(10 / 3, 2)", 3.33],
    ["10 / 2 / 5", 1],
    ["2 + 3 * 4", 14],
    ["(1 / 0) + 1", "#DIV/0"],
    ["1 % 0", "#DIV/0"],
    ["mod(1, 0)", "#DIV/0"],
    ["sqrt(-1)", "#ERROR"],
    ["pow(10, 400)", "#ERROR"],
    ['sum("abc")', "#ERROR"],
    ["toNumber(list(1))", "#ERROR"],
    ["round(1.2, -1)", "#ERROR"],
    ["min(list())", "#ERROR"],
    ["round(1, 11)", "#ERROR"],
  ];
  for (const [source, expected] of cases)
    assert.equal(formula(source, {}), expected, source);
});
test("text and list functions remain bounded, use literal replacements and preserve input lists", () => {
  const cells = { items: [3, 1, 2] };
  assert.equal(formula('length("😀")', {}), 2);
  assert.equal(formula('replace("aaa", "a", "$&")', {}), "$&aa");
  assert.equal(formula('replaceAll("a.a", "a", "$&")', {}), "$&.$&");
  assert.equal(formula('slice("Flowplan", 4)', {}), "plan");
  assert.equal(formula('trim(upper("  plan  "))', {}), "PLAN");
  assert.equal(formula('lower("PLAN")', {}), "plan");
  assert.equal(
    formula(
      'contains("Flowplan", "plan") && startsWith("Flowplan", "Flow") && endsWith("Flowplan", "plan")',
      {},
    ),
    true,
  );
  assert.equal(formula("empty(null) && !empty(0) && !empty(false)", {}), true);
  assert.equal(formula('join(split("a,b,c", ","), " / ")', {}), "a / b / c");
  assert.deepEqual(formula('unique(list(1, 1, "1", false))', {}), [
    1,
    "1",
    false,
  ]);
  assert.deepEqual(formula("reverse(sort(items))", cells), [3, 2, 1]);
  assert.deepEqual(cells.items, [3, 1, 2]);
  assert.equal(formula("at(items, -1) + first(items) + last(items)", cells), 7);
  assert.equal(formula("at(items, 10)", cells), null);
  assert.equal(formula("first(list())", cells), null);
  assert.equal(formula("count(items)", cells), 3);
  assert.equal(formula('concat("#TODO", " ok")', {}), "#TODO ok");
  assert.equal(formula('repeat("ab", 3)', {}), "ababab");
  assert.equal(formula("format(true)", {}), "true");
});
test("date functions use explicit zones, calendar arithmetic, real elapsed time and one evaluation clock", () => {
  const cases: [string, unknown][] = [
    ["now()", "2026-09-23T23:30:00.000Z"],
    ["today()", "2026-09-23"],
    ['today("Europe/Berlin")', "2026-09-24"],
    ['parseDate("2026-09-23T09:30")', "2026-09-23T09:30:00Z"],
    ['parseDate("2026-09-23T11:30+02:00")', "2026-09-23T09:30:00Z"],
    [
      'formatDate("2026-09-23", "DD.MM.YYYY", "America/New_York")',
      "23.09.2026",
    ],
    [
      'formatDate("2026-09-23T23:30Z", "YYYY-MM-DD HH:mm:ss", "Europe/Berlin")',
      "2026-09-24 01:30:00",
    ],
    ['dateAdd("2026-01-31", 1, "month")', "2026-02-28"],
    ['dateSubtract("2024-02-29", 1, "years")', "2023-02-28"],
    [
      'dateAdd("2026-03-28T08:00Z", 1, "days", "Europe/Berlin")',
      "2026-03-29T07:00:00Z",
    ],
    ['dateBetween("2026-03-29T07:00Z", "2026-03-28T08:00Z", "hours")', 23],
    ['dateBetween("2026-09-23T13:00Z", "2026-09-23T00:00Z")', 1],
    ['dateBetween("2026-09-23T13:00Z", "2026-09-23T00:00Z", "days")', 0],
    ['dateBetween("2026-04-01", "2026-01-01", "months")', 3],
    ['dateBetween("2024-01-01", "2026-01-01", "years")', -2],
    ['year("2026-09-23") + month("2026-09-23") + day("2026-09-23")', 2058],
    [
      'hour("2026-09-23T23:30Z", "Europe/Berlin") + minute("2026-09-23T23:30Z")',
      31,
    ],
    ['timestamp("1970-01-01")', 0],
    ["fromTimestamp(0)", "1970-01-01T00:00:00Z"],
  ];
  for (const [source, expected] of cases)
    assert.equal(formula(source, {}, fixed), expected, source);
  for (const source of [
    'parseDate("2026-02-30")',
    'today("Mars/Olympus")',
    'dateAdd("2026-09-23", 1, "unknown")',
    "fromTimestamp(1e16)",
    'dateAdd("9999-12-31", 1, "days")',
  ])
    assert.equal(formula(source, {}, fixed), "#ERROR", source);
});
test("expression, recursion, collection and output limits reject oversized work", () => {
  assert.equal(formula("x".repeat(2001), {}), "#LIMIT");
  assert.equal(formula("(".repeat(60) + "1" + ")".repeat(60), {}), "#LIMIT");
  assert.equal(formula("1+".repeat(500) + "1", {}), "#LIMIT");
  assert.equal(formula('repeat("x", 20001)', {}), "#LIMIT");
  assert.equal(
    formula('join(items, repeat("x", 20000))', { items: [1, 2, 3] }),
    "#LIMIT",
  );
  assert.equal(
    formula("count(items)", { items: Array(1001).fill(1) }),
    "#LIMIT",
  );
  assert.equal(formula("list(a, a)", { a: "x".repeat(15000) }), "#LIMIT");
  const loop: unknown[] = [];
  loop.push(loop);
  assert.equal(formula("items", { items: loop }), "#LIMIT");
  assert.equal(
    formula("format(items)", { items: ["x".repeat(15000), "x".repeat(15000)] }),
    "#LIMIT",
  );
});
test("reference rewriting binds only property expressions and displays unambiguous names", () => {
  const fields: Field[] = [
    { id: "n", name: "Hours", type: "number" },
    { id: "q", name: 'A "quote"', type: "text" },
  ];
  assert.equal(
    rewriteFormulaReferences('concat("Hours", format(Hours))', fields, "store"),
    'concat("Hours", format(prop("n")))',
  );
  assert.equal(
    rewriteFormulaReferences('prop("n") * 2', fields, "display"),
    'prop("Hours") * 2',
  );
  assert.equal(
    rewriteFormulaReferences('prop("Hours") * 2', fields, "store"),
    'prop("n") * 2',
  );
  const quoted = `prop(${JSON.stringify(fields[1].name)})`;
  assert.equal(rewriteFormulaReferences(quoted, fields, "store"), 'prop("q")');
  assert.equal(
    rewriteFormulaReferences('"literal n"', fields, "store"),
    '"literal n"',
  );
  assert.equal(rewriteFormulaReferences("1 @ + 2", fields, "store"), "1 @ + 2");
  assert.equal(
    validateFormula('prop("Missing")', ["n", "Hours"])?.code,
    "#PROPERTY",
  );
  assert.equal(validateFormula('prop("Hours")', ["n", "Hours"]), null);
  const duplicate = [
    ...fields,
    { id: "m", name: "Hours", type: "number" as const },
  ];
  assert.equal(
    rewriteFormulaReferences('prop("n")', duplicate, "display"),
    'prop("n")',
  );
  assert.equal(
    rewriteFormulaReferences('prop("Hours")', duplicate, "store"),
    'prop("m")',
  );
});
test("formula suggestions replace the cursor token, complete property calls and escape names", () => {
  const fields: Field[] = [
    { id: "n", name: "Aufwand", type: "number" },
    { id: "q", name: 'A "quote"', type: "text" },
  ];
  const number = formulaSuggestions("round", fields).find(
    (s) => s.kind === "function",
  )!;
  assert.deepEqual(insertFormulaSuggestion("2 + rou", 7, 7, number, fields), {
    value: "2 + round()",
    cursor: 10,
  });
  assert.equal(
    insertFormulaSuggestion("round(1.2)", 2, 2, number, fields).value,
    "round(1.2)",
  );
  const property = formulaSuggestions("auf", fields, true)[0];
  const source = '1 + prop("Aufwand") * 2';
  assert.equal(
    insertFormulaSuggestion(source, 13, 13, property, fields).value,
    source,
  );
  assert.equal(formulaCompletionRange('prop("Auf', 9).propertiesOnly, true);
  const quote = formulaSuggestions("quote", fields, true)[0];
  const inserted = insertFormulaSuggestion("", 0, 0, quote, fields).value;
  assert.equal(formula(inserted, { [fields[1].name]: "safe" }), "safe");
  assert.equal(
    formulaSuggestions("DATUM", fields).some(
      (s) => s.kind === "function" && s.name === "parseDate",
    ),
    true,
  );
});
test("computed formulas preserve dependency errors, lazy branches, literal hashtags and stable ID precedence", () => {
  const fields: Field[] = [
    { id: "n", name: "Hours", type: "number" },
    { id: "label", name: "Label", type: "text" },
    {
      id: "double",
      name: "Double",
      type: "formula",
      formula: 'prop("Hours") * 2',
    },
    {
      id: "outer",
      name: "Outer",
      type: "formula",
      formula: 'prop("Double") + 1',
    },
    {
      id: "tag",
      name: "Tag",
      type: "formula",
      formula: 'concat(prop("Label"), " ok")',
    },
    { id: "cycle", name: "Cycle", type: "formula", formula: 'prop("Cycle")' },
    {
      id: "lazy",
      name: "Lazy",
      type: "formula",
      formula: 'if(false, prop("Cycle"), 9)',
    },
    {
      id: "denied",
      name: "Denied",
      type: "rollup",
      relationField: "relation",
      aggregate: "sum",
      rollupField: "n",
    },
    {
      id: "relation",
      name: "Relation",
      type: "relation",
      relationPage: "private",
    },
    {
      id: "private",
      name: "Private",
      type: "formula",
      formula: 'prop("Denied") + 1',
    },
  ];
  const result = computedCellsDetailed(row({ n: 4, label: "#TODO" }), fields);
  assert.equal(result.cells.outer, 9);
  assert.equal(result.cells.tag, "#TODO ok");
  assert.equal(result.cells.cycle, "#CYCLE");
  assert.equal(result.cells.lazy, 9);
  assert.equal(result.cells.private, "#ACCESS");
  assert.match(result.diagnostics.cycle.message, /Kreis/);
  assert.match(result.diagnostics.private.message, /Zugriff/);
  const collision: Field[] = [
    { id: "a", name: "X", type: "number" },
    { id: "b", name: "a", type: "number" },
    { id: "result", name: "Result", type: "formula", formula: 'prop("a")' },
  ];
  assert.equal(computedCells(row({ a: 3, b: 7 }), collision).result, 3);
});
test("computed formula results participate in filters and sorting with a shared clock", () => {
  const fields: Field[] = [
    { id: "n", name: "Hours", type: "number" },
    { id: "total", name: "Total", type: "formula", formula: "n * 2" },
    {
      id: "today",
      name: "Today",
      type: "formula",
      formula: 'today("Europe/Berlin")',
    },
  ];
  const view: View = {
    id: "table",
    name: "Table",
    type: "table",
    filters: [{ field: "total", op: "gt", value: "3" }],
    sorts: [{ field: "total", direction: "desc" }],
  };
  const data = [1, 3, 2].map((n) => ({ ...row({ n }), id: String(n) }));
  const result = queryRows(data, fields, view, "", {}, {}, fixed.now);
  assert.deepEqual(
    result.map((r) => r.cells.total),
    [6, 4],
  );
  assert.equal(result[0].cells.today, "2026-09-24");
});

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-formula-"),
);
const { id, run, one } = await import("../lib/db");
const { command, database, rows, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
const uid = id();
run(
  "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
  uid,
  uid,
  "Formula",
  "formula@test.invalid",
);
const owner: Identity = {
  id: uid,
  name: "Formula",
  email: "formula@test.invalid",
  disabled: 0,
  created_at: "",
  isAdmin: false,
  groups: [],
};
const wid = createWorkspace(uid, "Formula tests"),
  sid = bootstrap(owner, wid).spaces[0].id;
const act = (data: Record<string, unknown>): any => command(owner, data);
test("renaming properties binds legacy references without altering literal text and preserves CAS conflicts", () => {
  const pid = act({
    action: "page.create",
    workspaceId: wid,
    spaceId: sid,
    kind: "database",
    title: "Formula rename",
  }).id;
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "n", name: "Hours", type: "number" },
    {
      id: "total",
      name: "Total",
      type: "formula",
      formula: 'prop("Hours") * 2',
    },
    {
      id: "text",
      name: "Text",
      type: "formula",
      formula: 'concat("Hours", prop("Hours"))',
    },
  ];
  const views: View[] = [
    { id: "table", name: "Table", type: "table", filters: [], sorts: [] },
  ];
  act({ action: "database.update", pageId: pid, version: 1, fields, views });
  act({ action: "row.create", pageId: pid, cells: { n: 3, title: "Example" } });
  const renamed = fields.map((f) =>
    f.id === "n" ? { ...f, name: "Effort" } : f,
  );
  act({
    action: "database.update",
    pageId: pid,
    version: 2,
    fields: renamed,
    views,
  });
  assert.equal(
    database(pid).fields.find((f) => f.id === "total")!.formula,
    'prop("n") * 2',
  );
  assert.equal(computedCells(rows(pid)[0], database(pid).fields).total, 6);
  assert.equal(
    computedCells(rows(pid)[0], database(pid).fields).text,
    "Hours3",
  );
  assert.throws(
    () =>
      act({
        action: "database.update",
        pageId: pid,
        version: 2,
        fields,
        views,
      }),
    /zwischenzeitlich/,
  );
  assert.equal(database(pid).fields.find((f) => f.id === "n")!.name, "Effort");
});
test("formula expressions and stable references survive copies, templates, snapshots and ZIP archives", async () => {
  const pid = act({
    action: "page.create",
    workspaceId: wid,
    spaceId: sid,
    kind: "database",
    title: "Formula persistence",
  }).id;
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "n", name: "Effort", type: "number" },
    {
      id: "result",
      name: "Result",
      type: "formula",
      formula:
        'if(prop("n") > 0, concat("Hours: ", format(sum(prop("n"), 2))), "None")',
    },
  ];
  const views: View[] = [
    { id: "table", name: "Table", type: "table", filters: [], sorts: [] },
  ];
  act({ action: "database.update", pageId: pid, version: 1, fields, views });
  act({ action: "row.create", pageId: pid, cells: { n: 3, title: "Example" } });
  const check = (pageId: string) => {
    assert.equal(
      database(pageId).fields.at(-1)!.formula,
      fields.at(-1)!.formula,
    );
    assert.equal(
      computedCells(rows(pageId)[0], database(pageId).fields).result,
      "Hours: 5",
    );
  };
  check(act({ action: "page.duplicate", pageId: pid }).id);
  const tid = act({ action: "template.save", pageId: pid, name: "Formula" }).id;
  check(
    act({
      action: "page.create",
      workspaceId: wid,
      spaceId: sid,
      title: "Formula template",
      templateId: tid,
    }).id,
  );
  act({ action: "page.snapshot", pageId: pid });
  const snapshot = one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=? ORDER BY rowid DESC",
    pid,
  )!.id;
  act({
    action: "database.update",
    pageId: pid,
    version: database(pid).version,
    fields: fields.slice(0, 2),
    views,
  });
  act({ action: "snapshot.restore", pageId: pid, snapshotId: snapshot });
  check(pid);
  const restored = createWorkspace(uid, "Formula restore");
  const result = await importArchive(
    owner,
    restored,
    await exportArchive(owner, wid),
  );
  check(result.pageIds[pid]);
});
