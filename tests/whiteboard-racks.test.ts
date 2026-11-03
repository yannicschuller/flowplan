// Rack planning on whiteboards (#90): layout and U collisions, ports and
// cable ends, power and weight, the port overview and cable list (CSV),
// JSON export and import, the NetBox mapping and the drawings.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WhiteboardItem } from "../lib/whiteboard-model";
import { connectorPoint, itemText } from "../lib/whiteboard-model";
import { connectorGeometry } from "../lib/whiteboard-geometry";
import {
  RACK_HEADER,
  RACK_U,
  applyRackLayout,
  cableIssues,
  cableRows,
  cablesCsv,
  cableTypeFor,
  cleanRackFields,
  csvCell,
  firstFreeU,
  fits,
  parseRacksJson,
  portAnchor,
  portAt,
  portConnections,
  portLayout,
  portRows,
  portsCsv,
  rackCollisions,
  rackSize,
  rackTotals,
  racksJson,
  racksMarkdown,
  racksText,
  remapRack,
  resolveCables,
  settleCableEnds,
  snapDevice,
  sourceLoads,
  RackJsonError,
  type DeviceData,
} from "../lib/whiteboard-rack";
import { deviceTemplates, rackItem, templateDevice, deviceItem } from "../lib/whiteboard-rack-library";
import { netboxBase, fetchNetbox } from "../lib/whiteboard-rack-server";
import { netboxCableType, netboxKind, netboxPortType, netboxToRacks } from "../lib/whiteboard-rack-netbox";
import { deviceSvg, rackContext, rackSvg } from "../lib/whiteboard-rack-svg";
import { whiteboardSvg } from "../lib/whiteboard-svg";
import { placeDrafts } from "../lib/whiteboard-import";
import { cleanTemplateItems } from "../lib/whiteboard-user-templates";
import { templateDrafts } from "../lib/whiteboard-template-save";

const t = (de: string) => de;
const en = (_de: string, en: string) => en;
const template = (key: string) => templateDevice(deviceTemplates.find((d) => d.key === key)!);
let n = 0;
const rack = (id: string, u = 42, extra: Partial<WhiteboardItem> = {}): WhiteboardItem =>
  ({ id, type: "rack", x: 0, y: 0, w: 0, h: 0, z: -10, text: id, rack: { u, width: 19 }, ...extra }) as WhiteboardItem;
const device = (id: string, device: DeviceData, extra: Partial<WhiteboardItem> = {}): WhiteboardItem =>
  ({ id, type: "device", x: 0, y: 0, w: 0, h: 0, z: ++n, text: id, device, ...extra }) as WhiteboardItem;
const cable = (id: string, a: [string, string], b: [string, string], extra: Partial<WhiteboardItem> = {}): WhiteboardItem =>
  ({ id, type: "connector", x: 0, y: 0, w: 0, h: 0, z: ++n, from: { id: a[0], port: a[1], x: 0, y: 0 }, to: { id: b[0], port: b[1], x: 0, y: 0 }, cable: { type: "cat6a" }, ...extra }) as WhiteboardItem;
const portId = (d: DeviceData, name: string) => d.ports.find((p) => p.name === name)!.id;

test("layout: racks are sized by their units, devices sit at their U", () => {
  const items = applyRackLayout([rack("r1", 42, { x: 100, y: 50 }), device("s1", template("server-2u"), { rackId: "r1", u: 1 }), device("free", template("server-1u"), { x: 900, y: 10 })]);
  const r = items.find((i) => i.id === "r1")!;
  assert.deepEqual({ w: r.w, h: r.h }, rackSize({ u: 42, width: 19 }));
  assert.equal(r.h, RACK_HEADER + 42 * RACK_U + 12);
  const s = items.find((i) => i.id === "s1")!;
  // U1–2: the two lowest rows of the rack.
  assert.equal(s.y, 50 + RACK_HEADER + 40 * RACK_U);
  assert.equal(s.h, 2 * RACK_U);
  assert.ok(s.x > r.x && s.x + s.w < r.x + r.w);
  // Racks are drawn before devices whatever their depth.
  assert.ok(items.indexOf(r) < items.indexOf(s));
  const free = items.find((i) => i.id === "free")!;
  assert.deepEqual([free.x, free.y, free.h], [900, 10, RACK_U]);
  // Moving the rack carries its devices.
  const moved = applyRackLayout([rack("r1", 42, { x: 300, y: 50 }), device("s1", template("server-2u"), { rackId: "r1", u: 1 })]);
  assert.equal(moved.find((i) => i.id === "s1")!.x - s.x, 200);
  // A device whose rack is gone lies where it was stored, without its rack.
  const orphan = applyRackLayout([device("o", template("server-1u"), { rackId: "gone", u: 3, x: 5, y: 6 })])[0];
  assert.equal(orphan.rackId, undefined);
  assert.equal("u" in orphan, false);
  assert.equal(orphan.x, 5);
});

