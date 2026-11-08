// Workflows (#168, docs/specs/workflows.md §5, §7, §2): the graph format and
// its check, placeholders with every filter, values into properties, the
// database rules as graphs and back, the Yjs draft. No database.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { checkGraph, emptyGraph, issueMessage, parseGraph, type WorkflowGraph } from "../lib/workflows/graph";
import { fromDisplay, parseTemplate, renderTemplate, renderText, renderValue, toDisplay, valueText, PlaceholderError, headerSafe, type RenderScope } from "../lib/workflows/placeholders";
import { coerceToField, ValueError, toNumber } from "../lib/workflows/values";
import { automationToGraph, graphToAutomation } from "../lib/workflows/legacy";
import { draftGraph, graphDoc, writeGraph } from "../lib/workflows/draft";
import { catalogJson, NODE_TYPES } from "../lib/workflows/catalog";
import { automationSchema } from "../lib/database-settings-schema";
import type { Field } from "../lib/types";

const node = (id: string, type: string, config: Record<string, unknown> = {}, label = id) => ({ id, type, typeVersion: 1, label, note: "", position: { x: 0, y: 0 }, disabled: false, config });
const edge = (id: string, from: string, to: string, port = "out") => ({ id, from: { node: from, port }, to: { node: to, port: "in" as const } });
const graph = (nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[]): WorkflowGraph => parseGraph({ nodes, edges });
const codes = (g: WorkflowGraph) => checkGraph(g).map((i) => `${i.level}:${i.code}`);
const DB = "11111111-1111-4111-8111-111111111111";

test("the graph check: triggers, ports, edges, cycles, labels, placeholders before the node", () => {
  const t = node("n_trig01", "trigger.record.created", { database: DB }, "Trigger");
  const ifn = node("n_if0001", "logic.if", { condition: { kind: "group", join: "and", rules: [] } }, "If");
  const set = node("n_set001", "logic.set", { values: [{ name: "x", value: "{{n_trig01.record.title}}" }] }, "Set");
  assert.deepEqual(codes(graph([t, ifn, set], [edge("e_1", "n_trig01", "n_if0001"), edge("e_2", "n_if0001", "n_set001", "true")])), []);
  assert.ok(codes(emptyGraph()).includes("error:no_trigger"));
  // Unknown port, an edge into a trigger, duplicate labels, unknown types.
  assert.ok(codes(graph([t, ifn], [edge("e_1", "n_trig01", "n_if0001", "nope")])).includes("error:unknown_port"));
  assert.ok(codes(graph([t, { ...ifn, label: "trigger" }], [edge("e_1", "n_trig01", "n_if0001")])).includes("error:duplicate_label"));
  assert.ok(codes(graph([t, node("n_xx0001", "ai.dance")], [])).includes("error:unknown_type"));
  assert.ok(codes(graph([t, ifn], [edge("e_1", "n_if0001", "n_trig01", "true")])).includes("error:edge_into_trigger"));
  // A cycle.
  const a = node("n_aaaaaa", "logic.set", {}, "A"),
    b = node("n_bbbbbb", "logic.set", {}, "B");
  assert.ok(codes(graph([t, a, b], [edge("e_1", "n_trig01", "n_aaaaaa"), edge("e_2", "n_aaaaaa", "n_bbbbbb"), edge("e_3", "n_bbbbbb", "n_aaaaaa")])).includes("error:cycle"));
  // An orphan is a warning; a placeholder on a node after it an error.
  const late = node("n_late01", "logic.set", { values: [{ name: "y", value: "{{n_set001.x}}" }] }, "Late");
  const issues = codes(graph([t, set, late], [edge("e_1", "n_trig01", "n_late01"), edge("e_2", "n_late01", "n_set001")]));
  assert.ok(issues.includes("error:placeholder_not_before"));
  assert.ok(codes(graph([t, a], [])).includes("warning:orphan"));
  assert.ok(codes(graph([t, node("n_bad001", "logic.set", { values: [{ name: "z", value: "{{n_trig01.x" }] })], [edge("e_1", "n_trig01", "n_bad001")])).includes("error:placeholder_syntax"));
  // Branches cannot be switched off.
  assert.ok(codes(graph([t, { ...ifn, disabled: true }], [edge("e_1", "n_trig01", "n_if0001")])).includes("error:disabled_branch"));
  // onError "port" adds an error output.
  const withPort = { ...set, onError: { retry: 0, then: "port" as const } };
  assert.deepEqual(codes(graph([t, withPort, a], [edge("e_1", "n_trig01", "n_set001"), edge("e_2", "n_set001", "n_aaaaaa", "error")])), []);
  assert.match(issueMessage({ level: "error", code: "duplicate_label", params: { label: "X" } }, "en"), /The label “X” occurs twice/);
  // Ids and labels follow §5.1; a newer format is refused.
  assert.throws(() => parseGraph({ nodes: [node("x", "logic.set")], edges: [] }));
  assert.throws(() => parseGraph({ nodes: [{ ...a, label: "a.b" }], edges: [] }));
  assert.throws(() => parseGraph({ version: 2, nodes: [], edges: [] }), /neueren Flowplan-Version/);
});

