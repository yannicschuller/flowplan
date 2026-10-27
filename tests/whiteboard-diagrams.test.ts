// Diagramming on whiteboards: shape libraries, connector ends, auto layout,
// Mermaid and PlantUML import, prototype links, timelines and their export.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WhiteboardItem } from "../lib/whiteboard-model";
import { itemText } from "../lib/whiteboard-model";
import { connectorEnds, markerProps, markerSvg } from "../lib/whiteboard-connector-markers";
import { markerKinds, cleanDiagramFields, linkTarget, parseTimeline, publicTimeline, remapLink } from "../lib/whiteboard-diagram-model";
import { drawLibraryShape, libraryDraft, libraryShapeSvg, libraryShapes, librarySetOrder, searchLibrary, compartments } from "../lib/whiteboard-shapes-library";
import { autoLayoutItems, layeredLayout } from "../lib/whiteboard-autolayout";
import { boardToMermaid, detectDiagramSource, importDiagram, parseDiagramText, DiagramImportError, DIAGRAM_LIMITS } from "../lib/whiteboard-diagram-import";
import { followLink, frameContents, hotspots, prototypeFrames, startFrame } from "../lib/whiteboard-prototype";
import { boundPatch, boundTimeline, changeBar, daysFor, defaultTimeline, isoWeek, laneAt, timelineColumns, timelineLayout, timelineSvg } from "../lib/whiteboard-timeline";
import { placeDrafts } from "../lib/whiteboard-import";
import { whiteboardSvg, type WhiteboardSvgContext } from "../lib/whiteboard-svg";
import { dateDay } from "../lib/database-timeline";
import type { Field, Row } from "../lib/types";

const de = (a: string) => a;
const item = (props: Partial<WhiteboardItem> & { id: string; type: WhiteboardItem["type"] }): WhiteboardItem =>
  ({ x: 0, y: 0, w: 100, h: 60, z: 0, ...props }) as WhiteboardItem;
const ctx: WhiteboardSvgContext = { image: () => null, page: () => null, record: () => null, label: de };
const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---- connector ends ----

test("connector ends: old boards keep their arrows, markers replace them", () => {
  assert.deepEqual(connectorEnds({}), { start: "none", end: "arrow" });
  assert.deepEqual(connectorEnds({ startArrow: true, endArrow: false }), { start: "arrow", end: "none" });
  assert.deepEqual(connectorEnds({ endMarker: "zeroOrMany", startMarker: "onlyOne", startArrow: true }), { start: "onlyOne", end: "zeroOrMany" });
  // An unknown marker from a client falls back to the arrow.
  assert.deepEqual(connectorEnds({ endMarker: "<script>" as never }), { start: "none", end: "arrow" });
  assert.deepEqual(markerProps("end", "none"), { endArrow: false, endMarker: undefined });
  assert.deepEqual(markerProps("start", "triangle"), { startArrow: true, startMarker: "triangle" });
  assert.deepEqual(markerProps("end", "arrow"), { endArrow: true, endMarker: undefined });
});