test("U collisions: overlaps, half depth front and rear, 0U sides, out of range", () => {
  const half = (depth: "front" | "rear") => ({ ...template("server-1u"), depth });
  const items = applyRackLayout([
    rack("r", 10),
    device("a", template("server-2u"), { rackId: "r", u: 5 }),
    device("b", template("server-1u"), { rackId: "r", u: 6 }),
    device("f", half("front"), { rackId: "r", u: 2 }),
    device("rr", half("rear"), { rackId: "r", u: 2 }),
    device("p1", template("pdu-0u"), { rackId: "r", u: 1 }),
    device("ok", template("server-1u"), { rackId: "r", u: 10 }),
  ]);
  // The 0U PDU is 20U long: it sticks out of a 10U rack.
  const bad = rackCollisions(items);
  assert.deepEqual([...bad].sort(), ["a", "b", "p1"]);
  // Front and rear half-depth devices share U2; a third half-depth front one cannot.
  assert.equal(fits(items, "r", half("front"), 2), false);
  assert.equal(fits(items, "r", half("rear"), 3), true);
  assert.equal(fits(items, "r", template("server-1u"), 2), false);
  assert.equal(fits(items, "r", template("server-1u"), 11), false);
  // The highest free place (racks fill from the top).
  assert.equal(firstFreeU(items, "r", template("server-1u")), 9);
  assert.equal(firstFreeU(items, "r", template("server-4u")), null);
  assert.equal(firstFreeU(items, "nope", template("server-1u")), null);
});

test("snapping: a dragged device lands on whole units of the rack under it", () => {
  const items = applyRackLayout([rack("r", 42, { x: 0, y: 0 }), rack("r2", 12, { x: 2000, y: 0 })]);
  const d = applyRackLayout([device("d", template("server-2u"), { x: 0, y: 0 })])[0];
  // Top edge at the row of U10 (+ a few pixels) → U9–10.
  const y = RACK_HEADER + (42 - 10) * RACK_U + 4;
  assert.deepEqual(snapDevice(items, d, 60, y), { rackId: "r", u: 9 });
  // Above the rack's top it stays inside (highest place).
  assert.deepEqual(snapDevice(items, d, 60, RACK_HEADER - 6), { rackId: "r", u: 41 });
  // Outside any rack: free, without rack.
  assert.deepEqual(snapDevice(items, d, 900, 900), { x: 900, y: 900, rackId: undefined, u: undefined });
  // A 0U device goes into the side channel nearer to it.
  const pdu = applyRackLayout([device("p", template("pdu-0u"))])[0];
  const left = snapDevice(items, pdu, 4, 100);
  assert.equal(left.rackId, "r");
  assert.equal(left.device?.mount, "left");
});

test("ports: laid out on the shown side, anchors and hits", () => {
  const sw = template("switch-48");
  const items = applyRackLayout([rack("r", 42, { x: 0, y: 0 }), device("sw", sw, { rackId: "r", u: 40 })]);
  const map = new Map(items.map((i) => [i.id, i]));
  const s = map.get("sw")!;
  const boxes = portLayout(s, map);
  assert.equal(boxes.length, sw.ports.length);
  const visible = boxes.filter((b) => b.visible);
  // Front: 48 RJ45, 4 SFP+, console; the PSU is at the back.
  assert.equal(visible.length, 53);
  for (const b of visible) {
    assert.ok(b.x >= s.x && b.x + b.w <= s.x + s.w + 0.01, "inside the device");
    assert.ok(b.y >= s.y && b.y + b.h <= s.y + s.h + 0.01);
  }
  // No two visible ports overlap.
  for (let i = 0; i < visible.length; i++)
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i],
        b = visible[j];
      assert.ok(a.x + a.w <= b.x + 0.01 || b.x + b.w <= a.x + 0.01 || a.y + a.h <= b.y + 0.01 || b.y + b.h <= a.y + 0.01, `${a.port.name}/${b.port.name}`);
    }
  const p7 = portId(sw, "7");
  const at = portAnchor(s, p7, map)!;
  assert.equal(portAt(s, at, map), p7);
  // The rear PSU anchors at the device's edge; turning the rack shows it.
  const psu = portId(sw, "PSU1");
  assert.equal(boxes.find((b) => b.port.id === psu)!.visible, false);
  const rear = applyRackLayout([rack("r", 42, { rack: { u: 42, width: 19, face: "rear" } }), device("sw", sw, { rackId: "r", u: 40 })]);
  const rmap = new Map(rear.map((i) => [i.id, i]));
  assert.equal(portLayout(rmap.get("sw")!, rmap).find((b) => b.port.id === psu)!.visible, true);
  // A connector end on a port follows the port.
  assert.deepEqual(connectorPoint({ id: "sw", port: p7, x: 0, y: 0 }, map, { x: 999, y: 999 }), at);
});