const scope = (values: Record<string, unknown>, extra: Partial<RenderScope> = {}): RenderScope => ({ values, timeZone: "Europe/Berlin", locale: "de", ...extra });

test("placeholders: grammar, escaping, whole values keep their type, text otherwise", () => {
  const s = scope({ n_abc123: { record: { title: "Traefik", fields: { f1: "2026-03-05", "Fällig am": "2026-01-02" }, tags: ["a", "b"], n: 3 } }, $today: "2026-11-08" });
  assert.equal(renderText("Neu: {{n_abc123.record.title}}!", s), "Neu: Traefik!");
  assert.equal(renderValue("{{n_abc123.record.n}}", s), 3);
  assert.deepEqual(renderValue("{{ n_abc123.record.tags }}", s), ["a", "b"]);
  assert.equal(renderText("{{n_abc123.record.tags}}", s), "a, b");
  assert.equal(renderText('{{n_abc123.record.fields["Fällig am"] | date: "dd.MM.yyyy"}}', s), "02.01.2026");
  assert.equal(renderText("{{n_abc123.record.tags[1]}}", s), "b");
  // Literal braces and backslashes.
  assert.equal(renderText("\\{{nicht}} \\\\ x", s), "{{nicht}} \\ x");
  assert.deepEqual(parseTemplate("a\\{{b"), ["a{{b"]);
  assert.throws(() => parseTemplate("{{n_abc123.record"), /nicht geschlossen|erwartet/);
  assert.throws(() => parseTemplate("{{n_abc123 | wobble}}"), /Unbekannter Filter/);
  // Missing values are empty, with a warning.
  const warnings: string[] = [];
  assert.equal(renderText("[{{n_gone00.x}}]", { ...s, warn: (m) => warnings.push(m) }), "[]");
  assert.equal(warnings.length, 1);
  // A value never becomes markup: text stays text.
  assert.equal(renderText("{{n_abc123.record.title}}", scope({ n_abc123: { record: { title: "<b>x</b>" } } })), "<b>x</b>");
  assert.equal(headerSafe("a\r\nX-Evil: 1"), "aX-Evil: 1");
  // Text of values: people by name, pages by title, booleans in the language.
  assert.equal(valueText({ id: "u", name: "Anna" }), "Anna");
  assert.equal(valueText(true, "en"), "Yes");
  assert.equal(valueText(null), "");
  assert.equal(valueText({ a: 1 }), '{"a":1}');
  assert.equal(valueText("2026-03-05", "de"), "05.03.2026");
});

test("every filter of §7.2, German and English names", () => {
  const s = scope({ n_x00000: { text: "  Hallo schöne Welt, wie geht es dir heute?  ", list: ["eins", "zwei", "drei"], empty: "", n: 1234.567, html: "<p>A &amp; <b>B</b></p>", day: "2026-03-29", at: "2026-03-28T23:30:00Z" } });
  const r = (t: string) => renderTemplate(t, s, { whole: true });
  assert.equal(r('{{n_x00000.day | date: "d. MMMM yyyy"}}'), "29. März 2026");
  assert.equal(r('{{n_x00000.day | datum: "yyyy-MM-dd"}}'), "2026-03-29");
  // Date-times in the workflow's time zone (summer time starts that night in Berlin).
  assert.equal(r('{{n_x00000.at | date: "dd.MM. HH:mm"}}'), "29.03. 00:30");
  assert.equal(r("{{n_x00000.day | add_days: 3}}"), "2026-04-01");
  assert.equal(r("{{n_x00000.day | plus_tage: -29}}"), "2026-02-28");
  assert.equal(r("{{n_x00000.at | add_hours: 2}}"), "2026-03-29T01:30:00.000Z");
  assert.equal(r("{{n_x00000.text | trim | truncate: 20}}"), "Hallo schöne Welt…");
  assert.equal(r('{{n_x00000.text | trimmen | kürzen: 14, "..."}}'), "Hallo schöne...");
  assert.equal(r("{{n_x00000.list | upper}}"), "EINS, ZWEI, DREI");
  assert.equal(r("{{n_x00000.list | first | groß}}"), "EINS");
  assert.equal(r("{{n_x00000.list | last | klein}}"), "drei");
  assert.equal(r('{{n_x00000.list | join: " / "}}'), "eins / zwei / drei");
  assert.equal(r("{{n_x00000.list | anzahl}}"), 3);
  assert.equal(r("{{n_x00000.list | count}}"), 3);
  assert.equal(r('{{n_x00000.text | trim | replace: "Welt", "Erde"}}'), "Hallo schöne Erde, wie geht es dir heute?");
  assert.equal(r('{{n_x00000.empty | default: "–"}}'), "–");
  assert.equal(r('{{n_x00000.empty | standard: n_x00000.list}}').toString(), "eins,zwei,drei");
  assert.equal(r("{{n_x00000.n | number: 2}}"), "1.234,57");
  assert.equal(renderTemplate("{{n_x00000.n | zahl: 0}}", { ...s, locale: "en" }, { whole: true }), "1,235");
  assert.equal(r("{{n_x00000.html | plain}}"), "A & B");
  assert.equal(r("{{n_x00000.list | json}}"), '["eins","zwei","drei"]');
  assert.throws(() => r("{{n_x00000.empty | required}}"), PlaceholderError);
  assert.throws(() => r("{{n_x00000.empty | pflicht}}"), /Pflicht/);
});

