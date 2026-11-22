// Flow diagrams (#427): the text format, the layout, the SVG, the stored
// block's cleaning, the Markdown round trip and the database chart kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Row } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-flow-"));
const { parseAmount, parseFlow, flowGraph, layoutFlow, flowSvg, flowSourceSvg, flowFormat, flowFenceMeta, flowFenceUnit, isFlowSource, cleanFlowSource, MAX_FLOWS, MAX_FLOW_SOURCE } = await import(
  "../lib/flow-diagram"
);
const { cleanHtml, htmlState } = await import("../lib/document-server");
const { htmlToMarkdown } = await import("../lib/markdown");
const { markdownToRawHtml } = await import("../lib/markdown-html");
const { chartConfigError, chartFlows, chartSchema, defaultChart } = await import("../lib/database-chart");

const de = (text: string) => text;
const SALARY = "Hauptjob -> Budget: 2.750,00\nNebenjob → Budget: 550\nBudget -> Fixkosten: 1.100\nBudget -> Sparen: 1250\nBudget -> Konsum: 950\nFixkosten #f5c542";

test("amounts: decimal commas and points, thousands, currencies", () => {
  for (const [raw, value] of [
    ["2750", 2750],
    ["2.750,00", 2750],
    ["2,750.50", 2750.5],
    ["1.100", 1100],
    ["1,100", 1100],
    ["0,125", 0.125],
    ["12,5", 12.5],
    ["1'000", 1000],
    ["1 234 567,8", 1234567.8],
    ["€ 99", 99],
    ["99 EUR", 99],
    ["-5", -5],
  ] as const)
    assert.equal(parseAmount(raw), value, raw);
  for (const raw of ["", "abc", "1,2,3", "1.", "1.2.3,4,5", "12..5", "1e5"]) assert.equal(parseAmount(raw), null, raw);
});

test("the text: flows, colours, comments, equal pairs add up", () => {
  const graph = parseFlow(`${SALARY}\n// a comment\n\nHauptjob -> Budget: 250`, de);
  assert.deepEqual(graph.errors, []);
  assert.deepEqual(graph.order, ["Hauptjob", "Budget", "Nebenjob", "Fixkosten", "Sparen", "Konsum"]);
  assert.deepEqual(graph.flows[0], { source: "Hauptjob", target: "Budget", value: 3000 });
  assert.equal(graph.flows.length, 5);
  assert.equal(graph.colors.Fixkosten, "#f5c542");
  assert.equal(parseFlow("A => B: 1\nB #abc", de).colors.B, "#aabbcc");
});

test("the text: every unusable line gives an error with its line number", () => {
  const graph = parseFlow(["A -> B: 10", "B -> C: 5", "C -> A: 1", "A -> A: 3", "A -> D: -4", "A -> D", "A -> D: viel", "just text", `${"x".repeat(61)} -> B: 1`].join("\n"), de);
  assert.deepEqual(
    graph.errors.map((e) => e.line),
    [3, 4, 5, 6, 7, 8, 9],
  );
  assert.match(graph.errors[0].message, /Kreis \(C → A → B → C\)/);
  assert.match(graph.errors[1].message, /Quelle und Ziel sind gleich/);
  assert.match(graph.errors[2].message, /Negative/);
  assert.match(graph.errors[3].message, /Betrag fehlt/);
  assert.match(graph.errors[4].message, /„viel“ ist keine Zahl/);
  assert.equal(graph.flows.length, 2);
  // English messages from the same parser.
  assert.match(parseFlow("A -> A: 1", (_de, en) => en).errors[0].message, /^Source and target are the same/);
  // At most MAX_FLOWS distinct flows.
  const many = Array.from({ length: MAX_FLOWS + 5 }, (_, i) => `S -> T${i}: 1`).join("\n");
  const limited = parseFlow(many, de);
  assert.equal(limited.flows.length, MAX_FLOWS);
  assert.equal(limited.errors.length, 5);
});

test("flows from elsewhere: summed, the unusable ones counted", () => {
  const graph = flowGraph([
    { source: "A", target: "B", value: 2 },
    { source: "A", target: "B", value: 3 },
    { source: "B", target: "A", value: 1 },
    { source: "C", target: "C", value: 1 },
    { source: "C", target: "B", value: -1 },
  ]);
  assert.deepEqual(graph.flows, [{ source: "A", target: "B", value: 5 }]);
  assert.equal(graph.dropped, 3);
});