test("cables: ends, connections per port, doubled ports, loose ends, routes", () => {
  const sw = template("switch-24"),
    srv = template("server-1u");
  const items = applyRackLayout([
    rack("r1", 42, { x: 0, y: 0 }),
    rack("r2", 42, { x: 600, y: 0, rack: { u: 42, width: 19, face: "rear" } }),
    device("sw", sw, { rackId: "r1", u: 42 }),
    device("srv", srv, { rackId: "r2", u: 30 }),
    cable("c1", ["sw", portId(sw, "1")], ["srv", portId(srv, "eth1")], { cable: { type: "cat6a", label: "A-001", vlan: "20", length: 3 } }),
    cable("c2", ["sw", portId(sw, "1")], ["srv", portId(srv, "eth2")]),
    { id: "c3", type: "connector", x: 0, y: 0, w: 0, h: 0, z: 99, from: { id: "sw", port: portId(sw, "2"), x: 0, y: 0 }, to: { x: 5, y: 5 }, cable: { type: "cat6" } } as WhiteboardItem,
    { id: "plain", type: "connector", x: 0, y: 0, w: 0, h: 0, z: 100, from: { id: "sw", x: 0, y: 0 }, to: { id: "srv", x: 0, y: 0 } } as WhiteboardItem,
  ]);
  const resolved = resolveCables(items);
  assert.deepEqual(resolved.map((c) => c.item.id), ["c1", "c2", "c3"]);
  assert.equal(resolved[0].a?.port?.name, "1");
  assert.equal(resolved[0].b?.port?.name, "eth1");
  const connections = portConnections(items);
  assert.deepEqual(connections.get(`sw:${portId(sw, "1")}`), ["c1", "c2"]);
  const issues = cableIssues(items);
  assert.deepEqual(issues.doubled.map((d) => d.ids), [["c1", "c2"]]);
  assert.deepEqual(issues.loose, ["c3"]);
  // Across racks the cable goes up over the racks.
  const map = new Map(items.map((i) => [i.id, i]));
  const { d } = connectorGeometry(items.find((i) => i.id === "c1")!, map);
  assert.match(d, /^M [\d.]+ [\d.]+ V [\d.]+ H [\d.]+ V -\d+(\.\d)? H [\d.]+ V [\d.]+ H [\d.]+ V [\d.]+$/);
  // Rows of the overview and the cable list.
  const rows = portRows(items, en);
  const port1 = rows.find((r) => r.deviceId === "sw" && r.port === "1")!;
  assert.equal(port1.connectedTo, "srv · eth1 (+1)");
  assert.equal(port1.vlan, "20");
  assert.equal(port1.rack, "r1");
  const list = cableRows(items, en);
  assert.deepEqual(list[0], { id: "c1", label: "A-001", type: "cat6a", color: "#4263eb", length: 3, from: "sw · 1", to: "srv · eth1", vlan: "20", notes: "" });
  assert.equal(list[2].to, "–");
  assert.equal(cableTypeFor("c13", "c14"), "power");
  assert.equal(cableTypeFor("lc", "lc"), "om4");
  assert.equal(cableTypeFor("sfp+", "sfp+"), "dac");
  assert.equal(cableTypeFor("rj45", undefined), "cat6a");
});

