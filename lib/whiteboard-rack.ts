// Rack planning on whiteboards (#90). Racks and the devices in them are
// whiteboard elements; cables are connectors whose ends sit on ports of
// devices. Like every board property the data is plain JSON inside the
// item's Y.Map, so it travels with collaboration, undo, copies, templates
// and archives:
//
//   rack     item.rack   = { u, width, location, face, maxPowerW, maxWeightKg }
//            item.text   = the rack's name
//   device   item.device = { kind, height, depth, mount, ports, power … }
//            item.rackId, item.u = the rack it is mounted in and its lowest U
//            item.text   = the device's name, item.fill its colour
//   cable    a connector with item.cable = { type, color, length, label … }
//            and from.port / to.port = the ports its ends sit on
//
// Geometry of racks and of the devices in them follows from these values
// (applyRackLayout): moving a rack carries its devices, a device snaps to
// whole units. Board data comes from every client, so everything here is
// checked before it is drawn, counted or exported; wrong values are dropped.
// Client-safe: no server imports.
import type { ConnectorEnd, Point, WhiteboardItem } from "./whiteboard-model";
import { CSV_FORMULA } from "./cell-text";

// ---- sizes on the board (px) ----

export const RACK_U = 22; // one rack unit (1.75″)
export const RACK_SIDE = 18; // vertical cable channel / 0U mounting each side
export const RACK_RAIL = 24; // mounting rail with the unit numbers
export const RACK_HEADER = 42;
export const RACK_FOOTER = 12;
export const RACK_MAX_U = 60;
export const rackWidths = [10, 19, 23] as const;
export type RackWidth = (typeof rackWidths)[number];
// Inner width between the rails: 19″ ≈ 10.9 units wide, like real gear.
export const innerWidth = (width: RackWidth) => (width === 10 ? 130 : width === 23 ? 290 : 240);

// ---- data ----

export const portTypes = ["rj45", "sfp", "sfp+", "sfp28", "qsfp+", "qsfp28", "lc", "sc", "mpo", "console", "usb", "c13", "c14", "c19", "c20", "schuko", "dc"] as const;
export type PortType = (typeof portTypes)[number];
export const portCategories = ["network", "fibre", "power"] as const;
export type PortCategory = (typeof portCategories)[number];
export const portCategory = (type: PortType): PortCategory =>
  ["c13", "c14", "c19", "c20", "schuko", "dc"].includes(type) ? "power" : ["sfp", "sfp+", "sfp28", "qsfp+", "qsfp28", "lc", "sc", "mpo"].includes(type) ? "fibre" : "network";
// Port type names (technical, the same in every language).
export const portTypeNames: Record<PortType, string> = {
  rj45: "RJ45",
  sfp: "SFP",
  "sfp+": "SFP+",
  sfp28: "SFP28",
  "qsfp+": "QSFP+",
  qsfp28: "QSFP28",
  lc: "LC",
  sc: "SC",
  mpo: "MPO",
  console: "Console",
  usb: "USB",
  c13: "C13",
  c14: "C14",
  c19: "C19",
  c20: "C20",
  schuko: "Schuko",
  dc: "DC",
};
export type Face = "front" | "rear";
export type RackPort = { id: string; name: string; type: PortType; face: Face; label?: string; vlan?: string };
export type RackData = {
  u: number;
  width: RackWidth;
  location?: string;
  // The side shown on the board.
  face?: Face;
  maxPowerW?: number;
  maxWeightKg?: number;
};
export const deviceKinds = ["server", "switch", "patch", "router", "firewall", "storage", "ups", "pdu", "blank", "cable", "shelf", "other"] as const;
export type DeviceKind = (typeof deviceKinds)[number];
// i18n-table: 1 – names of device kinds
export const deviceKindNames: Record<DeviceKind, [string, string]> = {
  server: ["Server", "Server"],
  switch: ["Switch", "Switch"],
  patch: ["Patchfeld", "Patch panel"],
  router: ["Router", "Router"],
  firewall: ["Firewall", "Firewall"],
  storage: ["Speicher/NAS", "Storage/NAS"],
  ups: ["USV", "UPS"],
  pdu: ["PDU", "PDU"],
  blank: ["Blindplatte", "Blanking panel"],
  cable: ["Kabelführung", "Cable manager"],
  shelf: ["Fachboden", "Shelf"],
  other: ["Sonstiges", "Other"],
};
export type DeviceData = {
  kind: DeviceKind;
  // Height in units (0U devices: their length along the rack).
  height: number;
  // Full depth, or half depth mounted at the front or the rear.
  depth?: "full" | "front" | "rear";
  // In the rails, or 0U in the left or right side channel (vertical PDUs).
  mount?: "rack" | "left" | "right";
  manufacturer?: string;
  model?: string;
  serial?: string;
  powerW?: number;
  weightKg?: number;
  // What a PDU or UPS can supply.
  maxPowerW?: number;
  notes?: string;
  ports: RackPort[];
};
export const cableTypes = ["cat5e", "cat6", "cat6a", "cat7", "cat8", "om3", "om4", "om5", "os2", "dac", "aoc", "power", "console", "other"] as const;
export type CableType = (typeof cableTypes)[number];
// Cable type names (technical, the same in every language).
export const cableTypeNames: Record<CableType, string> = {
  cat5e: "Cat5e",
  cat6: "Cat6",
  cat6a: "Cat6a",
  cat7: "Cat7",
  cat8: "Cat8",
  om3: "OM3",
  om4: "OM4",
  om5: "OM5",
  os2: "OS2",
  dac: "DAC",
  aoc: "AOC",
  power: "Power",
  console: "Console",
  other: "Other",
};
export const cableCategory = (type: CableType): PortCategory =>
  type === "power" ? "power" : ["om3", "om4", "om5", "os2", "aoc"].includes(type) ? "fibre" : "network";
export type CableData = { type: CableType; color?: string; length?: number; label?: string; vlan?: string; notes?: string };
// Usual jacket colours: OM3 aqua, OM4 violet, OS2 yellow, power black.
const cableTypeColors: Record<CableType, string> = {
  cat5e: "#868e96",
  cat6: "#1c7ed6",
  cat6a: "#4263eb",
  cat7: "#2b8a3e",
  cat8: "#5f3dc4",
  om3: "#15aabf",
  om4: "#ae3ec9",
  om5: "#82c91e",
  os2: "#f59f00",
  dac: "#343a40",
  aoc: "#0b7285",
  power: "#212529",
  console: "#748ffc",
  other: "#495057",
};
export const cableColors = ["#1c7ed6", "#e03131", "#2f9e44", "#f59f00", "#ae3ec9", "#15aabf", "#f76707", "#e64980", "#868e96", "#212529", "#f8f9fa"];
export const cableStyle = (cable: CableData) => ({
  color: cable.color || cableTypeColors[cable.type],
  width: cable.type === "power" ? 3 : cableCategory(cable.type) === "fibre" ? 1.6 : 2.2,
  dash: cable.type === "dac" || cable.type === "aoc" ? "6 3" : cable.type === "console" ? "2 3" : undefined,
});
// A cable type that suits the ports at its ends.
export function cableTypeFor(a?: PortType, b?: PortType): CableType {
  const types = [a, b].filter(Boolean) as PortType[];
  if (types.some((t) => portCategory(t) === "power")) return "power";
  if (types.includes("console")) return "console";
  if (types.some((t) => ["lc", "sc", "mpo"].includes(t))) return "om4";
  if (types.length && types.every((t) => portCategory(t) === "fibre")) return "dac";
  return "cat6a";
}