test("the layout: columns by longest path, one scale, conserved bands", () => {
  const graph = parseFlow("A -> B: 60\nA -> C: 40\nB -> C: 20\nC -> D: 60", de);
  const layout = layoutFlow(graph);
  const node = (name: string) => layout.nodes.find((n) => n.name === name)!;
  assert.deepEqual(
    ["A", "B", "C", "D"].map((n) => node(n).column),
    [0, 1, 2, 3],
  );
  // A node is as high as the larger of its in- and outflow, on one scale.
  const ky = node("A").height / 100;
  assert.ok(Math.abs(node("C").height - 60 * ky) < 1e-6);
  assert.ok(Math.abs(node("B").height - 60 * ky) < 1e-6);
  // The bands leaving a node fill it from its top, without gaps.
  const out = layout.links.filter((l) => layout.nodes[l.source].name === "A").sort((a, b) => a.sy - b.sy);
  assert.ok(Math.abs(out[0].sy - node("A").y) < 1e-6);
  assert.ok(Math.abs(out[1].sy - (out[0].sy + out[0].width)) < 1e-6);
  // Everything inside the picture.
  for (const n of layout.nodes) assert.ok(n.y >= 0 && n.y + n.height <= layout.height && n.x >= 0 && n.x < layout.width, n.name);
  // Tiny flows still get a visible band.
  const tiny = layoutFlow(parseFlow("A -> B: 1000000\nA -> C: 0.001", de));
  assert.ok(tiny.links.every((l) => l.width >= 1));
});

test("the layout: fewer crossings by sorting each column", () => {
  // Without sorting, X's band (to the lower target) would cross Y's.
  const graph = parseFlow("X -> Q: 10\nY -> P: 10\nZ -> P: 1", de);
  const layout = layoutFlow({ ...graph, order: ["X", "Y", "Z", "P", "Q"] });
  const y = (name: string) => layout.nodes.find((n) => n.name === name)!.y;
  assert.ok(y("X") < y("Y"));
  assert.ok(y("Q") < y("P"));
});

test("numbers as the reader's language writes them", () => {
  assert.equal(flowFormat("€", "de-DE")(1100).replace(/\s/g, " "), "1.100,00 €");
  assert.equal(flowFormat("€", "en-GB")(1100), "€1,100.00");
  assert.equal(flowFormat("kWh", "de-DE", [12.5])(12.5).replace(/\s/g, " "), "12,50 kWh");
  assert.equal(flowFormat("", "en-US", [3])(2750), "2,750");
  assert.equal(flowFormat("CHF", "de-CH")(5).replace(/\s/g, " "), "CHF 5.00");
});

test("the SVG: escaped text, no scripts or style attributes", () => {
  const svg = flowSourceSvg('<img src=x onerror=alert(1)> -> "B&C": 5\n<img src=x onerror=alert(1)> #f00', { unit: "<b>", t: de });
  assert.match(svg, /^<svg class="flow-svg"/);
  assert.doesNotMatch(svg, /<img|<b>|style=|<script/);
  assert.match(svg, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(svg, /&quot;B&amp;C&quot;/);
  assert.match(svg, /fill="#ff0000"/);
  // A fixed size for exports, the box's width in the app.
  assert.match(flowSourceSvg("A -> B: 1", { fixedSize: true }), /width="\d+" height="\d+"/);
  assert.match(flowSourceSvg("A -> B: 1"), /width="100%"/);
  // No flows: a hint instead of an empty picture.
  assert.match(flowSvg(parseFlow("", de), { t: de }), /flow-empty[\s\S]*Noch keine Flüsse/);
});

test("stored HTML: the block keeps its text and unit within limits, only on a <div>", () => {
  const source = "A -> B: 1\r\nB -> C: 1\u0007";
  const html = cleanHtml(`<div data-flow-diagram="${source}" data-flow-unit=" €\u0001 " class="flow-diagram" onclick="x()"></div><p data-flow-diagram="A -> B: 1">x</p>`);
  assert.equal(html, '<div class="flow-diagram" data-flow-diagram="A -&gt; B: 1\nB -&gt; C: 1" data-flow-unit="€"></div><p>x</p>');
  assert.ok(htmlState(html).length > 0);
  const long = cleanHtml(`<div data-flow-diagram="${"A -> B: 1\n".repeat(2000)}" data-flow-unit="${"x".repeat(40)}"></div>`);
  const stored = /data-flow-diagram="([^"]*)"/.exec(long)![1].replaceAll("&gt;", ">");
  assert.equal(stored.length, MAX_FLOW_SOURCE);
  assert.match(long, /data-flow-unit="x{16}"/);
  assert.equal(cleanFlowSource("a\tb\r\nc"), "a\tb\nc");
});

