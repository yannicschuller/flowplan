import { test } from "node:test";
import assert from "node:assert/strict";
import {
  builderCanShow,
  dateRange,
  fromBuilder,
  inDateRange,
  isClassicQuery,
  joinDate,
  joinPropValue,
  normalizeQuery,
  parseQuery,
  possibleTypes,
  queryText,
  splitDate,
  splitPropValue,
  toBuilder,
  type QueryNode,
} from "../lib/collection-query";

const tree = (q: string) => parseQuery(q).node;

test("AND binds tighter than OR, NOT tightest; parentheses group", () => {
  assert.deepEqual(tree("#a #b OR #c"), {
    type: "or",
    items: [{ type: "and", items: [{ type: "tag", value: "a" }, { type: "tag", value: "b" }] }, { type: "tag", value: "c" }],
  });
  assert.deepEqual(tree("#a (#b OR #c)"), {
    type: "and",
    items: [{ type: "tag", value: "a" }, { type: "or", items: [{ type: "tag", value: "b" }, { type: "tag", value: "c" }] }],
  });
  assert.deepEqual(tree("#a | #b"), tree("#a OR #b"));
  assert.deepEqual(tree("NOT #a AND #b"), { type: "and", items: [{ type: "tag", value: "a", not: true }, { type: "tag", value: "b" }] });
  assert.deepEqual(tree("-(#a OR #b)"), { type: "or", items: [{ type: "tag", value: "a" }, { type: "tag", value: "b" }], not: true });
  assert.deepEqual(tree("NOT NOT #a"), { type: "tag", value: "a" });
  // The issue's example: created by Anna, tagged X and Y, but not Z.
  assert.deepEqual(tree("created_by:Anna #X #Y -#Z"), {
    type: "and",
    items: [
      { type: "creator", value: "Anna" },
      { type: "tag", value: "X" },
      { type: "tag", value: "Y" },
      { type: "tag", value: "Z", not: true },
    ],
  });
});

test("words next to each other are one phrase; AND and quotes keep them apart", () => {
  assert.deepEqual(tree("Rechnung offen"), { type: "text", value: "Rechnung offen" });
  assert.deepEqual(tree("Rechnung AND offen"), { type: "and", items: [{ type: "text", value: "Rechnung" }, { type: "text", value: "offen" }] });
  assert.deepEqual(tree('"Rechnung offen" #x'), { type: "and", items: [{ type: "text", value: "Rechnung offen" }, { type: "tag", value: "x" }] });
  assert.deepEqual(tree("-entwurf"), { type: "text", value: "entwurf", not: true });
  // A minus inside a word or before a number is part of it.
  assert.deepEqual(tree("e-mail -5"), { type: "text", value: "e-mail -5" });
  // Lower-case or/and are words.
  assert.deepEqual(tree("rock or roll"), { type: "text", value: "rock or roll" });
});

test("keys: creator, editor, dates, type, in, title; others are properties", () => {
  assert.deepEqual(tree("creator:me updated_by:Ben editor:x"), {
    type: "and",
    items: [
      { type: "creator", value: "me" },
      { type: "editor", value: "Ben" },
      { type: "editor", value: "x" },
    ],
  });
  assert.deepEqual(tree('in:"Team Space" title:Angebot type:Record'), {
    type: "and",
    items: [
      { type: "in", value: "Team Space" },
      { type: "title", value: "Angebot" },
      { type: "type", value: "record" },
    ],
  });
  assert.deepEqual(tree("type:document|database"), {
    type: "or",
    items: [
      { type: "type", value: "document" },
      { type: "type", value: "database" },
    ],
  });
  assert.deepEqual(tree("created:-7d updated:>=2026-01-01"), {
    type: "and",
    items: [
      { type: "created", value: "-7d" },
      { type: "updated", value: ">=2026-01-01" },
    ],
  });
  // A property named like a key: its name in quotes.
  assert.deepEqual(tree('"Type":Buch'), { type: "prop", name: "Type", value: "Buch" });
  // An empty key is left out.
  assert.equal(tree("created:"), null);
});