test("connector ends: every marker draws finite SVG, crow's feet have three prongs", () => {
  for (const kind of markerKinds) {
    const svg = markerSvg(kind, { x: 100, y: 50 }, { x: 1, y: 0 }, 2, "#123456");
    if (kind === "none") assert.equal(svg, "");
    else {
      assert.match(svg, /^<(path|circle)/, kind);
      assert.doesNotMatch(svg, /NaN|Infinity|undefined/, kind);
    }
  }
  // A zero-length direction does not produce NaN.
  assert.doesNotMatch(markerSvg("many", { x: 0, y: 0 }, { x: 0, y: 0 }, 2, "#000"), /NaN/);
  const many = markerSvg("many", { x: 100, y: 50 }, { x: 1, y: 0 }, 2, "#000");
  assert.equal((many.match(/M /g) || []).length, 2, "two strokes: the outer prongs and the middle one");
  // Hollow ends are filled with the background, closed ends with the line colour.
  assert.match(markerSvg("triangle", { x: 0, y: 0 }, { x: 1, y: 0 }, 2, "#000", "#fff"), /fill="#fff"/);
  assert.match(markerSvg("filledDiamond", { x: 0, y: 0 }, { x: 1, y: 0 }, 2, "#000", "#fff"), /fill="#000"/);
  // Colours are attribute-escaped.
  assert.doesNotMatch(markerSvg("arrow", { x: 0, y: 0 }, { x: 1, y: 0 }, 2, '"><x'), /"><x/);
});

// ---- shape libraries ----

test("shape libraries: every set has shapes, every shape draws and has a name", () => {
  for (const set of librarySetOrder) assert.ok(libraryShapes.some((s) => s.set === set), set);
  assert.ok(libraryShapes.length >= 80, `only ${libraryShapes.length} shapes`);
  for (const s of libraryShapes) {
    const drawing = drawLibraryShape({ lib: s.id, w: s.w, h: s.h, text: "A\n--\nb\n--\nc()" });
    assert.ok(drawing, s.id);
    assert.doesNotMatch(drawing.markup, /NaN|undefined|Infinity/, s.id);
    assert.ok(s.name[0] && s.name[1], s.id);
    const draft = libraryDraft(s.id, de)!;
    assert.equal(draft.lib, s.id);
    // Previews draw without fill or text.
    assert.equal(drawLibraryShape({ lib: s.id, w: s.w, h: s.h, text: "x" }, true)!.texts.length, 0);
  }
  // Generic icons only: no vendor names in ids or keywords.
  for (const s of libraryShapes) assert.doesNotMatch(`${s.id} ${s.keywords}`, /\b(aws|amazon|azure|gcp|google)\b/i, s.id);
  assert.equal(drawLibraryShape({ lib: "flow:nope", w: 10, h: 10 }), null);
});

test("shape libraries: search by German and English names and keywords", () => {
  const ids = (q: string) => searchLibrary(q, de).map((s) => s.id);
  assert.ok(ids("Entscheidung").includes("flow:decision"));
  assert.ok(ids("decision").includes("flow:decision"));
  assert.ok(ids("gateway").some((id) => id.startsWith("bpmn:")));
  assert.ok(ids("klasse").includes("uml:class"));
  assert.ok(ids("entität").includes("erd:entity") || ids("entity").includes("erd:entity"));
  assert.ok(searchLibrary("", de, "wf").every((s) => s.set === "wf"));
  assert.deepEqual(ids("zzzzqqq"), []);
});

test("shape libraries: class compartments and ERD rows, text is escaped in the SVG", () => {
  assert.deepEqual(compartments("Tier\n--\n+name\n--\n+fressen()"), ["Tier", "+name", "+fressen()"]);
  const svg = libraryShapeSvg({ lib: "uml:class", w: 200, h: 160, text: "Tier<script>\n--\n+name: String\n--\n+fressen()" })!;
  assert.ok(svg.includes("Tier&lt;script&gt;"));
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes("+name: String") && svg.includes("+fressen()"));
  const entity = libraryShapeSvg({ lib: "erd:entity", w: 200, h: 140, text: "Kunde\nid PK\nname" })!;
  assert.ok(entity.includes("Kunde") && entity.includes("name"));
  // A colour that is not a colour does not reach an attribute.
  const evil = libraryShapeSvg({ lib: "flow:process", w: 100, h: 60, fill: 'red" onload="x' })!;
  assert.ok(!evil.includes("onload"));
});

// ---- auto layout ----

test("auto layout: layers top to bottom and left to right without overlaps", () => {
  const nodes = ["a", "b", "c", "d", "e"].map((id) => ({ id, w: 120, h: 60 }));
  const edges = [
    { from: "a", to: "b" },
    { from: "a", to: "c" },
    { from: "b", to: "d" },
    { from: "c", to: "d" },
    { from: "d", to: "e" },
    { from: "e", to: "a" }, // a cycle
  ];
  const tb = layeredLayout(nodes, edges, { direction: "TB" });
  assert.equal(tb.size, 5);
  assert.ok(tb.get("a")!.y < tb.get("b")!.y && tb.get("b")!.y < tb.get("d")!.y && tb.get("d")!.y < tb.get("e")!.y);
  assert.equal(tb.get("b")!.y, tb.get("c")!.y);
  const boxes = [...tb].map(([id, p]) => ({ id, ...p, w: 120, h: 60 }));
  for (const a of boxes) for (const b of boxes) if (a.id < b.id) assert.ok(!overlap(a, b), `${a.id}/${b.id}`);
  const lr = layeredLayout(nodes, edges, { direction: "LR" });
  assert.ok(lr.get("a")!.x < lr.get("b")!.x && lr.get("d")!.x < lr.get("e")!.x);
  assert.equal(layeredLayout([], []).size, 0);
  // Unknown edge ends and self loops are ignored.
  assert.equal(layeredLayout([{ id: "x", w: 10, h: 10 }], [{ from: "x", to: "x" }, { from: "x", to: "y" }]).size, 1);
});