test("power and weight: totals per rack and per PDU, warnings, UPS chains", () => {
  const ups = template("ups-2u"),
    pdu = template("pdu-1u"),
    srv = template("server-2u");
  const outlet = (d: DeviceData, i: number) => d.ports.filter((p) => p.type === "c13")[i].id;
  const items = applyRackLayout([
    rack("r", 42, { rack: { u: 42, width: 19, maxPowerW: 1000, maxWeightKg: 500 } }),
    device("ups", { ...ups, maxPowerW: 1200 }, { rackId: "r", u: 1 }),
    device("pdu", { ...pdu, maxPowerW: 800 }, { rackId: "r", u: 10 }),
    device("s1", srv, { rackId: "r", u: 20 }),
    device("s2", srv, { rackId: "r", u: 22 }),
    // s1: both power supplies on the PDU and the UPS (shares 250 W each).
    cable("p1", ["pdu", outlet(pdu, 0)], ["s1", portId(srv, "PSU1")], { cable: { type: "power" } }),
    cable("p2", ["ups", outlet(ups, 0)], ["s1", portId(srv, "PSU2")], { cable: { type: "power" } }),
    // s2 only on the PDU (500 W), the PDU on the UPS.
    cable("p3", ["s2", portId(srv, "PSU1")], ["pdu", outlet(pdu, 1)], { cable: { type: "power" } }),
    cable("p4", ["ups", outlet(ups, 1)], ["pdu", portId(pdu, "IN1")], { cable: { type: "power" } }),
  ]);
  const totals = rackTotals(items).get("r")!;
  assert.equal(totals.powerW, 60 + 500 + 500);
  assert.equal(totals.weightKg, 32 + 3 + 26 + 26);
  assert.equal(totals.units, 2 + 1 + 2 + 2);
  assert.equal(totals.overPower, true);
  assert.equal(totals.overWeight, false);
  const loads = sourceLoads(items);
  assert.equal(loads.get("pdu")!.loadW, 750);
  assert.equal(loads.get("pdu")!.over, false);
  // The UPS carries half of s1 and the whole PDU.
  assert.equal(loads.get("ups")!.loadW, 1000);
  assert.equal(loads.get("ups")!.over, false);
  const smaller = applyRackLayout(items.map((i) => (i.id === "pdu" ? { ...i, device: { ...i.device!, maxPowerW: 700 } } : i)));
  assert.equal(sourceLoads(smaller).get("pdu")!.over, true);
});

test("CSV: cable list and ports, quoted cells, formulas defused", () => {
  assert.equal(csvCell('a "b", c'), '"a ""b"", c"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("-1"), "'-1");
  assert.equal(csvCell(null), "");
  const csv = cablesCsv([{ id: "c", label: "L-1", type: "om4", color: "#ae3ec9", length: 2.5, from: "a · 1", to: "b · 2", vlan: "", notes: "line\nbreak" }], en);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "Label,Type,Colour,Length (m),From,To,VLAN,Notes");
  assert.equal(lines[1], 'L-1,OM4,#ae3ec9,2.5,a · 1,b · 2,,"line\nbreak"');
  assert.ok(csv.endsWith("\r\n"));
  const ports = portsCsv([{ deviceId: "d", device: "SW", rack: "R", portId: "p1", port: "1", type: "rj45", category: "network", face: "front", label: "", connectedTo: "", cableId: "", cable: "", vlan: "10" }], t);
  assert.equal(ports.split("\r\n")[1], "R,SW,1,RJ45,Vorne,,,,10");
});