test("display form: labels, built-ins in three languages, property names, back again", () => {
  const labels = new Map([["n_k3f9a2", "Neue Seite"], ["n_8bq1zz", "Kurzbeschreibung"]]);
  const ctx = {
    locale: "de" as const,
    labels,
    keyName: (_root: string, keys: (string | number)[], key: string) => (keys.at(-1) === "fields" && key === "f_x81" ? "Fällig am" : key === "title" ? "Titel" : key),
    keyId: (_root: string, keys: (string | number)[], name: string) => (keys.at(-1) === "fields" && name.toLowerCase() === "fällig am" ? "f_x81" : name === "Titel" ? "title" : name),
  };
  const stored = '{{n_k3f9a2.record.title}} – {{n_k3f9a2.record.fields.f_x81 | date: "dd.MM.yyyy"}} {{$today}} {{n_8bq1zz.summary | truncate: 140 | default: "–"}}';
  const shown = toDisplay(stored, ctx);
  assert.equal(shown, '{{Neue Seite.record.Titel}} – {{Neue Seite.record.fields["Fällig am"] | datum: "dd.MM.yyyy"}} {{$Heute}} {{Kurzbeschreibung.summary | kürzen: 140 | standard: "–"}}');
  assert.equal(fromDisplay(shown, ctx), stored);
  // Typed in English or French, any case.
  assert.equal(fromDisplay("{{$Today}} {{$aujourd’hui}} {{neue seite.record.Titel | upper}}", ctx), "{{$today}} {{$today}} {{n_k3f9a2.record.title | upper}}");
  assert.equal(toDisplay("{{$trigger.record.title | truncate: 5}}", { ...ctx, locale: "en" }), "{{$Trigger.record.Titel | truncate: 5}}");
  assert.throws(() => fromDisplay("{{Nobody.x}}", ctx), /Unbekannter Name/);
});

test("values into properties: types, options, numbers with comma, refusals", () => {
  const f = (type: Field["type"], extra: Partial<Field> = {}): Field => ({ id: "f", name: "Feld", type, ...extra });
  assert.equal(coerceToField("2026-01-02", f("date")), "2026-01-02");
  assert.equal(coerceToField("2026-01-02T10:15:00.000Z", f("date")), "2026-01-02T10:15Z");
  assert.throws(() => coerceToField("morgen", f("date")), (e: Error) => e instanceof ValueError && /„morgen“ passt nicht in die Eigenschaft „Feld“/.test(e.message));
  assert.equal(coerceToField("1.234,5", f("number")), 1234.5);
  assert.equal(coerceToField("3,5", f("number")), 3.5);
  assert.equal(coerceToField("1,234.5", f("number")), 1234.5);
  assert.equal(toNumber("x"), null);
  assert.equal(coerceToField("done", f("select", { options: ["Open", "Done"] })), "Done");
  assert.throws(() => coerceToField("Later", f("select", { options: ["Open"] })), ValueError);
  assert.deepEqual(coerceToField("a, B", f("multiselect", { options: ["A", "b"] })), ["A", "b"]);
  assert.deepEqual(coerceToField(["neu"], f("multiselect", { options: [], tagOptions: true })), ["neu"]);
  assert.equal(coerceToField("ja", f("checkbox")), true);
  assert.equal(coerceToField({ id: "u1", name: "Anna" }, f("person")), "u1");
  assert.deepEqual(coerceToField([{ id: "r1" }, "r2"], f("relation")), ["r1", "r2"]);
  assert.equal(coerceToField({ title: "Seite" }, f("text")), "Seite");
  assert.throws(() => coerceToField("x", f("formula")), /berechnet/);
});