test("auto layout: the board selection keeps its corner, connectors stay attached", () => {
  const items = [
    item({ id: "s1", type: "shape", x: 500, y: 300 }),
    item({ id: "s2", type: "shape", x: 900, y: 900 }),
    item({ id: "s3", type: "shape", x: 520, y: 700 }),
    item({ id: "c1", type: "connector", from: { id: "s1", x: 0, y: 0 }, to: { id: "s2", x: 0, y: 0 } }),
    item({ id: "c2", type: "connector", from: { id: "s2", x: 0, y: 0 }, to: { id: "s3", x: 0, y: 0 } }),
    item({ id: "lonely", type: "sticky", x: 0, y: 0 }),
  ];
  const result = autoLayoutItems(items, new Set(["s1", "s2", "s3", "c1", "c2"]), "TB")!;
  assert.deepEqual(result.map((p) => p.id).sort(), ["s1", "s2", "s3"]);
  const at = new Map(result.map((p) => [p.id, p]));
  assert.equal(Math.min(...result.map((p) => p.x)), 500);
  assert.equal(Math.min(...result.map((p) => p.y)), 300);
  assert.ok(at.get("s1")!.y < at.get("s2")!.y && at.get("s2")!.y < at.get("s3")!.y);
  // Connectors are not moved: they follow their ends.
  assert.ok(!at.has("c1"));
  assert.equal(autoLayoutItems(items, new Set(["lonely", "s1"]), "TB"), null);
  // Locked items stay where they are.
  const locked = items.map((i) => (i.id === "s2" ? { ...i, locked: true } : i));
  assert.equal(autoLayoutItems(locked, new Set(["s1", "s2"]), "TB"), null);
});

// ---- Mermaid ----

test("Mermaid: detection, fences and front matter", () => {
  assert.equal(detectDiagramSource("flowchart TD\nA-->B"), "mermaid");
  assert.equal(detectDiagramSource("```mermaid\ngraph LR\nA-->B\n```"), "mermaid");
  assert.equal(detectDiagramSource("---\ntitle: x\n---\nsequenceDiagram\nA->>B: hi"), "mermaid");
  assert.equal(detectDiagramSource("%% comment\nerDiagram\nA ||--o{ B : x"), "mermaid");
  assert.equal(detectDiagramSource("@startuml\nA -> B\n@enduml"), "plantuml");
  assert.equal(detectDiagramSource("Einkaufsliste: Milch"), null);
  assert.equal(importDiagram("```mermaid\ngraph LR\nA-->B\n```").drafts.length, 3);
});

test("Mermaid flowchart: shapes, labels, subgraphs and skipped lines", () => {
  const r = importDiagram("flowchart LR\n  A([Start]) --> B{Ok?}\n  B -->|Ja| C[Fertig]\n  B -.-> D[(DB)]\n  click A callback\n  subgraph S [Gruppe]\n    C\n  end");
  assert.equal(r.kind, "flowchart");
  const libs = Object.fromEntries(r.drafts.filter((d) => d.type === "shape").map((d) => [d.text, d.lib]));
  assert.deepEqual(libs, { Start: "flow:terminator", "Ok?": "flow:decision", Fertig: "flow:process", DB: "flow:database" });
  const connectors = r.drafts.filter((d) => d.type === "connector");
  assert.equal(connectors.length, 3);
  assert.ok(connectors.every((c) => c.from?.id && c.to?.id), "connectors are attached");
  assert.ok(connectors.some((c) => c.text === "Ja"));
  assert.ok(connectors.some((c) => c.dashed));
  assert.ok(r.drafts.some((d) => d.type === "frame" && d.text === "Gruppe"));
  assert.deepEqual(r.skipped, [{ line: 5, text: "click A callback" }]);
  // Left to right: B lies right of A.
  const byText = new Map(r.drafts.map((d) => [d.text, d]));
  assert.ok(byText.get("Ok?")!.x > byText.get("Start")!.x);
});