test("JSON: export and import keep racks, devices, ports and cables", () => {
  const sw = template("switch-24"),
    srv = template("server-1u");
  const board = applyRackLayout([
    rack("r1", 24, { x: 500, y: 300, rack: { u: 24, width: 19, location: "DC1 · Raum 2", maxPowerW: 3000 } }),
    device("sw", sw, { rackId: "r1", u: 24, fill: "#0c8599" }),
    device("srv", srv, { rackId: "r1", u: 10 }),
    device("loose", srv, { x: 1200, y: 400 }),
    cable("c1", ["sw", portId(sw, "3")], ["srv", portId(srv, "eth1")], { cable: { type: "cat6", label: "X1", length: 1.5, color: "#e03131" } }),
    { id: "note", type: "sticky", x: 0, y: 0, w: 10, h: 10, z: 1, text: "nicht dabei" } as WhiteboardItem,
  ]);
  const json = racksJson(board);
  assert.equal(json.racks.length, 1);
  assert.equal(json.devices.length, 3);
  assert.equal(json.cables.length, 1);
  const drafts = settleCableEnds(parseRacksJson(JSON.stringify(json)));
  assert.equal(drafts.length, 5);
  // Placed on a board with new ids, everything is still wired up.
  const placed = placeDrafts(drafts, { newId: () => `id${++n}`, dx: 10, dy: 10 });
  const laid = applyRackLayout(placed);
  const again = racksJson(laid);
  const strip = (j: typeof json) => ({
    racks: j.racks.map(({ id: _, ...r }) => r),
    devices: j.devices.map(({ id: _, rack: __, ...d }) => d),
    cables: j.cables.map(({ id: _, a, b, ...c }) => ({ ...c, a: a.port, b: b.port })),
  });
  assert.deepEqual(strip(again), strip(json));
  const c = resolveCables(laid)[0];
  assert.equal(c.a?.port?.name, "3");
  assert.equal(c.b?.port?.name, "eth1");
  // Wrong files say why.
  assert.throws(() => parseRacksJson("{"), (e) => e instanceof RackJsonError && e.message === "json");
  assert.throws(() => parseRacksJson('{"format":"other"}'), (e) => e instanceof RackJsonError && e.message === "format");
  assert.throws(() => parseRacksJson('{"format":"flowplan-racks"}'), (e) => e instanceof RackJsonError && e.message === "empty");
  // Bad values from a file are dropped or replaced, never kept.
  const bad = parseRacksJson({ format: "flowplan-racks", racks: [{ id: 1, name: "<b>", u: 900, width: 7 }], devices: [{ id: 2, rack: 1, u: -4, height: "x", ports: [{ id: "a b", type: "rj45" }, { id: "ok", type: "bogus" }, { id: "p", type: "sfp+", face: "side" }] }] });
  assert.equal(bad[0].rack?.u, 42);
  assert.equal(bad[0].rack?.width, 19);
  assert.equal(bad[1].u, 1);
  assert.deepEqual(bad[1].device?.ports, [{ id: "p", name: "p", type: "sfp+", face: "front" }]);
});

test("checking: board data from clients is cleaned before use", () => {
  const raw = {
    id: "x",
    type: "device",
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    z: 0,
    rackId: "../evil",
    u: Infinity,
    device: { kind: "toaster", height: 99, ports: Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, type: "rj45" })), powerW: -5, notes: 5 },
    from: { id: "a", x: 0, y: 0, port: "<x>" },
    cable: "nope",
  } as unknown as WhiteboardItem;
  const clean = cleanRackFields(raw);
  assert.equal(clean.rackId, undefined);
  assert.equal(clean.u, undefined);
  assert.equal(clean.device?.kind, "other");
  assert.equal(clean.device?.height, 1);
  assert.equal(clean.device?.ports.length, 200);
  assert.equal(clean.device?.powerW, undefined);
  assert.equal(clean.from?.port, undefined);
  assert.equal(clean.cable, undefined);
});

test("copies: a device copied alone goes to the next free place of its rack", () => {
  const items = applyRackLayout([rack("r", 6), device("a", template("server-2u"), { rackId: "r", u: 3 }), device("b", template("server-1u"), { rackId: "r", u: 2 })]);
  const copy = remapRack(items[1], new Map(), items);
  assert.equal(copy.u, 5);
  assert.equal(copy.rackId, "r");
  // The rack is full for another 2U device: the copy lies next to the rack.
  const full = remapRack(items[1], new Map(), [...items, { ...items[1], id: "c", u: 5 }]);
  assert.equal(full.rackId, undefined);
  // Copied together with the rack, it goes into the copy.
  assert.equal(remapRack(items[1], new Map([["r", "r2"]]), items).rackId, "r2");
});

test("library: every device is valid and sized in whole units", () => {
  for (const d of deviceTemplates) {
    const data = templateDevice(d);
    const cleaned = cleanRackFields({ type: "device", device: data } as WhiteboardItem).device!;
    assert.deepEqual(cleaned, data, d.key);
    assert.equal(new Set(data.ports.map((p) => p.id)).size, data.ports.length, d.key);
  }
  const item = deviceItem(template("switch-48"), "SW", { x: 1.4, y: 2.6 });
  assert.equal(item.h, RACK_U);
  assert.equal(item.x, 1);
  assert.equal(rackItem(12, en, { x: 0, y: 0 }).text, "Wall cabinet");
});