// Every rule of tests/automations.test.ts, as a graph and back.
const RULES = [
  { id: "a1", name: "Closed date", trigger: { type: "changed", field: "status", to: "Done" }, actions: [{ type: "set", field: "closed", value: "@today" }] },
  { id: "a2", name: "Assign", trigger: { type: "created" }, conditions: [{ field: "status", op: "empty", value: "" }], actions: [{ type: "set", field: "owner", value: "@actor" }, { type: "set", field: "status", value: "Open" }] },
  { id: "late", name: "Late", trigger: { type: "overdue", field: "due" }, actions: [{ type: "notify", to: "field:owner", message: "Overdue" }] },
  { id: "weekly", name: "Weekly", trigger: { type: "schedule", freq: "daily", interval: 1, time: "00:00", timeZone: "UTC" }, actions: [{ type: "create", template: "t1", cells: { owner: "u1" }, dates: { due: 3 } }] },
  { id: "form", name: "Form", trigger: { type: "form" }, actions: [{ type: "template", template: "t2", mode: "append" }] },
];
test("database rules become graphs and back, unchanged", () => {
  for (const raw of RULES) {
    const rule = automationSchema.parse(raw);
    const g = automationToGraph(rule, DB);
    assert.deepEqual(checkGraph(g).filter((i) => i.level === "error"), [], rule.id);
    const back = graphToAutomation(g, { id: rule.id, name: rule.name, enabled: rule.enabled });
    const { createdBy: _c, since: _s, ...expected } = rule;
    assert.deepEqual(back, expected, rule.id);
  }
  // Beyond the form: null.
  const rule = automationSchema.parse(RULES[0]);
  const g = automationToGraph(rule, DB);
  g.nodes.push({ id: "n_extra0", type: "logic.stop", typeVersion: 1, label: "Stop", note: "", position: { x: 0, y: 0 }, disabled: false, config: {} });
  g.edges.push({ id: "e_9", from: { node: g.nodes[1].id, port: "out" }, to: { node: "n_extra0", port: "in" } });
  assert.equal(graphToAutomation(g, { id: "a1", name: "", enabled: true }), null);
});

test("the draft as Yjs: graph in and out, concurrent edits merge, texts are Y.Text", () => {
  const g = automationToGraph(automationSchema.parse(RULES[2]), DB);
  const doc = graphDoc(g);
  assert.deepEqual(draftGraph(doc).nodes.map((n) => n.id).sort(), g.nodes.map((n) => n.id).sort());
  const notify = g.nodes.find((n) => n.type === "notify.person")!;
  const nodes = doc.getMap<Y.Map<unknown>>("nodes");
  assert.ok((nodes.get(notify.id)!.get("config") as Y.Map<unknown>).get("message") instanceof Y.Text);
  // Two people: one renames, the other changes the message – both stay.
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  const mine = structuredClone(draftGraph(doc));
  mine.nodes.find((n) => n.id === notify.id)!.label = "Renamed";
  writeGraph(doc, mine);
  const theirs = structuredClone(draftGraph(other));
  theirs.nodes.find((n) => n.id === notify.id)!.config.message = "Overdue!";
  writeGraph(other, theirs);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
  const merged = draftGraph(doc).nodes.find((n) => n.id === notify.id)!;
  assert.equal(merged.label, "Renamed");
  assert.equal(merged.config.message, "Overdue!");
});

test("the catalogue: every type with names, schema, ports; JSON Schema for the editor", () => {
  const types = new Set(NODE_TYPES.map((n) => n.type));
  for (const t of ["trigger.record.created", "trigger.record.changed", "trigger.record.done", "trigger.record.date", "trigger.form.submitted", "trigger.schedule", "trigger.page.created", "trigger.page.changed", "trigger.page.moved", "trigger.page.tagged", "trigger.comment.created", "trigger.mention", "trigger.manual", "action.record.create", "action.record.update", "action.record.find", "action.record.template", "action.page.create", "action.page.append", "action.page.tag", "action.page.move", "notify.person", "logic.if", "logic.set", "logic.stop"])
    assert.ok(types.has(t), t);
  const json = catalogJson();
  assert.equal(json.length, NODE_TYPES.length);
  for (const n of json) {
    assert.ok(n.name[0] && n.name[1], n.type);
    assert.equal(typeof n.config, "object");
  }
  assert.ok(JSON.stringify(json).length < 400_000);
});