test("Mermaid: sequence, class, ER, state and mind map", () => {
  const seq = importDiagram("sequenceDiagram\n  actor K as Kunde\n  participant S\n  K->>S: Hallo\n  S-->>K: Antwort\n  loop jede Minute\n  K->>S: ping\n  end\n  Note over K,S: Notiz");
  assert.equal(seq.kind, "sequence");
  const lifelines = seq.drafts.filter((d) => d.lib?.startsWith("uml:lifeline"));
  assert.deepEqual(lifelines.sort((a, b) => a.x - b.x).map((d) => [d.text, d.lib]), [["Kunde", "uml:lifeline-actor"], ["S", "uml:lifeline"]]);
  const answer = seq.drafts.find((d) => d.text === "Antwort")!;
  assert.ok(answer.dashed && answer.from!.x > answer.to!.x);
  assert.ok(seq.drafts.some((d) => d.lib === "uml:fragment" && /loop/.test(d.text || "")));
  assert.ok(seq.drafts.some((d) => d.lib === "uml:note" && d.text === "Notiz"));

  const cls = importDiagram("classDiagram\n  class Tier {\n    +String name\n    +fressen() void\n  }\n  Tier <|-- Hund\n  Hund *-- Bein : hat");
  const tier = cls.drafts.find((d) => d.lib === "uml:class" && d.text?.startsWith("Tier"))!;
  assert.match(tier.text!, /\+String name/);
  assert.match(tier.text!, /\+fressen\(\) void/);
  const markers = cls.drafts.filter((d) => d.type === "connector").map((d) => d.startMarker);
  assert.deepEqual(markers.sort(), ["filledDiamond", "triangle"]);

  const er = importDiagram("erDiagram\n  KUNDE ||--o{ BESTELLUNG : gibt\n  KUNDE {\n    string name PK\n  }");
  const rel = er.drafts.find((d) => d.type === "connector")!;
  assert.deepEqual([rel.startMarker, rel.endMarker, rel.text], ["onlyOne", "zeroOrMany", "gibt"]);
  assert.ok(er.drafts.some((d) => d.lib === "erd:entity" && /name/.test(d.text || "")));

  const state = importDiagram("stateDiagram-v2\n  [*] --> Aus\n  Aus --> An : drücken\n  An --> [*]");
  assert.ok(state.drafts.some((d) => d.lib === "uml:start") && state.drafts.some((d) => d.lib === "uml:end"));
  assert.ok(state.drafts.some((d) => d.text === "drücken"));

  const mind = importDiagram("mindmap\n  root((Projekt))\n    Ziele\n      Umsatz\n    Team");
  assert.equal(mind.drafts.filter((d) => d.type === "shape").length, 4);
  assert.equal(mind.drafts.filter((d) => d.type === "connector").length, 3);
});

test("Mermaid and PlantUML: broken and oversized input", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
      return "ok";
    } catch (e) {
      assert.ok(e instanceof DiagramImportError, String(e));
      return e.code;
    }
  };
  assert.equal(code(() => importDiagram("")), "empty");
  assert.equal(code(() => importDiagram("hello world")), "unknown");
  assert.equal(code(() => importDiagram("gantt\n title x")), "unsupported");
  assert.equal(code(() => importDiagram("pie\n \"a\": 1")), "unsupported");
  assert.equal(code(() => importDiagram("x".repeat(DIAGRAM_LIMITS.chars + 1), "mermaid")), "too-large");
  const many = "flowchart TD\n" + Array.from({ length: DIAGRAM_LIMITS.nodes + 5 }, (_, i) => `n${i} --> n${i + 1}`).join("\n");
  assert.equal(code(() => importDiagram(many)), "too-many");
  assert.equal(code(() => importDiagram("@startuml\n@enduml")), "empty");
  // Broken lines are reported, the rest is kept.
  const broken = importDiagram("flowchart TD\n  A[Start] --> B\n  C[unclosed --> D\n  %%{init: {}}%%");
  assert.ok(broken.drafts.length >= 3);
  assert.ok(broken.skipped.some((s) => s.line === 3));
  // Never throws anything but DiagramImportError on garbage.
  for (const garbage of ["flowchart TD\n" + "[[[(((".repeat(500), "classDiagram\n class {", "erDiagram\n ||--o{", "sequenceDiagram\n ->>:", "@startuml\nif (\n@enduml", "mindmap\n\t\t\t", "stateDiagram\n [*] --> [*] --> [*]"])
    code(() => importDiagram(garbage));
  assert.equal(parseDiagramText("graph TD\nA-->B").source, "mermaid");
});

// ---- PlantUML ----

test("PlantUML activity: start, actions, if/else with branch labels, while, stop", () => {
  const r = importDiagram("@startuml\nstart\n:A;\nif (x?) then (ja)\n:B;\nelse (nein)\n:C;\nendif\nwhile (mehr?)\n:D;\nendwhile\nstop\n@enduml");
  assert.equal(r.kind, "activity");
  const decision = r.drafts.filter((d) => d.lib === "flow:decision").map((d) => d.text);
  assert.deepEqual(decision, ["x?", "mehr?"]);
  const labels = r.drafts.filter((d) => d.type === "connector" && d.text).map((d) => d.text).sort();
  assert.deepEqual(labels, ["ja", "nein"]);
  assert.ok(r.drafts.some((d) => d.lib === "uml:start") && r.drafts.some((d) => d.lib === "uml:end"));
  // Conditions with brackets inside.
  const nested = importDiagram("@startuml\nif (f(x) > 1) then (yes)\n:a;\nendif\n@enduml");
  assert.ok(nested.drafts.some((d) => d.text === "f(x) > 1"));
});