test("drawings: finite SVG, escaped names, warnings and collisions shown", () => {
  const items = applyRackLayout([
    rack("r", 12, { text: '<script>alert(1)</script>', rack: { u: 12, width: 19, maxWeightKg: 10, location: 'A&B "1"' } }),
    device("a", template("server-4u"), { rackId: "r", u: 1, text: "<img onerror=x>" }),
    device("b", template("switch-48"), { rackId: "r", u: 4 }),
  ]);
  const map = new Map(items.map((i) => [i.id, i]));
  const ctx = rackContext(map);
  const rackMarkup = rackSvg(items[0], ctx, en);
  assert.ok(!rackMarkup.includes("<script>"));
  assert.ok(rackMarkup.includes("&lt;script&gt;"));
  assert.ok(rackMarkup.includes("A&amp;B &quot;1&quot;"));
  assert.ok(rackMarkup.includes("Weight limit exceeded"));
  assert.ok(!/NaN|Infinity|undefined/.test(rackMarkup));
  const devMarkup = deviceSvg(map.get("a")!, map, ctx, en);
  assert.ok(!devMarkup.includes("<img"));
  assert.ok(devMarkup.includes("wb-device-collision"));
  assert.ok(!/NaN|Infinity|undefined/.test(devMarkup));
  // The whole board as SVG (Markdown export) contains the rack.
  const svg = whiteboardSvg(items, { image: () => null, page: () => null, record: () => null, label: en }, "Racks")!;
  assert.ok(svg.includes("wb-rack-body") && svg.includes("wb-rack-port"));
  assert.ok(svg.includes('id="wb-rack-clash"'));
  // Search text includes models and port labels.
  assert.match(itemText({ type: "device", text: "SW", device: { ...template("switch-24"), model: "C9300", ports: [{ id: "p1", name: "1", type: "rj45", face: "front", label: "Uplink" }] } }), /SW C9300 Uplink/);
});