// ---- checking client data (hand-written: runs on every board change) ----

const ID = /^[\w-]{1,64}$/;
const COLOR = /^#[0-9a-f]{3,8}$/i;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);
const num = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined);
const int = (v: unknown, min: number, max: number) => {
  const n = num(v, min, max);
  return n === undefined ? undefined : Math.round(n);
};
const pick = <T extends string>(v: unknown, list: readonly T[]) => (list.includes(v as T) ? (v as T) : undefined);
const compact = <T extends Record<string, unknown>>(o: T) => {
  for (const key of Object.keys(o)) if (o[key] === undefined) delete o[key];
  return o;
};
export const MAX_PORTS = 200;
export function cleanPort(raw: unknown): RackPort | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const id = typeof p.id === "string" && ID.test(p.id) ? p.id : null;
  const type = pick(p.type, portTypes);
  if (!id || !type) return null;
  return compact({ id, name: str(p.name, 40) ?? id, type, face: pick(p.face, ["front", "rear"] as const) ?? "front", label: str(p.label, 80), vlan: str(p.vlan, 40) });
}
export function cleanRack(raw: unknown): RackData | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return compact({
    u: int(r.u, 1, RACK_MAX_U) ?? 42,
    width: (rackWidths as readonly number[]).includes(r.width as number) ? (r.width as RackWidth) : 19,
    location: str(r.location, 120),
    face: pick(r.face, ["front", "rear"] as const),
    maxPowerW: num(r.maxPowerW, 1, 1e6),
    maxWeightKg: num(r.maxWeightKg, 1, 1e5),
  });
}
export function cleanDevice(raw: unknown): DeviceData | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const ports: RackPort[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(d.ports) ? d.ports.slice(0, MAX_PORTS) : []) {
    const port = cleanPort(p);
    if (port && !seen.has(port.id)) {
      seen.add(port.id);
      ports.push(port);
    }
  }
  return compact({
    kind: pick(d.kind, deviceKinds) ?? "other",
    height: int(d.height, 1, RACK_MAX_U) ?? 1,
    depth: pick(d.depth, ["full", "front", "rear"] as const),
    mount: pick(d.mount, ["rack", "left", "right"] as const),
    manufacturer: str(d.manufacturer, 80),
    model: str(d.model, 80),
    serial: str(d.serial, 80),
    powerW: num(d.powerW, 0, 1e5),
    weightKg: num(d.weightKg, 0, 1e4),
    maxPowerW: num(d.maxPowerW, 1, 1e6),
    notes: str(d.notes, 4000),
    ports,
  });
}
export function cleanCable(raw: unknown): CableData | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  return compact({
    type: pick(c.type, cableTypes) ?? "other",
    color: typeof c.color === "string" && COLOR.test(c.color) ? c.color : undefined,
    length: num(c.length, 0, 10000),
    label: str(c.label, 80),
    vlan: str(c.vlan, 40),
    notes: str(c.notes, 2000),
  });
}
// The rack properties of an item, checked (others as they are).
export function cleanRackFields<T extends Partial<WhiteboardItem>>(item: T): T {
  const out = { ...item } as T & Record<string, unknown>;
  for (const [key, clean] of [["rack", cleanRack], ["device", cleanDevice], ["cable", cleanCable]] as const) {
    if (out[key] === undefined) continue;
    const value = clean(out[key]);
    if (value) (out as Record<string, unknown>)[key] = value;
    else delete out[key];
  }
  if (out.rackId !== undefined && !(typeof out.rackId === "string" && ID.test(out.rackId))) delete out.rackId;
  if (out.u !== undefined) {
    const u = int(out.u, 1, RACK_MAX_U);
    if (u === undefined) delete out.u;
    else out.u = u;
  }
  for (const end of ["from", "to"] as const) {
    const e = out[end] as ConnectorEnd | undefined;
    if (e?.port !== undefined && !(typeof e.port === "string" && ID.test(e.port))) {
      const { port: _, ...rest } = e;
      out[end] = rest as never;
    }
  }
  return out;
}

// ---- layout ----

export const rackOf = (item: WhiteboardItem) => (item.type === "rack" ? cleanRack(item.rack) || { u: 42, width: 19 as RackWidth } : null);
export const deviceOf = (item: WhiteboardItem) => (item.type === "device" ? cleanDevice(item.device) || { kind: "other" as DeviceKind, height: 1, ports: [] } : null);
export function rackSize(rack: RackData) {
  return { w: (RACK_SIDE + RACK_RAIL) * 2 + innerWidth(rack.width), h: RACK_HEADER + rack.u * RACK_U + RACK_FOOTER };
}
// The top of unit row `u` (1 = lowest) of a rack at y.
export const unitTop = (rack: RackData, y: number, u: number) => y + RACK_HEADER + (rack.u - u) * RACK_U;
export const zeroU = (device: DeviceData) => device.mount === "left" || device.mount === "right";
// Where a device sits: in its rack (by U), or freely on the board.
export function deviceBox(device: DeviceData, item: Pick<WhiteboardItem, "x" | "y" | "u">, rack?: { item: WhiteboardItem; data: RackData }) {
  const h = device.height * RACK_U;
  const free = { x: item.x, y: item.y, w: zeroU(device) ? RACK_SIDE - 4 : innerWidth(rack?.data.width ?? 19), h };
  if (!rack) return free;
  const u = Math.max(1, Math.min(rack.data.u, item.u || 1));
  const y = unitTop(rack.data, rack.item.y, u + device.height - 1);
  const size = rackSize(rack.data);
  if (device.mount === "left") return { x: rack.item.x + 2, y, w: RACK_SIDE - 4, h };
  if (device.mount === "right") return { x: rack.item.x + size.w - RACK_SIDE + 2, y, w: RACK_SIDE - 4, h };
  return { x: rack.item.x + RACK_SIDE + RACK_RAIL, y, w: innerWidth(rack.data.width), h };
}
// Racks get their size from their units, devices their place from their
// rack: the board, the server and the exports read items through this.
// Racks come first (after frames keep their own place), so devices and
// cables lie above them whatever their depth order.
export function applyRackLayout(items: WhiteboardItem[]): WhiteboardItem[] {
  if (!items.some((i) => i.type === "rack" || i.type === "device" || i.cable)) return items;
  // Copies without the keys that do not apply (no undefined values: the
  // result is also written back into boards, e.g. by copies).
  const without = (item: WhiteboardItem, keys: (keyof WhiteboardItem)[]) => {
    const copy = { ...item };
    for (const key of keys) delete copy[key];
    return copy;
  };
  const racks = new Map<string, { item: WhiteboardItem; data: RackData }>();
  for (const item of items)
    if (item.type === "rack") {
      const data = rackOf(item)!;
      racks.set(item.id, { item: { ...without(item, ["rotation"]), ...rackSize(data), rack: data }, data });
    }
  const frames: WhiteboardItem[] = [],
    rackItems: WhiteboardItem[] = [],
    rest: WhiteboardItem[] = [];
  for (const item of items) {
    if (item.type === "rack") rackItems.push(racks.get(item.id)!.item);
    else if (item.type === "frame") frames.push(item);
    else if (item.type === "device") {
      const data = deviceOf(item)!;
      const rack = item.rackId ? racks.get(item.rackId) : undefined;
      rest.push({ ...without(item, rack ? ["rotation"] : ["rotation", "rackId", "u"]), ...deviceBox(data, item, rack), device: data });
    } else if (item.cable) {
      const cable = cleanCable(item.cable);
      rest.push(cable ? { ...item, cable } : without(item, ["cable"]));
    } else rest.push(item);
  }
  // Frames first, then racks, so devices and cables lie above their racks.
  return [...frames, ...rackItems, ...rest];
}
export const racksIn = (items: WhiteboardItem[]) => items.filter((i) => i.type === "rack");
export const devicesIn = (items: WhiteboardItem[], rackId?: string) =>
  items.filter((i) => i.type === "device" && (rackId === undefined || i.rackId === rackId));