test("PlantUML: sequence, class, use case, component and skipped lines", () => {
  const seq = importDiagram("@startuml\nactor User\nUser -> Server : login\nServer --> User : ok\n@enduml");
  assert.equal(seq.kind, "sequence");
  assert.ok(seq.drafts.find((d) => d.text === "ok")!.dashed);
  const cls = importDiagram('@startuml\nclass A {\n +x : int\n}\nclass B\nA <|-- B\nA "1" *-- "many" C\n@enduml');
  assert.equal(cls.kind, "class");
  assert.ok(cls.drafts.some((d) => d.lib === "uml:class" && /\+x : int/.test(d.text || "")));
  assert.deepEqual(cls.drafts.filter((d) => d.type === "connector").map((d) => d.startMarker).sort(), ["filledDiamond", "triangle"]);
  const uc = importDiagram("@startuml\nactor Kunde\n(Bestellen) as UC1\nKunde --> UC1\n@enduml");
  assert.equal(uc.kind, "usecase");
  assert.ok(uc.drafts.some((d) => d.lib === "uml:actor") && uc.drafts.some((d) => d.lib === "uml:usecase" && d.text === "Bestellen"));
  const comp = importDiagram("@startuml\n[Web] --> [API]\ndatabase DB\n[API] --> DB\n@enduml");
  assert.equal(comp.kind, "component");
  assert.equal(comp.drafts.filter((d) => d.lib === "uml:component").length, 2);
  const weird = importDiagram("@startuml\n:A;\nfoo bar baz ???\n@enduml");
  assert.deepEqual(weird.skipped, [{ line: 3, text: "foo bar baz ???" }]);
  // Styling is ignored without a message.
  assert.deepEqual(importDiagram("@startuml\nskinparam monochrome true\n!theme plain\n:A;\n@enduml").skipped, []);
});

test("Copy as Mermaid: a drawn flowchart round-trips", () => {
  const items = [
    item({ id: "a", type: "shape", lib: "flow:terminator", text: "Start", x: 0, y: 0 }),
    item({ id: "b", type: "shape", lib: "flow:decision", text: 'Sagt "ja"?', x: 0, y: 200 }),
    item({ id: "c", type: "sticky", text: "Zeile 1\nZeile 2", x: 0, y: 400 }),
    item({ id: "x", type: "connector", from: { id: "a", x: 0, y: 0 }, to: { id: "b", x: 0, y: 0 } }),
    item({ id: "y", type: "connector", text: "ja", dashed: true, from: { id: "b", x: 0, y: 0 }, to: { id: "c", x: 0, y: 0 } }),
  ];
  const text = boardToMermaid(items)!;
  assert.match(text, /^flowchart TD\n/);
  assert.match(text, /n1\(\["Start"\]\)/);
  assert.match(text, /n2\{"Sagt #quot;ja#quot;\?"\}/);
  assert.match(text, /Zeile 1<br>Zeile 2/);
  const back = importDiagram(text);
  assert.equal(back.drafts.filter((d) => d.type !== "connector").length, 3);
  assert.equal(back.drafts.filter((d) => d.type === "connector").length, 2);
  assert.ok(back.drafts.some((d) => d.text === 'Sagt "ja"?' && d.lib === "flow:decision"));
  assert.ok(back.drafts.some((d) => d.text === "Zeile 1\nZeile 2"));
  assert.equal(boardToMermaid([]), null);
  // Only the selection.
  assert.doesNotMatch(boardToMermaid(items, new Set(["a"]))!, /-->/);
});

// ---- prototypes ----