test("Markdown: a ```flow fence with its unit, read back as the block", () => {
  const attr = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  for (const unit of ["€", "Mio. €", ""]) {
    const html = cleanHtml(`<p>Vorher</p><div data-flow-diagram="${attr(SALARY)}" data-flow-unit="${attr(unit)}" class="flow-diagram"></div>`);
    const markdown = htmlToMarkdown(html, { url: () => null, linked: () => null }).trimEnd();
    assert.equal(markdown, `Vorher\n\n\`\`\`flow${flowFenceMeta(unit) ? ` ${flowFenceMeta(unit)}` : ""}\n${SALARY}\n\`\`\``);
    const back = cleanHtml(markdownToRawHtml(markdown));
    assert.equal(/data-flow-diagram="([^"]*)"/.exec(back)?.[1], attr(SALARY));
    assert.equal(/data-flow-unit(?:="([^"]*)")?/.exec(back)?.[1] ?? "", attr(unit));
  }
  assert.equal(flowFenceUnit('unit="Mio. €" other=1'), "Mio. €");
  assert.equal(flowFenceUnit("unit=kWh"), "kWh");
  // Code of the Flow language (or anything not fully understood) stays code.
  assert.equal(isFlowSource("// @flow\ntype A = number;"), false);
  assert.match(markdownToRawHtml("```flow\n// @flow\nconst a: number = 1;\n```"), /<pre/);
  assert.match(markdownToRawHtml("```flow\nA -> B: 1\nnope\n```"), /<pre/);
});

const fields: Field[] = [
  { id: "title", name: "Name", type: "title" },
  { id: "from", name: "Von", type: "select" },
  { id: "to", name: "Nach", type: "select" },
  { id: "amount", name: "Betrag", type: "number" },
  { id: "tags", name: "Tags", type: "multi_select" },
] as Field[];
const row = (id: string, cells: Record<string, unknown>) => ({ id, cells: { title: id, ...cells } }) as unknown as Row;

test("database chart: records flow from source to target", () => {
  const config = { ...defaultChart(fields), kind: "flow" as const, xField: "from", targetField: "to", aggregate: "sum" as const, yField: "amount", unit: "€" };
  assert.equal(chartSchema.safeParse(config).success, true);
  assert.equal(chartSchema.safeParse({ ...config, unit: "x".repeat(17) }).success, false);
  assert.equal(chartConfigError(config, fields), null);
  assert.match(chartConfigError({ ...config, targetField: "from" }, fields)!, /Ziel/);
  assert.match(chartConfigError({ ...config, targetField: undefined }, fields)!, /Ziel/);
  assert.match(chartConfigError({ ...config, xField: undefined }, fields)!, /Quelle/);
  assert.match(chartConfigError({ ...config, aggregate: "average" }, fields)!, /zählen/);
  assert.match(chartConfigError({ ...config, yField: "tags" }, fields)!, /Betrag/);
  const rows = [
    row("r1", { from: "Lohn", to: "Budget", amount: 2000 }),
    row("r2", { from: "Lohn", to: "Budget", amount: "750" }),
    row("r3", { from: "Budget", to: "Miete", amount: 900 }),
    row("r4", { from: "Budget", to: "Lohn", amount: 5 }),
    row("r5", { from: "Budget", to: "Essen", amount: "" }),
    row("r6", { from: "", to: "Essen", amount: 10 }),
  ];
  const { flows, graph } = chartFlows(rows, fields, config);
  assert.deepEqual(
    flows.map((f) => [f.source, f.target, f.value, f.rows.map((r) => r.id)]),
    [
      ["Lohn", "Budget", 2750, ["r1", "r2"]],
      ["Budget", "Miete", 900, ["r3"]],
      ["Budget", "Lohn", 5, ["r4"]],
      ["Ohne Wert", "Essen", 10, ["r6"]],
    ],
  );
  // Budget -> Lohn closes a cycle: left out of the picture, counted.
  assert.equal(graph.flows.length, 3);
  assert.equal(graph.dropped, 1);
  // Counting, without records lacking a value.
  const counted = chartFlows(rows, fields, { ...config, aggregate: "count", includeEmpty: false });
  assert.deepEqual(
    counted.flows.map((f) => [f.source, f.target, f.value]),
    [
      ["Lohn", "Budget", 2],
      ["Budget", "Miete", 1],
      ["Budget", "Lohn", 1],
      ["Budget", "Essen", 1],
    ],
  );
  // Multi-value cells: one flow per combination.
  const multi = chartFlows([row("m", { from: "Lohn", tags: ["a", "b"] })], fields, { ...config, targetField: "tags", aggregate: "count" });
  assert.deepEqual(
    multi.flows.map((f) => f.target),
    ["a", "b"],
  );
  // Other kinds give nothing.
  assert.deepEqual(chartFlows(rows, fields, { ...config, kind: "bar" }).flows, []);
});