test("Markdown and text: devices, port assignments and the cable list", () => {
  const sw = template("switch-24"),
    srv = template("server-1u");
  const items = [
    rack("r", 12, { text: "Rack | A", rack: { u: 12, width: 19, location: "DC1" } }),
    device("sw", sw, { rackId: "r", u: 12, text: "core-sw" }),
    device("srv", srv, { rackId: "r", u: 1, text: "host-1" }),
    cable("c", ["sw", portId(sw, "5")], ["srv", portId(srv, "eth1")], { cable: { type: "cat6a", label: "K-5", length: 2, vlan: "100" } }),
  ];
  const md = racksMarkdown(items, en, (s) => s.replaceAll("|", "\\|"));
  assert.match(md, /### Rack \\\| A/);
  assert.match(md, /\| U12 \| core-sw \| Switch \|/);
  assert.match(md, /### Port assignments/);
  assert.match(md, /\| core-sw \| 5 \| RJ45 \| host-1 · eth1 \| K-5 \| 100 \|/);
  assert.match(md, /### Cable list\n\n\| Label \| Type \| From \| To \| Length \| Colour \| VLAN \| Notes \|/);
  assert.match(md, /\| K-5 \| Cat6a \| core-sw · 5 \| host-1 · eth1 \| 2 m \|/);
  assert.equal(racksMarkdown([{ id: "n", type: "sticky", x: 0, y: 0, w: 1, h: 1, z: 0 }], en, (s) => s), "");
  const text = racksText(items, en);
  assert.match(text, /^Rack Rack \| A \(12U, 19″, DC1; 2\/12U/);
  assert.match(text, /- core-sw \(U12\): Switch, 45 W, 4 kg, ports: 1 RJ45/);
  assert.match(text, /- K-5: core-sw · 5 → host-1 · eth1 \(Cat6a, 2 m, VLAN 100\)/);
});

test("templates: own board templates keep racks, devices and port ends", () => {
  const sw = template("switch-24"),
    srv = template("server-1u");
  const items = applyRackLayout([rack("r", 12), device("sw", sw, { rackId: "r", u: 12 }), device("srv", srv, { rackId: "r", u: 1 }), cable("c", ["sw", portId(sw, "1")], ["srv", portId(srv, "eth1")])]);
  const drafts = templateDrafts(items);
  const stored = cleanTemplateItems(JSON.parse(JSON.stringify(drafts)));
  const c = stored.find((d) => d.type === "connector")!;
  assert.equal(c.from?.port, portId(sw, "1"));
  assert.equal(stored.find((d) => d.id === "sw")!.rackId, "r");
  assert.equal(stored.find((d) => d.id === "r")!.rack?.u, 12);
  // Placing them keeps devices in the placed rack.
  const placed = applyRackLayout(placeDrafts(stored as never, { newId: () => `n${++n}` }));
  const newRack = placed.find((i) => i.type === "rack")!;
  assert.ok(placed.filter((i) => i.type === "device").every((d) => d.rackId === newRack.id));
  // Without the rack, a device lies freely.
  const alone = placeDrafts([stored.find((d) => d.id === "sw")!] as never, { newId: () => "x" });
  assert.equal(alone[0].rackId, undefined);
  assert.equal(alone[0].u, undefined);
});

test("NetBox: racks, devices, interfaces, power and cables are mapped", () => {
  assert.equal(netboxPortType("interfaces", "1000base-t"), "rj45");
  assert.equal(netboxPortType("interfaces", "10gbase-x-sfpp"), "sfp+");
  assert.equal(netboxPortType("interfaces", "25gbase-x-sfp28"), "sfp28");
  assert.equal(netboxPortType("interfaces", "100gbase-x-qsfp28"), "qsfp28");
  assert.equal(netboxPortType("interfaces", "virtual"), null);
  assert.equal(netboxPortType("powerPorts", "iec-60320-c14"), "c14");
  assert.equal(netboxPortType("powerOutlets", "iec-60320-c19"), "c19");
  assert.equal(netboxPortType("frontPorts", "lc-apc"), "lc");
  assert.equal(netboxCableType("mmf-om4"), "om4");
  assert.equal(netboxCableType("smf-os2"), "os2");
  assert.equal(netboxCableType("dac-passive"), "dac");
  assert.equal(netboxCableType("cat6a"), "cat6a");
  assert.equal(netboxKind("access-switch"), "switch");
  assert.equal(netboxKind("Hypervisor"), "server");
  assert.equal(netboxKind("pdu"), "pdu");
  const result = netboxToRacks({
    racks: [{ id: 7, name: "R-07", site: { name: "Berlin" }, location: { name: "Raum 1" }, u_height: 42, width: { value: "19" }, max_weight: 1000, weight_unit: { value: "kg" } }],
    deviceTypes: [
      { id: 1, model: "C9300-48P", manufacturer: { name: "Cisco" }, u_height: 1, is_full_depth: false, weight: 14, weight_unit: { value: "lb" } },
      { id: 2, model: "R650", manufacturer: { name: "Dell" }, u_height: 1 },
    ],
    devices: [
      { id: 11, name: "sw-1", device_type: { id: 1 }, role: { slug: "access-switch", name: "Access switch" }, rack: { id: 7 }, position: 40, face: { value: "front" } },
      { id: 12, name: "esx-1", device_type: { id: 2 }, role: { slug: "server" }, rack: { id: 7 }, position: 20.5, face: { value: "rear" }, serial: "ABC" },
      { id: 13, name: "unracked", device_type: { id: 2 }, role: { slug: "server" }, rack: { id: 7 }, position: null },
    ],
    interfaces: [
      { id: 100, device: { id: 11 }, name: "Gi1/0/1", type: { value: "1000base-t" }, untagged_vlan: { vid: 20 } },
      { id: 101, device: { id: 11 }, name: "Vlan20", type: { value: "virtual" } },
      { id: 200, device: { id: 12 }, name: "eno1", type: { value: "1000base-t" }, label: "LOM1" },
    ],
    frontPorts: [],
    rearPorts: [],
    consolePorts: [],
    powerPorts: [{ id: 300, device: { id: 12 }, name: "PSU1", type: { value: "iec-60320-c14" }, allocated_draw: 320 }],
    powerOutlets: [],
    cables: [
      { id: 900, label: "C-900", type: "cat6", color: "2196f3", length: 300, length_unit: { value: "cm" }, a_terminations: [{ object_type: "dcim.interface", object_id: 100 }], b_terminations: [{ object_type: "dcim.interface", object_id: 200 }] },
      // Ends outside the import are skipped.
      { id: 901, a_terminations: [{ object_type: "dcim.interface", object_id: 100 }], b_terminations: [{ object_type: "dcim.interface", object_id: 999 }] },
    ],
  });
  assert.deepEqual(result.racks, [{ id: "nb-rack-7", name: "R-07", u: 42, width: 19, location: "Berlin · Raum 1", face: "front", maxWeightKg: 1000 }]);
  const sw = result.devices[0];
  assert.equal(sw.kind, "switch");
  assert.equal(sw.u, 40);
  assert.equal(sw.depth, "front");
  assert.equal(sw.weightKg, 6.4);
  assert.deepEqual(sw.ports, [{ id: "p1", name: "Gi1/0/1", type: "rj45", face: "front", vlan: "20" }]);
  const esx = result.devices[1];
  assert.equal(esx.u, 20);
  assert.equal(esx.powerW, 320);
  assert.equal(esx.ports[0].face, "rear");
  assert.equal(result.devices[2].rack, undefined);
  assert.deepEqual(result.cables, [{ id: "nb-cable-900", a: { device: "nb-dev-11", port: "p1" }, b: { device: "nb-dev-12", port: "p1" }, type: "cat6", color: "#2196f3", length: 3, label: "C-900" }]);
  // The result goes through the same import as a JSON file.
  const drafts = parseRacksJson(result);
  assert.equal(drafts.filter((d) => d.type === "device").length, 3);
  assert.equal(drafts.filter((d) => d.type === "connector").length, 1);
});

test("NetBox: the API address, token header, paging and errors", async () => {
  assert.equal(netboxBase("netbox.example.com"), "https://netbox.example.com/api");
  assert.equal(netboxBase("https://example.com/netbox/api/"), "https://example.com/netbox/api");
  assert.throws(() => netboxBase("https://user:pw@example.com"));
  const calls: { url: string; auth: string }[] = [];
  const pages: Record<string, unknown> = {
    racks: { results: [{ id: 1, name: "R1", u_height: 10 }], next: "https://nb.example/api/dcim/racks/?limit=1000&offset=1000" },
    racks2: { results: [], next: null },
    devices: { results: [{ id: 5, name: "d", device_type: { id: 3 }, rack: { id: 1 }, position: 2 }], next: null },
    empty: { results: [], next: null },
  };
  const fetcher = async (url: string, headers: Record<string, string>) => {
    calls.push({ url, auth: headers.Authorization });
    const key = url.includes("offset=1000") ? "racks2" : url.includes("dcim/racks/") ? "racks" : url.includes("dcim/devices/") ? "devices" : "empty";
    return { status: 200, body: JSON.stringify(pages[key]) };
  };
  const data = await fetchNetbox({ url: "https://nb.example", token: "0123456789abcdef", site: "ber", racks: "R1" }, fetcher);
  assert.equal(data.racks.length, 1);
  assert.equal(data.devices.length, 1);
  assert.equal(calls[0].url, "https://nb.example/api/dcim/racks/?site=ber&name=R1&limit=1000");
  assert.equal(calls[0].auth, "Token 0123456789abcdef");
  assert.ok(calls.some((c) => c.url.includes("dcim/device-types/?id=3")));
  assert.ok(calls.some((c) => c.url.includes("dcim/interfaces/?device_id=5")));
  const bearer: string[] = [];
  await fetchNetbox({ url: "https://nb.example", token: "nbt_abcdefgh.secret" }, async (url, headers) => {
    bearer.push(headers.Authorization);
    return { status: 200, body: JSON.stringify(url.includes("racks") ? pages.racks2 : pages.empty) };
  }).catch(() => {});
  assert.equal(bearer[0], "Bearer nbt_abcdefgh.secret");
  await assert.rejects(fetchNetbox({ url: "https://nb.example", token: "0123456789abcdef" }, async () => ({ status: 403, body: "" })), /Token abgelehnt/);
  await assert.rejects(fetchNetbox({ url: "https://nb.example", token: "0123456789abcdef" }, async () => ({ status: 200, body: "<html>" })), /kein JSON/);
  await assert.rejects(fetchNetbox({ url: "https://nb.example", token: "0123456789abcdef" }, async () => ({ status: 200, body: '{"results":[]}' })), /keine passenden Racks/);
  // A "next" link to another server is not followed.
  const hosts: string[] = [];
  await fetchNetbox({ url: "https://nb.example", token: "0123456789abcdef" }, async (url) => {
    hosts.push(new URL(url).host);
    return { status: 200, body: JSON.stringify(url.includes("racks") ? { results: [{ id: 1 }], next: "https://evil.example/api/dcim/racks/" } : pages.empty) };
  });
  assert.ok(hosts.every((h) => h === "nb.example"));
});