test("prototype links: validation, hotspots and following them", () => {
  assert.deepEqual(linkTarget("frame:f1"), { frame: "f1" });
  assert.deepEqual(linkTarget("back"), { back: true });
  assert.equal(linkTarget("javascript:alert(1)"), null);
  assert.equal(linkTarget("frame:"), null);
  const items = [
    item({ id: "f2", type: "frame", x: 0, y: 1000, w: 400, h: 800 }),
    item({ id: "f1", type: "frame", x: 0, y: 0, w: 400, h: 800 }),
    item({ id: "btn", type: "shape", lib: "wf:button", x: 20, y: 20, proto: "frame:f2" }),
    item({ id: "back", type: "text", x: 20, y: 1020, proto: "back" }),
    item({ id: "dead", type: "text", x: 20, y: 100, proto: "frame:gone" }),
    item({ id: "outside", type: "text", x: 600, y: 20, proto: "frame:f2" }),
  ];
  assert.deepEqual(prototypeFrames(items).map((f) => f.id), ["f1", "f2"]);
  assert.deepEqual(frameContents(items[1], items).map((i) => i.id).sort(), ["btn", "dead"]);
  const spots = hotspots(items[1], items);
  assert.deepEqual(spots.map((s) => [s.id, s.valid]).sort(), [["btn", true], ["dead", false]]);
  assert.equal(startFrame(items, new Set()), "f1");
  assert.equal(startFrame(items, new Set(["back"])), "f2");
  const frames = new Set(["f1", "f2"]);
  let history = ["f1"];
  history = followLink(history, { frame: "f2" }, frames);
  assert.deepEqual(history, ["f1", "f2"]);
  assert.deepEqual(followLink(history, { frame: "f2" }, frames), history, "same frame: nothing happens");
  assert.deepEqual(followLink(history, { frame: "gone" }, frames), history);
  history = followLink(history, { back: true }, frames);
  assert.deepEqual(history, ["f1"]);
  assert.deepEqual(followLink(history, { back: true }, frames), ["f1"], "back on the first frame stays");
});

test("prototype links: copies, duplicates and imports remap their targets", () => {
  const ids = new Map([["f1", "F1"], ["btn", "BTN"]]);
  assert.equal(remapLink({ proto: "frame:f1" }, ids).proto, "frame:F1");
  assert.equal(remapLink({ proto: "frame:other" }, ids).proto, "frame:other");
  assert.equal(remapLink({ proto: "back" }, ids).proto, "back");
  assert.equal(remapLink({ text: "x" } as Partial<WhiteboardItem>, ids).proto, undefined);
  let n = 0;
  const placed = placeDrafts(
    [
      { id: "f1", type: "frame", x: 0, y: 0, w: 300, h: 600 },
      { id: "f2", type: "frame", x: 400, y: 0, w: 300, h: 600 },
      { id: "b", type: "shape", x: 10, y: 10, w: 80, h: 30, proto: "frame:f2" },
      { id: "c", type: "shape", x: 410, y: 10, w: 80, h: 30, proto: "back" },
    ],
    { newId: () => `new${++n}`, dx: 100 },
  );
  const f2 = placed.find((p) => p.x === 500)!;
  assert.equal(placed.find((p) => p.type === "shape" && p.x === 110)!.proto, `frame:${f2.id}`);
  assert.equal(placed.find((p) => p.type === "shape" && p.x === 510)!.proto, "back");
});

// ---- timelines ----

test("timeline: validation drops what is broken, old boards still load", () => {
  assert.equal(parseTimeline(null), null);
  assert.equal(parseTimeline({ start: "2026-02-30", end: "2026-03-01" }), null);
  const t = parseTimeline({
    scale: "decade",
    start: "2026-06-30",
    end: "2026-01-01",
    lanes: [{ id: "l1", name: "A" }, { id: 5 }],
    bars: [
      { id: "b1", lane: "l1", title: "ok", start: "2026-03-10", end: "2026-03-01" },
      { id: "b2", lane: "l1", title: "bad", start: "soon", end: "2026-03-01" },
      { id: "b3", lane: "l1", title: "colour", start: "2026-03-01", end: "2026-03-02", color: "url(#x)" },
    ],
  })!;
  assert.equal(t.scale, "month");
  assert.deepEqual([t.start, t.end], ["2026-01-01", "2026-06-30"]);
  assert.deepEqual(t.lanes, [{ id: "l1", name: "A" }]);
  assert.deepEqual(t.bars.map((b) => [b.id, b.start, b.end]), [["b1", "2026-03-01", "2026-03-10"]]);
  // At most about three years.
  const long = parseTimeline({ scale: "quarter", start: "2020-01-01", end: "2040-01-01", lanes: [], bars: [] })!;
  assert.ok(dateDay(long.end)! - dateDay(long.start)! <= 3 * 366);
  // Cleaning a whole item.
  const cleaned = cleanDiagramFields({ type: "shape", lib: "../evil", proto: "http://x", endMarker: "bomb" as never, startMarker: "diamond" } as Partial<WhiteboardItem>);
  assert.deepEqual([cleaned.lib, cleaned.proto, cleaned.endMarker, cleaned.startMarker], [undefined, undefined, undefined, "diamond"]);
});