// The units a device occupies.
export function deviceUnits(item: WhiteboardItem) {
  const d = deviceOf(item);
  if (!d || !item.u) return null;
  return { from: item.u, to: item.u + d.height - 1 };
}
// Whether two devices in the same rack can share units: half-depth devices
// at the front and the rear can; 0U devices only clash on the same side.
function clash(a: DeviceData, b: DeviceData) {
  const sideA = zeroU(a) ? a.mount : "rack",
    sideB = zeroU(b) ? b.mount : "rack";
  if (sideA !== sideB) return false;
  if (sideA !== "rack") return true;
  const da = a.depth || "full",
    db = b.depth || "full";
  return da === "full" || db === "full" || da === db;
}
// Devices that overlap another one or stick out of their rack.
export function rackCollisions(items: WhiteboardItem[]) {
  const bad = new Set<string>();
  const racks = new Map(racksIn(items).map((r) => [r.id, rackOf(r)!]));
  const byRack = new Map<string, WhiteboardItem[]>();
  for (const d of devicesIn(items))
    if (d.rackId && racks.has(d.rackId)) byRack.set(d.rackId, [...(byRack.get(d.rackId) || []), d]);
  for (const [rackId, list] of byRack) {
    const rack = racks.get(rackId)!;
    for (const d of list) {
      const units = deviceUnits(d);
      if (units && (units.from < 1 || units.to > rack.u)) bad.add(d.id);
    }
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = deviceUnits(list[i]),
          b = deviceUnits(list[j]);
        if (!a || !b || a.to < b.from || b.to < a.from) continue;
        if (clash(deviceOf(list[i])!, deviceOf(list[j])!)) {
          bad.add(list[i].id);
          bad.add(list[j].id);
        }
      }
  }
  return bad;
}
// Whether a device fits at unit u of a rack without a collision.
export function fits(items: WhiteboardItem[], rackId: string, device: DeviceData, u: number, exclude?: string) {
  const rack = items.find((i) => i.id === rackId && i.type === "rack");
  if (!rack) return false;
  const data = rackOf(rack)!;
  if (u < 1 || u + device.height - 1 > data.u) return false;
  return !devicesIn(items, rackId).some((other) => {
    if (other.id === exclude) return false;
    const units = deviceUnits(other);
    return !!units && !(units.to < u || u + device.height - 1 < units.from) && clash(device, deviceOf(other)!);
  });
}
// The highest free place for a device (racks are filled from the top), or null.
export function firstFreeU(items: WhiteboardItem[], rackId: string, device: DeviceData, exclude?: string) {
  const rack = items.find((i) => i.id === rackId && i.type === "rack");
  if (!rack) return null;
  for (let u = rackOf(rack)!.u - device.height + 1; u >= 1; u--) if (fits(items, rackId, device, u, exclude)) return u;
  return null;
}
// The rack whose units lie under a point, topmost first.
export function rackAt(items: WhiteboardItem[], p: Point) {
  for (let i = items.length - 1; i >= 0; i--) {
    const r = items[i];
    if (r.type === "rack" && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return r;
  }
  return undefined;
}
// Where a device dragged to (x, y) lands: in the rack under its middle,
// snapped to whole units (0U devices into the side channel nearer to it),
// or freely on the board.
export function snapDevice(items: WhiteboardItem[], item: WhiteboardItem, x: number, y: number): Partial<WhiteboardItem> {
  const device = deviceOf(item);
  if (!device) return { x, y };
  const free = { x: Math.round(x), y: Math.round(y), rackId: undefined, u: undefined };
  const middle = { x: x + item.w / 2, y: y + item.h / 2 };
  const rack = rackAt(items, middle);
  if (!rack) return free;
  const data = rackOf(rack)!;
  const row = Math.round((y - (rack.y + RACK_HEADER)) / RACK_U);
  const u = Math.max(1, Math.min(data.u - device.height + 1, data.u - row - device.height + 1));
  if (device.height > data.u) return free;
  const props: Partial<WhiteboardItem> = { rackId: rack.id, u };
  if (zeroU(device)) {
    const mount = middle.x < rack.x + rack.w / 2 ? "left" : "right";
    if (mount !== device.mount) props.device = { ...device, mount };
  }
  return props;
}
// Units used of a rack (0U devices do not count).
export function usedUnits(items: WhiteboardItem[], rackId: string) {
  const used = new Set<number>();
  for (const d of devicesIn(items, rackId)) {
    const data = deviceOf(d)!,
      units = deviceUnits(d);
    if (!units || zeroU(data)) continue;
    for (let u = units.from; u <= units.to; u++) used.add(u);
  }
  return used.size;
}

// ---- ports ----

export type PortBox = { port: RackPort; x: number; y: number; w: number; h: number; visible: boolean };
// The side of a device that is seen: the side its rack shows, or the front
// for devices lying freely. "ghost": a half-depth device on the other side.
export function visibleFace(device: DeviceData, rack?: RackData): Face | "ghost" {
  const face = rack?.face || "front";
  const depth = device.depth || "full";
  if (depth !== "full" && depth !== face && !zeroU(device)) return "ghost";
  return zeroU(device) ? "rear" : face;
}
export const labelWidth = (w: number, ports: number) => (ports ? Math.min(92, Math.round(w * 0.34)) : w);
// Ports of the shown side as boxes on the device; ports of the other side
// are not visible and anchor at the device's right edge.
export function portLayout(item: WhiteboardItem, items?: Map<string, WhiteboardItem>): PortBox[] {
  const device = deviceOf(item);
  if (!device) return [];
  const rackItem = item.rackId ? items?.get(item.rackId) : undefined;
  const rack = rackItem ? rackOf(rackItem) || undefined : undefined;
  const face = visibleFace(device, rack);
  const shown = face === "ghost" ? [] : device.ports.filter((p) => zeroU(device) || p.face === face);
  const hidden = device.ports.filter((p) => !shown.includes(p));
  const out: PortBox[] = hidden.map((port) => ({ port, x: item.x + item.w - 1, y: item.y + item.h / 2 - 1, w: 2, h: 2, visible: false }));
  if (!shown.length) return out;
  const vertical = zeroU(device);
  const pad = 3;
  const left = vertical ? 1 : labelWidth(item.w, shown.length) + 6;
  const areaW = item.w - left - (vertical ? 1 : pad + 4),
    areaH = item.h - pad * 2 - (vertical ? 12 : 0);
  const top = item.y + pad + (vertical ? 12 : 0);
  // Ports of one type in a row form a block; blocks have a gap between them.
  const blocks: RackPort[][] = [];
  for (const p of shown) {
    const last = blocks[blocks.length - 1];
    if (last && portCategory(last[0].type) === portCategory(p.type) && (last[0].type === p.type || portCategory(p.type) !== "fibre")) last.push(p);
    else blocks.push([p]);
  }
  let best = { rows: 1, cell: 0 };
  const maxRows = Math.max(1, vertical ? shown.length : Math.floor(areaH / 7));
  for (let rows = 1; rows <= maxRows; rows++) {
    const cols = blocks.reduce((n, b) => n + Math.ceil(b.length / rows), 0) + (blocks.length - 1) * 0.6;
    const cell = Math.min(areaW / cols, areaH / rows, 15);
    if (cell > best.cell) best = { rows, cell };
  }
  const { rows, cell } = best;
  const usedH = rows * cell;
  let col = 0;
  for (const block of blocks) {
    block.forEach((port, i) => {
      const c = col + Math.floor(i / rows),
        r = i % rows;
      const category = portCategory(port.type);
      const w = cell * (category === "fibre" ? 0.9 : 0.78),
        h = cell * (category === "fibre" ? 0.52 : category === "power" ? 0.74 : 0.7);
      const cx = item.x + left + c * cell + cell / 2,
        cy = top + (areaH - usedH) / 2 + r * cell + cell / 2;
      out.push({ port, x: cx - w / 2, y: cy - h / 2, w, h, visible: true });
    });
    col += Math.ceil(block.length / rows) + 0.6;
  }
  return out;
}
export function portAnchor(item: WhiteboardItem, portId: string, items?: Map<string, WhiteboardItem>): Point | null {
  const box = portLayout(item, items).find((b) => b.port.id === portId);
  return box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : null;
}
// The visible port under a point (with a little tolerance), or null.
export function portAt(item: WhiteboardItem, p: Point, items?: Map<string, WhiteboardItem>, tolerance = 2) {
  let best: { id: string; d: number } | null = null;
  for (const b of portLayout(item, items)) {
    if (!b.visible) continue;
    if (p.x < b.x - tolerance || p.x > b.x + b.w + tolerance || p.y < b.y - tolerance || p.y > b.y + b.h + tolerance) continue;
    const d = Math.hypot(p.x - (b.x + b.w / 2), p.y - (b.y + b.h / 2));
    if (!best || d < best.d) best = { id: b.port.id, d };
  }
  return best?.id ?? null;
}
// Port ids for new ports of a device.
export function newPortId(ports: RackPort[]) {
  let n = ports.length + 1;
  const ids = new Set(ports.map((p) => p.id));
  while (ids.has(`p${n}`)) n++;
  return `p${n}`;
}
export function addPorts(ports: RackPort[], count: number, type: PortType, face: Face, prefix = "", start = 1): RackPort[] {
  const next = [...ports];
  for (let i = 0; i < count && next.length < MAX_PORTS; i++) next.push({ id: newPortId(next), name: `${prefix}${start + i}`, type, face });
  return next;
}

// ---- cables ----

export type CableEnd = { device: WhiteboardItem; port: RackPort | null };
export type ResolvedCable = { item: WhiteboardItem; cable: CableData; a: CableEnd | null; b: CableEnd | null };
const endOf = (end: ConnectorEnd | undefined, map: Map<string, WhiteboardItem>): CableEnd | null => {
  const device = end?.id ? map.get(end.id) : undefined;
  if (!device || device.type !== "device") return null;
  return { device, port: (end?.port && deviceOf(device)!.ports.find((p) => p.id === end.port)) || null };
};
// Connectors that are cables (they have cable data or sit on a port).
export const isCable = (item: WhiteboardItem) => item.type === "connector" && (!!item.cable || !!item.from?.port || !!item.to?.port);
export function resolveCables(items: WhiteboardItem[], map = new Map(items.map((i) => [i.id, i]))): ResolvedCable[] {
  return items
    .filter(isCable)
    .map((item) => ({ item, cable: cleanCable(item.cable) || { type: "other" as CableType }, a: endOf(item.from, map), b: endOf(item.to, map) }));
}
const portKey = (deviceId: string, portId: string) => `${deviceId}:${portId}`;
// Which cables sit on each port ("device:port" → cable ids).
export function portConnections(items: WhiteboardItem[]) {
  const out = new Map<string, string[]>();
  for (const c of resolveCables(items))
    for (const end of [c.a, c.b])
      if (end?.port) {
        const key = portKey(end.device.id, end.port.id);
        out.set(key, [...(out.get(key) || []), c.item.id]);
      }
  return out;
}
// Ports with more than one cable and cables with a loose end.
export function cableIssues(items: WhiteboardItem[]) {
  const doubled = [...portConnections(items)].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, ids }));
  const loose = resolveCables(items)
    .filter((c) => !c.a?.port || !c.b?.port)
    .map((c) => c.item.id);
  return { doubled, loose };
}
// A cable between two ports: what to add to the board.
export function cableDraft(a: { device: string; port: string; at: Point }, b: { device: string; port: string; at: Point }, cable: CableData): Omit<WhiteboardItem, "id" | "z"> {
  return {
    type: "connector",
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    from: { id: a.device, port: a.port, x: Math.round(a.at.x), y: Math.round(a.at.y) },
    to: { id: b.device, port: b.port, x: Math.round(b.at.x), y: Math.round(b.at.y) },
    endArrow: false,
    cable,
  };
}
// Cables run like in a tidy rack: from the port to the nearer edge of its
// device, along the gap between devices to the rack's side channel, up or
// down, over the top of the racks to another rack, and back the same way.
// Every cable has its own lane, so parallel cables stay apart.
export function cableRoute(item: WhiteboardItem, items: Map<string, WhiteboardItem>, a: Point, b: Point): string | null {
  const da = item.from?.id ? items.get(item.from.id) : undefined,
    db = item.to?.id ? items.get(item.to.id) : undefined;
  const ra = da?.type === "device" && da.rackId ? items.get(da.rackId) : undefined,
    rb = db?.type === "device" && db.rackId ? items.get(db.rackId) : undefined;
  if (!da || !db || !ra || !rb || ra.type !== "rack" || rb.type !== "rack") return null;
  const lane = [...item.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % 5;
  const channel = (rack: WhiteboardItem, right: boolean) => (right ? rack.x + rack.w - RACK_SIDE + 3 + lane * 3 : rack.x + 3 + lane * 3);
  // The edge of the device nearer to the port (0U devices: their side).
  const edge = (d: WhiteboardItem, p: Point) => (p.y - d.y <= d.y + d.h - p.y ? d.y + 0.8 + lane * 0.5 : d.y + d.h - 0.8 - lane * 0.5);
  const f = (n: number) => Math.round(n * 10) / 10;
  const ya = edge(da, a),
    yb = edge(db, b);
  if (ra.id === rb.id) {
    // Ports facing each other across free space (stacked devices, or one
    // device): the cable goes straight across instead of out to the side
    // channel and back, where it would cross itself.
    const across = directGap(da, db, a, b, ra.id, items, lane);
    if (across !== null) return `M ${f(a.x)} ${f(a.y)} V ${f(across)} H ${f(b.x)} V ${f(b.y)}`;
    const x = channel(ra, (a.x + b.x) / 2 >= ra.x + ra.w / 2);
    return `M ${f(a.x)} ${f(a.y)} V ${f(ya)} H ${f(x)} V ${f(yb)} H ${f(b.x)} V ${f(b.y)}`;
  }
  const right = rb.x + rb.w / 2 > ra.x + ra.w / 2;
  const xa = channel(ra, right),
    xb = channel(rb, !right);
  const top = Math.min(ra.y, rb.y) - 8 - lane * 4;
  return `M ${f(a.x)} ${f(a.y)} V ${f(ya)} H ${f(xa)} V ${f(top)} H ${f(xb)} V ${f(yb)} H ${f(b.x)} V ${f(b.y)}`;
}

// The height of a straight run between two ports of one rack, or null: both
// ports lie on the edges of their devices that face each other (the lower
// edge of the upper device, the upper edge of the lower one; on one device
// the same edge), and no other device sits in between where the cable runs.
function directGap(da: WhiteboardItem, db: WhiteboardItem, a: Point, b: Point, rackId: string, items: Map<string, WhiteboardItem>, lane: number): number | null {
  const near = (d: WhiteboardItem, p: Point) => (p.y - d.y <= d.y + d.h - p.y ? "top" : "bottom");
  const ea = near(da, a),
    eb = near(db, b);
  let from: number, to: number;
  if (da.id === db.id) {
    if (ea !== eb) return null;
    from = to = ea === "top" ? da.y : da.y + da.h;
  } else {
    const [upper, lower, eu, el] = da.y <= db.y ? [da, db, ea, eb] : [db, da, eb, ea];
    if (eu !== "bottom" || el !== "top" || upper.y + upper.h > lower.y + 0.5) return null;
    from = upper.y + upper.h;
    to = lower.y;
  }
  const left = Math.min(a.x, b.x),
    right = Math.max(a.x, b.x);
  for (const d of items.values()) {
    if (d.type !== "device" || d.rackId !== rackId || d.id === da.id || d.id === db.id) continue;
    if (d.y < to - 0.5 && d.y + d.h > from + 0.5 && d.x < right && d.x + d.w > left) return null;
  }
  // Along the gap, each cable in its own lane (from − 2 … + 2 px around the middle).
  return (from + to) / 2 + (lane - 2) * 0.8;
}

// ---- power and weight ----

export type RackTotals = { rackId: string; powerW: number; weightKg: number; units: number; maxPowerW?: number; maxWeightKg?: number; overPower: boolean; overWeight: boolean };
export type SourceLoad = { deviceId: string; loadW: number; maxPowerW?: number; over: boolean };
const isSource = (d: DeviceData) => d.kind === "pdu" || d.kind === "ups";
// Power drawn from each PDU and UPS: a device fed by several of them (two
// power supplies) shares its draw between them; a PDU fed by a UPS adds
// its whole load to the UPS.
export function sourceLoads(items: WhiteboardItem[]): Map<string, SourceLoad> {
  const map = new Map(items.map((i) => [i.id, i]));
  const cables = resolveCables(items, map);
  // device id → sources feeding it
  const feeds = new Map<string, Set<string>>();
  for (const c of cables) {
    if (!c.a || !c.b) continue;
    const pa = c.a.port,
      pb = c.b.port;
    if (c.cable.type !== "power" && !(pa && portCategory(pa.type) === "power") && !(pb && portCategory(pb.type) === "power")) continue;
    for (const [from, to] of [
      [c.a, c.b],
      [c.b, c.a],
    ] as const) {
      const source = deviceOf(from.device)!;
      if (!isSource(source) || from.device.id === to.device.id) continue;
      // An outlet of the source feeds the other side (inlets c14/c20 are inputs).
      if (from.port && ["c14", "c20"].includes(from.port.type)) continue;
      feeds.set(to.device.id, new Set([...(feeds.get(to.device.id) || []), from.device.id]));
    }
  }
  const loads = new Map<string, number>();
  const load = (id: string, seen: Set<string>): number => {
    if (loads.has(id)) return loads.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    let total = 0;
    for (const [fed, sources] of feeds) {
      if (!sources.has(id)) continue;
      const device = map.get(fed);
      const data = device ? deviceOf(device) : null;
      if (!data) continue;
      const own = (data.powerW || 0) + (isSource(data) ? load(fed, seen) : 0);
      total += own / sources.size;
    }
    loads.set(id, total);
    return total;
  };
  const out = new Map<string, SourceLoad>();
  for (const d of devicesIn(items)) {
    const data = deviceOf(d)!;
    if (!isSource(data)) continue;
    const loadW = Math.round(load(d.id, new Set()) * 10) / 10;
    out.set(d.id, { deviceId: d.id, loadW, maxPowerW: data.maxPowerW, over: !!data.maxPowerW && loadW > data.maxPowerW });
  }
  return out;
}
export function rackTotals(items: WhiteboardItem[]): Map<string, RackTotals> {
  const out = new Map<string, RackTotals>();
  for (const r of racksIn(items)) {
    const data = rackOf(r)!;
    let powerW = 0,
      weightKg = 0;
    for (const d of devicesIn(items, r.id)) {
      const dev = deviceOf(d)!;
      powerW += dev.powerW || 0;
      weightKg += dev.weightKg || 0;
    }
    powerW = Math.round(powerW * 10) / 10;
    weightKg = Math.round(weightKg * 10) / 10;
    out.set(r.id, {
      rackId: r.id,
      powerW,
      weightKg,
      units: usedUnits(items, r.id),
      maxPowerW: data.maxPowerW,
      maxWeightKg: data.maxWeightKg,
      overPower: !!data.maxPowerW && powerW > data.maxPowerW,
      overWeight: !!data.maxWeightKg && weightKg > data.maxWeightKg,
    });
  }
  return out;
}
export const formatPower = (w: number) => (w >= 1000 ? `${(Math.round(w / 100) / 10).toLocaleString("en")} kW` : `${Math.round(w)} W`);
export const formatWeight = (kg: number) => `${Math.round(kg * 10) / 10} kg`;

// ---- port overview and cable list ----

type T = (de: string, en: string) => string;
export type PortRow = {
  deviceId: string;
  device: string;
  rack: string;
  portId: string;
  port: string;
  type: PortType;
  category: PortCategory;
  face: Face;
  label: string;
  connectedTo: string;
  cableId: string;
  cable: string;
  vlan: string;
};
export type CableRow = {
  id: string;
  label: string;
  type: CableType;
  color: string;
  length: number | null;
  from: string;
  to: string;
  vlan: string;
  notes: string;
};
export const deviceName = (item: WhiteboardItem, t: T) => (item.text || "").trim() || t("Gerät", "Device");
export const rackName = (item: WhiteboardItem, t: T) => (item.text || "").trim() || "Rack";
const endName = (end: CableEnd | null, t: T) => (end ? `${deviceName(end.device, t)}${end.port ? ` · ${end.port.name}` : ""}` : "–");
export function cableRows(items: WhiteboardItem[], t: T): CableRow[] {
  return resolveCables(items).map((c) => ({
    id: c.item.id,
    label: c.cable.label || "",
    type: c.cable.type,
    color: cableStyle(c.cable).color,
    length: c.cable.length ?? null,
    from: endName(c.a, t),
    to: endName(c.b, t),
    vlan: c.cable.vlan || "",
    notes: c.cable.notes || "",
  }));
}
export function portRows(items: WhiteboardItem[], t: T): PortRow[] {
  const map = new Map(items.map((i) => [i.id, i]));
  const cables = new Map(resolveCables(items, map).map((c) => [c.item.id, c]));
  const connections = portConnections(items);
  const rows: PortRow[] = [];
  for (const d of devicesIn(items)) {
    const data = deviceOf(d)!;
    const rack = d.rackId ? map.get(d.rackId) : undefined;
    for (const port of data.ports) {
      const ids = connections.get(portKey(d.id, port.id)) || [];
      const cable = ids.length ? cables.get(ids[0]) : undefined;
      const other = cable ? (cable.a?.device.id === d.id && cable.a?.port?.id === port.id ? cable.b : cable.a) : null;
      rows.push({
        deviceId: d.id,
        device: deviceName(d, t),
        rack: rack ? rackName(rack, t) : "",
        portId: port.id,
        port: port.name,
        type: port.type,
        category: portCategory(port.type),
        face: port.face,
        label: port.label || "",
        connectedTo: cable ? endName(other || null, t) + (ids.length > 1 ? ` (+${ids.length - 1})` : "") : "",
        cableId: cable?.item.id || "",
        cable: cable ? cable.cable.label || cableTypeNames[cable.cable.type] : "",
        vlan: port.vlan || cable?.cable.vlan || "",
      });
    }
  }
  return rows;
}
// A CSV cell: quoted when needed; text that a spreadsheet would run as a
// formula gets a leading apostrophe.
export const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? "" : String(value);
  if (CSV_FORMULA.test(text)) text = `'${text}`;
  return /[",;\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
export function cablesCsv(rows: CableRow[], t: T) {
  const head = [t("Beschriftung", "Label"), t("Typ", "Type"), t("Farbe", "Colour"), t("Länge (m)", "Length (m)"), t("Von", "From"), t("Nach", "To"), "VLAN", t("Notizen", "Notes")];
  const lines = rows.map((r) => [r.label, cableTypeNames[r.type], r.color, r.length ?? "", r.from, r.to, r.vlan, r.notes].map(csvCell).join(","));
  return [head.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
}
export function portsCsv(rows: PortRow[], t: T) {
  const head = ["Rack", t("Gerät", "Device"), "Port", t("Typ", "Type"), t("Seite", "Side"), t("Bezeichnung", "Label"), t("Verbunden mit", "Connected to"), t("Kabel", "Cable"), "VLAN"];
  const lines = rows.map((r) => [r.rack, r.device, r.port, portTypeNames[r.type], r.face === "front" ? t("Vorne", "Front") : t("Hinten", "Rear"), r.label, r.connectedTo, r.cable, r.vlan].map(csvCell).join(","));
  return [head.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
}

// ---- JSON export and import of rack elements ----

export const RACK_JSON_FORMAT = "flowplan-racks";
type JsonItem = Omit<WhiteboardItem, "z"> & { z?: number };
// The racks (all, or the chosen ones), their devices and the cables
// between them, positions relative to the first rack.
export function racksJson(items: WhiteboardItem[], chosen?: Set<string>) {
  const racks = racksIn(items).filter((r) => !chosen || chosen.has(r.id) || devicesIn(items, r.id).some((d) => chosen.has(d.id)));
  const rackIds = new Set(racks.map((r) => r.id));
  const devices = devicesIn(items).filter((d) => (d.rackId && rackIds.has(d.rackId)) || (!d.rackId && (!chosen || chosen.has(d.id))));
  const deviceIds = new Set(devices.map((d) => d.id));
  const cables = resolveCables(items).filter((c) => c.a && c.b && deviceIds.has(c.a.device.id) && deviceIds.has(c.b.device.id));
  const placed = [...racks, ...devices];
  const ox = placed.length ? Math.min(...placed.map((i) => i.x)) : 0,
    oy = placed.length ? Math.min(...placed.map((i) => i.y)) : 0;
  const at = (n: number, o: number) => Math.round(n - o);
  return {
    format: RACK_JSON_FORMAT,
    version: 1,
    racks: racks.map((r) => ({ id: r.id, name: r.text || "", x: at(r.x, ox), y: at(r.y, oy), ...rackOf(r)! })),
    devices: devices.map((d) => ({
      id: d.id,
      name: d.text || "",
      color: d.fill,
      rack: d.rackId,
      u: d.u,
      ...(d.rackId ? {} : { x: at(d.x, ox), y: at(d.y, oy) }),
      ...deviceOf(d)!,
    })),
    cables: cables.map((c) => ({ id: c.item.id, a: { device: c.a!.device.id, port: c.item.from?.port }, b: { device: c.b!.device.id, port: c.item.to?.port }, ...c.cable })),
  };
}
export class RackJsonError extends Error {}
// A file of racksJson (or of the NetBox import) as board drafts with local
// ids; everything is checked like board data.
export function parseRacksJson(text: string | unknown) {
  let raw: unknown = text;
  if (typeof text === "string") {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new RackJsonError("json");
    }
  }
  const data = raw as { format?: unknown; racks?: unknown; devices?: unknown; cables?: unknown };
  if (!data || typeof data !== "object" || data.format !== RACK_JSON_FORMAT) throw new RackJsonError("format");
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []) as Record<string, unknown>[];
  const drafts: JsonItem[] = [];
  const ids = new Map<string, string>();
  const local = (prefix: string, raw: unknown) => {
    const key = `${prefix}:${String(raw)}`;
    if (!ids.has(key)) ids.set(key, `${prefix}${ids.size + 1}`);
    return ids.get(key)!;
  };
  let x = 0;
  for (const r of list(data.racks, 200)) {
    const rack = cleanRack(r)!;
    const size = rackSize(rack);
    const px = num(r.x, -1e6, 1e6),
      py = num(r.y, -1e6, 1e6);
    drafts.push({ id: local("r", r.id), type: "rack", x: px ?? x, y: py ?? 0, ...size, text: str(r.name, 200) || "Rack", rack });
    x = (px ?? x) + size.w + 60;
  }
  const deviceIds = new Set<string>();
  let fx = x;
  for (const d of list(data.devices, 5000)) {
    const device = cleanDevice(d)!;
    const rackId = d.rack !== undefined && d.rack !== null ? ids.get(`r:${String(d.rack)}`) : undefined;
    const id = local("d", d.id);
    deviceIds.add(id);
    const px = num(d.x, -1e6, 1e6),
      py = num(d.y, -1e6, 1e6);
    drafts.push({
      id,
      type: "device",
      x: px ?? fx,
      y: py ?? 0,
      w: innerWidth(19),
      h: device.height * RACK_U,
      text: str(d.name, 200) || "",
      ...(typeof d.color === "string" && COLOR.test(d.color) ? { fill: d.color } : {}),
      ...(rackId ? { rackId, u: int(d.u, 1, RACK_MAX_U) ?? 1 } : {}),
      device,
    });
    if (!rackId && px === undefined) fx += innerWidth(19) + 40;
  }
  for (const c of list(data.cables, 20000)) {
    const a = (c.a || {}) as Record<string, unknown>,
      b = (c.b || {}) as Record<string, unknown>;
    const da = ids.get(`d:${String(a.device)}`),
      db = ids.get(`d:${String(b.device)}`);
    if (!da || !db || !deviceIds.has(da) || !deviceIds.has(db)) continue;
    const pa = typeof a.port === "string" && ID.test(a.port) ? a.port : undefined,
      pb = typeof b.port === "string" && ID.test(b.port) ? b.port : undefined;
    drafts.push({
      id: local("c", c.id),
      type: "connector",
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      from: { id: da, x: 0, y: 0, ...(pa ? { port: pa } : {}) },
      to: { id: db, x: 0, y: 0, ...(pb ? { port: pb } : {}) },
      endArrow: false,
      cable: cleanCable(c)!,
    });
  }
  if (!drafts.length) throw new RackJsonError("empty");
  return drafts;
}
// Connector ends of drafts lie where their ports are once laid out, so the
// drafts' bounds (and where they are placed) come out right.
export function settleCableEnds<D extends JsonItem>(drafts: D[]): D[] {
  const laid = applyRackLayout(drafts.map((d) => ({ z: 0, ...d }) as WhiteboardItem));
  const map = new Map(laid.map((i) => [i.id, i]));
  return drafts.map((d) => {
    if (d.type !== "connector") return d;
    const out = { ...d };
    for (const end of ["from", "to"] as const) {
      const e = d[end];
      const device = e?.id ? map.get(e.id) : undefined;
      if (!e || !device) continue;
      const p = (e.port && portAnchor(device, e.port, map)) || { x: device.x + device.w / 2, y: device.y + device.h / 2 };
      out[end] = { ...e, x: Math.round(p.x), y: Math.round(p.y) };
    }
    return out;
  });
}

// ---- copies ----

// Copies keep their rack when it was copied along; a device copied alone
// goes to the next free place of its rack (or next to it when full).
export function remapRack<T extends Partial<WhiteboardItem>>(item: T, ids: Map<string, string>, items: WhiteboardItem[], taken: WhiteboardItem[] = []): T {
  if (item.type !== "device" || !item.rackId) return item;
  const mapped = ids.get(item.rackId);
  if (mapped) return { ...item, rackId: mapped };
  const device = cleanDevice(item.device);
  const all = [...items, ...taken];
  const u = device ? firstFreeU(all, item.rackId, device) : null;
  if (u) return { ...item, u };
  const rack = items.find((i) => i.id === item.rackId);
  return { ...item, rackId: undefined, u: undefined, x: (rack ? rack.x + rack.w : item.x || 0) + 40, y: rack ? rack.y + RACK_HEADER : item.y };
}

// ---- text (search, AI, Markdown) ----

export function rackItemText(item: Partial<WhiteboardItem>): string[] {
  if (item.type === "rack") {
    const r = cleanRack(item.rack);
    return [r?.location].filter(Boolean) as string[];
  }
  if (item.type === "device") {
    const d = cleanDevice(item.device);
    if (!d) return [];
    return [d.manufacturer, d.model, d.serial, ...d.ports.flatMap((p) => [p.label, p.vlan])].filter(Boolean) as string[];
  }
  const c = item.type === "connector" ? cleanCable(item.cable) : null;
  return c ? ([c.label, c.vlan].filter(Boolean) as string[]) : [];
}
export const hasRacks = (items: WhiteboardItem[]) => items.some((i) => i.type === "rack" || i.type === "device");
// Racks, devices, ports and cables as plain text (AI sources).
export function racksText(items: WhiteboardItem[], t: T) {
  if (!hasRacks(items)) return "";
  const laid = applyRackLayout(items);
  const totals = rackTotals(laid);
  const lines: string[] = [];
  const describe = (d: WhiteboardItem) => {
    const data = deviceOf(d)!;
    const units = deviceUnits(d);
    const where = units ? (zeroU(data) ? `0U ${data.mount}` : units.from === units.to ? `U${units.from}` : `U${units.from}–${units.to}`) : "";
    return `- ${deviceName(d, t)}${where ? ` (${where})` : ""}: ${t(...deviceKindNames[data.kind])}${data.model ? `, ${[data.manufacturer, data.model].filter(Boolean).join(" ")}` : ""}${data.powerW ? `, ${data.powerW} W` : ""}${data.weightKg ? `, ${data.weightKg} kg` : ""}${data.ports.length ? `, ${t("Ports", "ports")}: ${data.ports.map((p) => `${p.name} ${portTypeNames[p.type]}${p.label ? ` "${p.label}"` : ""}`).join(", ")}` : ""}`;
  };
  for (const r of racksIn(laid)) {
    const data = rackOf(r)!,
      total = totals.get(r.id)!;
    lines.push(`Rack ${rackName(r, t)} (${data.u}U, ${data.width}″${data.location ? `, ${data.location}` : ""}; ${total.units}/${data.u}U, ${formatPower(total.powerW)}, ${formatWeight(total.weightKg)})`);
    for (const d of devicesIn(laid, r.id).sort((a, b) => (b.u || 0) - (a.u || 0))) lines.push(describe(d));
  }
  const loose = devicesIn(laid).filter((d) => !d.rackId);
  if (loose.length) {
    lines.push(t("Geräte außerhalb von Racks", "Devices outside racks"));
    for (const d of loose) lines.push(describe(d));
  }
  const cables = cableRows(laid, t);
  if (cables.length) {
    lines.push(t("Kabel", "Cables"));
    for (const c of cables) lines.push(`- ${c.label ? `${c.label}: ` : ""}${c.from} → ${c.to} (${cableTypeNames[c.type]}${c.length !== null ? `, ${c.length} m` : ""}${c.vlan ? `, VLAN ${c.vlan}` : ""})`);
  }
  return lines.join("\n");
}

// Racks, devices, port assignments and the cable list as Markdown tables
// (Markdown export, read_page in MCP). `esc` escapes a table cell's text.
export function racksMarkdown(items: WhiteboardItem[], t: T, esc: (text: string) => string) {
  if (!hasRacks(items)) return "";
  const laid = applyRackLayout(items);
  const cell = (v: unknown) => esc(String(v ?? "").replace(/\s+/g, " ").trim()) || " ";
  const table = (head: string[], rows: unknown[][]) =>
    [`| ${head.map(cell).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
  const totals = rackTotals(laid);
  const out: string[] = [];
  const kind = (d: DeviceData) => t(...deviceKindNames[d.kind]);
  const deviceRows = (list: WhiteboardItem[]) =>
    list.map((d) => {
      const data = deviceOf(d)!,
        units = deviceUnits(d);
      const where = units ? (zeroU(data) ? `0U (${data.mount === "left" ? t("links", "left") : t("rechts", "right")})` : units.from === units.to ? `U${units.from}` : `U${units.from}–${units.to}`) : "";
      return [where, deviceName(d, t), kind(data), [data.manufacturer, data.model].filter(Boolean).join(" "), data.powerW ? formatPower(data.powerW) : "", data.weightKg ? formatWeight(data.weightKg) : ""];
    });
  const head = ["U", t("Gerät", "Device"), t("Art", "Kind"), t("Modell", "Model"), t("Leistung", "Power"), t("Gewicht", "Weight")];
  for (const r of racksIn(laid)) {
    const data = rackOf(r)!,
      total = totals.get(r.id)!;
    out.push(`### ${esc(rackName(r, t))}`);
    out.push(
      esc(
        [`${data.u}U, ${data.width}″`, data.location, `${total.units}/${data.u}U ${t("belegt", "used")}`, `${formatPower(total.powerW)}${data.maxPowerW ? ` / ${formatPower(data.maxPowerW)}` : ""}`, `${formatWeight(total.weightKg)}${data.maxWeightKg ? ` / ${formatWeight(data.maxWeightKg)}` : ""}`]
          .filter(Boolean)
          .join(" · "),
      ) + (total.overPower || total.overWeight ? ` — **${esc(t("Grenze überschritten", "Limit exceeded"))}**` : ""),
    );
    const list = devicesIn(laid, r.id).sort((a, b) => (b.u || 0) - (a.u || 0));
    if (list.length) out.push(table(head, deviceRows(list)));
  }
  const loose = devicesIn(laid).filter((d) => !d.rackId);
  if (loose.length) out.push(`### ${esc(t("Geräte außerhalb von Racks", "Devices outside racks"))}`, table(head, deviceRows(loose)));
  const ports = portRows(laid, t).filter((p) => p.connectedTo || p.label || p.vlan);
  if (ports.length)
    out.push(
      `### ${esc(t("Portbelegung", "Port assignments"))}`,
      table([t("Gerät", "Device"), "Port", t("Typ", "Type"), t("Verbunden mit", "Connected to"), t("Kabel", "Cable"), "VLAN"], ports.map((p) => [p.device, p.port + (p.label ? ` (${p.label})` : ""), portTypeNames[p.type], p.connectedTo, p.cable, p.vlan])),
    );
  const cables = cableRows(laid, t);
  if (cables.length)
    out.push(
      `### ${esc(t("Kabelliste", "Cable list"))}`,
      table(
        [t("Beschriftung", "Label"), t("Typ", "Type"), t("Von", "From"), t("Nach", "To"), t("Länge", "Length"), t("Farbe", "Colour"), "VLAN", t("Notizen", "Notes")],
        cables.map((c) => [c.label, cableTypeNames[c.type], c.from, c.to, c.length !== null ? `${c.length} m` : "", c.color, c.vlan, c.notes]),
      ),
    );
  return out.join("\n\n") + "\n";
}

// Cable labels to print: one label per cable end (the label, where this end
// sits and where the other one goes), for adhesive label sheets.
export function cableLabelsHtml(rows: CableRow[], t: T, title: string, lang = "de") {
  const e = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const label = (r: CableRow, here: string, there: string) =>
    `<div class="label"><span class="bar" style="background:${COLOR.test(r.color) ? r.color : "#495057"}"></span><div><strong>${e(r.label || cableTypeNames[r.type])}</strong><span>${e(here)}</span><span>→ ${e(there)}</span><small>${e(
      [cableTypeNames[r.type], r.length !== null ? `${r.length} m` : "", r.vlan ? `VLAN ${r.vlan}` : ""].filter(Boolean).join(" · "),
    )}</small></div></div>`;
  return `<!doctype html><html lang="${e(lang)}"><head><meta charset="utf-8"><title>${e(title)}</title><style>
@page{margin:10mm}body{font:12px system-ui,-apple-system,'Segoe UI',sans-serif;color:#111;margin:0}
h1{font-size:14px;margin:0 0 6mm}.sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm}
.label{display:flex;gap:2mm;border:1px dashed #999;border-radius:2mm;padding:2mm;break-inside:avoid;min-height:16mm}
.bar{width:3mm;border-radius:1mm;flex:none}.label div{display:flex;flex-direction:column;gap:0.5mm;min-width:0}
.label strong{font-size:13px}.label span,.label small{overflow-wrap:anywhere}.label small{color:#555}
</style></head><body><h1>${e(title)} · ${e(t("Kabeletiketten", "Cable labels"))}</h1><div class="sheet">${rows.map((r) => label(r, r.from, r.to) + label(r, r.to, r.from)).join("")}</div></body></html>`;
}