test("queries from before #86 read the same and stay classic", () => {
  const old: [string, QueryNode | null][] = [
    ["#Projekt", { type: "tag", value: "Projekt" }],
    ["-#Archiv", { type: "tag", value: "Archiv", not: true }],
    ['#"zwei Wörter"', { type: "tag", value: "zwei Wörter" }],
    ["Status:Erledigt", { type: "prop", name: "Status", value: "Erledigt" }],
    ['"Lange Eigenschaft":"ein Wert"', { type: "prop", name: "Lange Eigenschaft", value: "ein Wert" }],
    ["Status:*", { type: "prop", name: "Status", value: "*" }],
    ["Status:-", { type: "prop", name: "Status", value: "-" }],
    ['Status:""', { type: "prop", name: "Status", value: "", quoted: true }],
    ["Owner:me", { type: "prop", name: "Owner", value: "me" }],
    ["Preis:>=10", { type: "prop", name: "Preis", value: ">=10" }],
    ["Fällig:2026-01-01..2026-02-01", { type: "prop", name: "Fällig", value: "2026-01-01..2026-02-01" }],
    ["#Projekt, weiter", { type: "and", items: [{ type: "tag", value: "Projekt" }, { type: "text", value: "weiter" }] }],
    ["", null],
  ];
  for (const [query, expected] of old) {
    const parsed = parseQuery(query);
    assert.deepEqual(parsed.node, expected, query);
    assert.deepEqual(parsed.errors, [], query);
    assert.equal(isClassicQuery(parsed.node), true, query);
  }
  for (const query of ["#a OR #b", "-entwurf", "created:-7d", "type:record", "a AND b", "(#a)", "-Status:x"].slice(0, 7))
    assert.equal(isClassicQuery(tree(query)), query === "(#a)", query);
});

test("broken queries are repaired and reported", () => {
  assert.deepEqual(parseQuery("(#a OR #b").node, { type: "or", items: [{ type: "tag", value: "a" }, { type: "tag", value: "b" }] });
  assert.deepEqual(parseQuery("(#a OR #b").errors, ["close"]);
  assert.deepEqual(parseQuery("#a) #b").errors, ["open"]);
  assert.deepEqual(parseQuery("#a OR").errors, ["or"]);
  assert.equal(builderCanShow("#a OR"), false);
  assert.equal(builderCanShow("#a OR (#b -#c)"), true);
  assert.equal(builderCanShow("((((#a OR #b) #c) OR #d) #e) OR #f"), false);
});

test("text form: canonical, stable and equivalent", () => {
  const cases: [string, string][] = [
    ["#a #b OR #c", "(#a #b) OR #c"],
    ["NOT #a and", "-#a and"],
    ["Rechnung AND offen", "Rechnung AND offen"],
    ["Rechnung offen", "Rechnung offen"],
    ['"Rechnung offen" -#x', "Rechnung offen -#x"],
    ['-"zwei worte"', '-"zwei worte"'],
    ["creator:me", "created_by:me"],
    ["editor:Ben", "updated_by:Ben"],
    ['in:"Team Space"', 'in:"Team Space"'],
    ['"Type":Buch', '"Type":Buch'],
    ['"Lange Eigenschaft":"ein Wert"', '"Lange Eigenschaft":"ein Wert"'],
    ['Status:""', 'Status:""'],
    ["type:document|database", "type:document OR type:database"],
    ["#a (#b OR #c)", "#a (#b OR #c)"],
    ["NOT (#a #b)", "-(#a #b)"],
    ['"OR"', '"OR"'],
    ['"a:b"', '"a:b"'],
    ['#"zwei Wörter"', '#"zwei Wörter"'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeQuery(input), expected, input);
    // Writing it back changes nothing in meaning.
    assert.deepEqual(tree(expected), tree(input), input);
    assert.equal(normalizeQuery(expected), expected, input);
  }
});

test("builder and text round trip", () => {
  const queries = [
    "created_by:Anna #X #Y -#Z",
    "(#a #b) OR -(#c OR updated:this-week)",
    'Status:Erledigt Preis:>5 "Fällig am":-7d in:"Team" title:Angebot type:record',
    "Rechnung offen -entwurf",
    "Rechnung AND offen",
    'Status:"" Owner:me',
  ];
  for (const q of queries) {
    const builder = toBuilder(tree(q));
    assert.equal(builder.type === "and" || builder.type === "or", true);
    const back = fromBuilder(JSON.parse(JSON.stringify(builder)));
    assert.equal(queryText(back), normalizeQuery(q), q);
    // And the text of the builder parses to the same builder.
    assert.deepEqual(toBuilder(tree(queryText(back))), toBuilder(back), q);
  }
  // Empty conditions and groups are left out.
  assert.equal(
    queryText(
      fromBuilder({
        type: "or",
        items: [
          { type: "tag", value: "a" },
          { type: "text", value: " " },
          { type: "and", items: [{ type: "creator", value: "" }] },
          { type: "and", items: [{ type: "tag", value: "b", not: true }, { type: "type", value: "record" }] },
        ],
      }),
    ),
    "#a OR (-#b type:record)",
  );
  assert.equal(fromBuilder({ type: "and", items: [] }), null);
  // A single condition of a negated group carries the NOT.
  assert.equal(queryText(fromBuilder({ type: "and", not: true, items: [{ type: "tag", value: "a" }] })), "-#a");
});