test("timeline: ISO weeks, columns of each scale and the layout", () => {
  const week = (key: string) => isoWeek(dateDay(key)!);
  assert.deepEqual(week("2026-01-01"), { week: 1, year: 2026 });
  assert.deepEqual(week("2027-01-01"), { week: 53, year: 2026 });
  assert.deepEqual(week("2024-12-30"), { week: 1, year: 2025 });
  const months = timelineColumns({ scale: "month", start: "2026-01-15", end: "2026-04-10" });
  assert.equal(months.length, 4);
  assert.equal(months[0].end - months[0].start, 17, "the first month starts mid-month");
  assert.equal(timelineColumns({ scale: "quarter", start: "2026-01-01", end: "2026-12-31" }).map((c) => c.label).join(","), "Q1 2026,Q2 2026,Q3 2026,Q4 2026");
  const weeks = timelineColumns({ scale: "week", start: "2026-01-05", end: "2026-02-01" }, "de-DE", "KW");
  assert.deepEqual(weeks.map((c) => c.label), ["KW 2", "KW 3", "KW 4", "KW 5"]);

  const data = parseTimeline({
    scale: "month",
    start: "2026-01-01",
    end: "2026-03-31",
    lanes: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    bars: [
      { id: "1", lane: "a", title: "eins", start: "2026-01-01", end: "2026-01-31" },
      { id: "2", lane: "a", title: "zwei", start: "2026-01-20", end: "2026-02-10" },
      { id: "3", lane: "b", title: "drei", start: "2025-12-01", end: "2026-01-10" },
      { id: "4", lane: "zz", title: "verirrt", start: "2026-02-01", end: "2026-02-02" },
      { id: "5", lane: "b", title: "später", start: "2027-01-01", end: "2027-01-02" },
    ],
  })!;
  const box = { w: 130 + 90 * 6, h: 46 + 300 };
  const layout = timelineLayout(box, data, { today: "2026-01-16" });
  assert.equal(layout.days, 90);
  assert.equal(layout.dayW, 6);
  const bar = new Map(layout.bars.map((b) => [b.id, b]));
  assert.equal(bar.get("1")!.x, 130);
  assert.equal(bar.get("1")!.w, 31 * 6);
  assert.ok(bar.get("2")!.y > bar.get("1")!.y, "overlapping bars go below each other");
  assert.ok(bar.get("3")!.clippedStart && bar.get("3")!.x === 130);
  assert.equal(bar.get("4")!.lane, "zz");
  assert.ok(bar.get("4")!.y < layout.lanes[1].y, "a bar of an unknown lane goes to the first lane");
  assert.ok(!bar.has("5"), "outside the range");
  assert.equal(layout.today, 130 + 15.5 * 6);
  assert.equal(timelineLayout(box, data, { today: "2030-01-01" }).today, null);
  assert.equal(laneAt(layout, layout.lanes[1].y + 1), "b");
  assert.equal(daysFor(-14, layout), -2);
});

test("timeline: moving and resizing bars by days", () => {
  const data = defaultTimeline("2026-05-17", ["A", "B"], ["x", "y"]);
  assert.deepEqual([data.start, data.end], ["2026-05-01", "2026-07-31"]);
  const b1 = data.bars[0];
  const moved = changeBar(data, b1.id, { operation: "move", days: 3, lane: "l2" }).bars[0];
  assert.deepEqual([moved.start, moved.end, moved.lane], ["2026-05-07", "2026-06-03", "l2"]);
  const longer = changeBar(data, b1.id, { operation: "resize-end", days: 5 }).bars[0];
  assert.deepEqual([longer.start, longer.end], [b1.start, "2026-06-05"]);
  // The end never goes before the start.
  const squashed = changeBar(data, b1.id, { operation: "resize-end", days: -100 }).bars[0];
  assert.equal(squashed.end, squashed.start);
  const early = changeBar(data, b1.id, { operation: "resize-start", days: 100 }).bars[0];
  assert.equal(early.start, early.end);
  // Resizing does not change the lane.
  assert.equal(changeBar(data, b1.id, { operation: "resize-start", days: 1, lane: "l2" }).bars[0].lane, "l1");
});

test("timeline: bound to a database, records become bars and dates are written back", () => {
  const fields = [
    { id: "title", name: "Name", type: "text" },
    { id: "s", name: "Start", type: "date" },
    { id: "e", name: "Ende", type: "date" },
    { id: "team", name: "Team", type: "select", options: ["Web", "App"] },
  ] as unknown as Field[];
  const rows = [
    { id: "r1", cells: { title: "Login", s: "2026-03-01", e: "2026-03-10", team: "Web" }, version: 1 },
    { id: "r2", cells: { title: "Push", s: "2026-03-05T10:00", team: "Unbekannt" }, version: 1 },
    { id: "r3", cells: { title: "ohne Datum" }, version: 1 },
  ] as unknown as Row[];
  const source = { pageId: "db", startField: "s", endField: "e", laneField: "team" };
  const bound = boundTimeline(source, fields, rows, "Ohne");
  assert.ok(bound.valid);
  assert.deepEqual(bound.bars.map((b) => [b.id, b.lane, b.title, b.start, b.end]), [
    ["r1", "o:Web", "Login", "2026-03-01", "2026-03-10"],
    ["r2", "o:", "Push", "2026-03-05", "2026-03-05"],
  ]);
  assert.deepEqual(bound.lanes.map((l) => l.name), ["Web", "Ohne"]);
  assert.equal(boundTimeline({ ...source, startField: "title" }, fields, rows).valid, false);
  // The time of day of a date stays.
  assert.deepEqual(boundPatch(source, { start: "2026-03-07", end: "2026-03-08" }, rows[1]), { s: "2026-03-07T10:00", e: "2026-03-08" });
  // Records never end up in exports or search of the board.
  const stored = { scale: "month", start: "2026-03-01", end: "2026-03-31", lanes: bound.lanes, bars: bound.bars, source };
  assert.deepEqual(publicTimeline(stored)!.bars, []);
  assert.equal(itemText({ type: "timeline", text: "Plan", timeline: stored as never }), "Plan");
});

// ---- export ----

test("SVG export: library shapes, connector ends and timelines", () => {
  const items = [
    item({ id: "e1", type: "shape", shape: "rectangle", lib: "erd:entity", x: 0, y: 0, w: 200, h: 120, text: "Kunde\nid PK" }),
    item({ id: "e2", type: "shape", shape: "rectangle", lib: "erd:entity", x: 400, y: 0, w: 200, h: 120, text: "Bestellung" }),
    item({ id: "c", type: "connector", from: { id: "e1", x: 0, y: 0 }, to: { id: "e2", x: 0, y: 0 }, startMarker: "onlyOne", startArrow: true, endMarker: "zeroOrMany" }),
    item({
      id: "t",
      type: "timeline",
      x: 0,
      y: 300,
      w: 700,
      h: 200,
      text: "Roadmap",
      timeline: { scale: "month", start: "2026-01-01", end: "2026-03-31", lanes: [{ id: "l", name: "Team <A>" }], bars: [{ id: "b", lane: "l", title: "Phase 1", start: "2026-01-05", end: "2026-02-01" }] },
    }),
    item({
      id: "secret",
      type: "timeline",
      x: 0,
      y: 600,
      w: 700,
      h: 200,
      timeline: { scale: "month", start: "2026-01-01", end: "2026-03-31", lanes: [], bars: [{ id: "r1", lane: "", title: "Geheimprojekt", start: "2026-01-05", end: "2026-02-01" }], source: { pageId: "db", startField: "s" } },
    }),
    item({ id: "bad", type: "shape", shape: "rectangle", lib: '"><script>', x: 0, y: 900, text: "plain" }),
  ];
  const svg = whiteboardSvg(items, ctx, "Board")!;
  assert.ok(svg.includes("Kunde") && svg.includes("Bestellung"));
  // Crow's feet instead of the old arrowhead.
  assert.ok((svg.match(/stroke-linecap="round" stroke-linejoin="round"\/>/g) || []).length >= 3);
  assert.ok(svg.includes("Phase 1") && svg.includes("Team &lt;A&gt;") && svg.includes("Roadmap"));
  assert.ok(!svg.includes("Geheimprojekt"), "records of bound timelines stay out");
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes("plain"), "an unknown library id draws the plain outline");
  assert.doesNotMatch(svg, /NaN|undefined/);
  const own = timelineSvg({ w: 500, h: 200 }, parseTimeline(items[3].timeline)!, { today: "2026-02-01" });
  assert.match(own, /stroke="#e03131"/, "today marker");
  assert.equal(itemText(items[3]), "Roadmap Team <A> Phase 1");
});

test("Mermaid subgraphs: frames and their titles do not overlap", () => {
  const r = importDiagram("flowchart TD\n  subgraph S [Eins]\n    A --> B\n  end\n  subgraph T [Zwei]\n    C\n  end\n  subgraph U [Drei]\n    D\n  end\n  B --> C\n  B --> D");
  const frames = r.drafts.filter((d) => d.type === "frame");
  assert.equal(frames.length, 3);
  // Each frame with its title (28 px above it).
  const boxes = frames.map((f) => ({ x: f.x, y: f.y - 30, w: f.w, h: f.h + 30 }));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i], boxes[j]), `${frames[i].text}/${frames[j].text}`);
});