test("relative and absolute dates with a fixed now", () => {
  // Monday, 2 November 2026, 10:00 UTC (11:00 in Berlin).
  const now = new Date("2026-11-02T10:00:00Z");
  const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;
  const r = (expr: string, zone = "UTC") => {
    const range = dateRange(expr, now, zone);
    return range && [range.start, range.end];
  };
  assert.deepEqual(r("today"), [day("2026-11-02"), day("2026-11-03")]);
  assert.deepEqual(r("yesterday"), [day("2026-11-01"), day("2026-11-02")]);
  assert.deepEqual(r("-7d"), [day("2026-10-27"), day("2026-11-03")]);
  assert.deepEqual(r("-2w"), [day("2026-10-20"), day("2026-11-03")]);
  assert.deepEqual(r("-3m"), [day("2026-08-03"), day("2026-11-03")]);
  assert.deepEqual(r("-1y"), [day("2025-11-03"), day("2026-11-03")]);
  assert.deepEqual(r("this-week"), [day("2026-11-02"), day("2026-11-09")]);
  assert.deepEqual(r("last-week"), [day("2026-10-26"), day("2026-11-02")]);
  assert.deepEqual(r("this_month"), [day("2026-11-01"), day("2026-12-01")]);
  assert.deepEqual(r("last-month"), [day("2026-10-01"), day("2026-11-01")]);
  assert.deepEqual(r("last-year"), [day("2025-01-01"), day("2026-01-01")]);
  assert.deepEqual(r("2026"), [day("2026-01-01"), day("2027-01-01")]);
  assert.deepEqual(r("2026-02"), [day("2026-02-01"), day("2026-03-01")]);
  assert.deepEqual(r("2026-02-28"), [day("2026-02-28"), day("2026-03-01")]);
  assert.equal(r("2026-02-30"), null);
  assert.equal(r("someday"), null);
  assert.deepEqual(r(">2026-01-01"), [day("2026-01-02"), Infinity]);
  assert.deepEqual(r("<=2026-01"), [-Infinity, day("2026-02-01")]);
  assert.deepEqual(r("<-30d"), [-Infinity, day("2026-10-04")]);
  assert.deepEqual(r("2026-01-01..2026-01-31"), [day("2026-01-01"), day("2026-02-01")]);
  // Late on Sunday in New York is already Monday in UTC.
  const sunday = new Date("2026-11-02T03:00:00Z");
  assert.equal(dateRange("today", sunday, "America/New_York")!.start, day("2026-11-01"));
  // Stored times are UTC; the day is the reader's.
  const today = dateRange("today", sunday, "America/New_York")!;
  assert.equal(inDateRange("2026-11-02 02:00:00", today, "America/New_York"), true);
  assert.equal(inDateRange("2026-11-02 02:00:00", today, "UTC"), false);
  assert.equal(inDateRange(null, today), false);
});

test("the builder's date and property operators", () => {
  for (const value of ["-7d", "-2w", "this-week", "2026-01-01", "<2026-01-01", ">2026-01-01", "2026-01-01..2026-02-01", "2026-03"])
    assert.equal(joinDate(splitDate(value)), value, value);
  assert.deepEqual(splitDate("-30d"), { mode: "last", n: 30, unit: "d" });
  assert.deepEqual(splitDate("2026-03"), { mode: "custom", value: "2026-03" });
  for (const value of ["Done", ">5", "<=2", "1..5", "*", "-"]) {
    const parts = splitPropValue(value);
    assert.equal(joinPropValue(parts.op, parts.value, parts.to).value, value, value);
  }
  assert.deepEqual(splitPropValue("", true), { op: "empty", value: "" });
  assert.deepEqual(joinPropValue("is", "*"), { value: "*", quoted: true });
});

test("type: limits the kinds of items looked at", () => {
  assert.deepEqual([...possibleTypes(tree("type:record #a"))!], ["record"]);
  assert.deepEqual([...possibleTypes(tree("type:document|whiteboard"))!].sort(), ["dashboard", "document", "journal", "notebook", "whiteboard"]);
  assert.equal(possibleTypes(tree("#a OR type:record")), null);
  assert.equal(possibleTypes(tree("-type:record")), null);
});
