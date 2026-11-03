// Drawings of racks and devices (#90) as SVG markup, relative to the
// element's top left corner. The board puts it into the element
// (components/whiteboard/render.tsx), the SVG export and the Markdown export
// write it as it is (lib/whiteboard-svg.ts), so all three look alike.
// Every value is checked (lib/whiteboard-rack.ts) and every text escaped.
import type { WhiteboardItem } from "./whiteboard-model";
import {
  RACK_FOOTER,
  RACK_HEADER,
  RACK_RAIL,
  RACK_SIDE,
  RACK_U,
  cableStyle,
  deviceOf,
  formatPower,
  formatWeight,
  innerWidth,
  labelWidth,
  portCategory,
  portLayout,
  portTypeNames,
  rackCollisions,
  rackOf,
  rackSize,
  rackTotals,
  resolveCables,
  sourceLoads,
  visibleFace,
  zeroU,
  type DeviceKind,
  type RackTotals,
  type SourceLoad,
} from "./whiteboard-rack";

type T = (de: string, en: string) => string;
const esc = (value: string) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const f = (n: number) => Math.round(n * 10) / 10;
const FONT = "system-ui,-apple-system,'Segoe UI',sans-serif";

// What the drawings need to know about the whole board, worked out once
// per board state.
export type RackContext = {
  totals: Map<string, RackTotals>;
  collisions: Set<string>;
  loads: Map<string, SourceLoad>;
  // "device:port" → colour of the cable on it
  ports: Map<string, string>;
};
const contexts = new WeakMap<object, RackContext>();
export function rackContext(items: Map<string, WhiteboardItem> | WhiteboardItem[]): RackContext {
  const cached = contexts.get(items);
  if (cached) return cached;
  const list = Array.isArray(items) ? items : [...items.values()];
  const ports = new Map<string, string>();
  for (const c of resolveCables(list))
    for (const end of [c.a, c.b]) if (end?.port) ports.set(`${end.device.id}:${end.port.id}`, cableStyle(c.cable).color);
  const context = { totals: rackTotals(list), collisions: rackCollisions(list), loads: sourceLoads(list), ports };
  contexts.set(items, context);
  return context;
}

export const deviceColors: Record<DeviceKind, string> = {
  server: "#3b5bdb",
  switch: "#0c8599",
  patch: "#5c636a",
  router: "#e8590c",
  firewall: "#c92a2a",
  storage: "#6741d9",
  ups: "#2b8a3e",
  pdu: "#495057",
  blank: "#2b3035",
  cable: "#3d4349",
  shelf: "#868e96",
  other: "#5f6b7a",
};
const COLOR = /^#[0-9a-f]{6}$/i;
export const deviceColor = (item: WhiteboardItem) => (item.fill && COLOR.test(item.fill) ? item.fill : deviceColors[deviceOf(item)?.kind || "other"]);
// Dark or light text, whichever reads better on the colour.
export function textOn(color: string) {
  const hex = COLOR.test(color) ? color.slice(1) : "5f6b7a";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? "#1f2328" : "#ffffff";
}

export function rackSvg(item: WhiteboardItem, context: RackContext, t: T) {
  const rack = rackOf(item);
  if (!rack) return "";
  const { w, h } = rackSize(rack);
  const inner = innerWidth(rack.width);
  const top = RACK_HEADER,
    bottom = RACK_HEADER + rack.u * RACK_U;
  const totals = context.totals.get(item.id);
  const face = rack.face || "front";
  const parts: string[] = [];
  parts.push(`<rect class="wb-rack-body" width="${w}" height="${h}" rx="7" fill="#2b3036" stroke="#14171a" stroke-width="1.5"/>`);
  // Side channels (cable management, 0U), rails with holes and numbers.
  parts.push(`<rect x="2" y="${top}" width="${RACK_SIDE - 2}" height="${rack.u * RACK_U}" fill="#22262b"/>`);
  parts.push(`<rect x="${w - RACK_SIDE}" y="${top}" width="${RACK_SIDE - 2}" height="${rack.u * RACK_U}" fill="#22262b"/>`);
  const railL = RACK_SIDE,
    railR = RACK_SIDE + RACK_RAIL + inner;
  parts.push(`<rect x="${railL}" y="${top}" width="${RACK_RAIL}" height="${rack.u * RACK_U}" fill="#3a4048"/>`);
  parts.push(`<rect x="${railR}" y="${top}" width="${RACK_RAIL}" height="${rack.u * RACK_U}" fill="#3a4048"/>`);
  parts.push(`<rect class="wb-rack-bay" x="${railL + RACK_RAIL}" y="${top}" width="${inner}" height="${rack.u * RACK_U}" fill="#16191d"/>`);
  const lines: string[] = [],
    numbers: string[] = [],
    holes: string[] = [];
  for (let u = 1; u <= rack.u; u++) {
    const y = top + (rack.u - u) * RACK_U;
    if (u < rack.u) lines.push(`M ${railL + RACK_RAIL} ${y} h ${inner}`);
    numbers.push(`<text x="${railL + RACK_RAIL - 5}" y="${f(y + RACK_U / 2 + 3)}" text-anchor="end">${u}</text>`);
    for (const hx of [railL + 5, railR + RACK_RAIL - 5]) for (const k of [0.25, 0.75]) holes.push(`M ${hx - 1.4} ${f(y + RACK_U * k)} h 2.8`);
  }
  if (lines.length) parts.push(`<path d="${lines.join(" ")}" stroke="#23272c" stroke-width="1"/>`);
  parts.push(`<path d="${holes.join(" ")}" stroke="#1d2125" stroke-width="2.4" stroke-linecap="round"/>`);
  parts.push(`<g font-family="${FONT}" font-size="9" fill="#9aa3ad">${numbers.join("")}</g>`);
  parts.push(`<rect x="2" y="${bottom}" width="${w - 4}" height="${RACK_FOOTER - 2}" rx="3" fill="#1f2328"/>`);
  // Header: name, place, side, totals and warnings.
  parts.push(`<path d="M 0 7 Q 0 0 7 0 H ${w - 7} Q ${w} 0 ${w} 7 V ${top} H 0 Z" fill="#1c1f23"/>`);
  const name = (item.text || "").trim() || "Rack";
  const badge = face === "front" ? t("VORNE", "FRONT") : t("HINTEN", "REAR");
  const badgeW = 8 + badge.length * 6.4;
  parts.push(`<rect class="wb-rack-face" x="${w - badgeW - 8}" y="7" width="${f(badgeW)}" height="15" rx="7.5" fill="${face === "front" ? "#364fc7" : "#862e9c"}"/>`);
  parts.push(`<text x="${f(w - badgeW / 2 - 8)}" y="17.8" text-anchor="middle" font-family="${FONT}" font-size="9.5" font-weight="700" letter-spacing="0.06em" fill="#ffffff">${esc(badge)}</text>`);
  parts.push(
    `<text x="9" y="18" font-family="${FONT}" font-size="13" font-weight="700" fill="#f1f3f5">${esc(name.length > 34 ? `${name.slice(0, 33)}…` : name)}<title>${esc(name)}</title></text>`,
  );
  if (totals) {
    const warn = "#ff8787";
    const power = `${formatPower(totals.powerW)}${totals.maxPowerW ? ` / ${formatPower(totals.maxPowerW)}` : ""}`;
    const weight = `${formatWeight(totals.weightKg)}${totals.maxWeightKg ? ` / ${formatWeight(totals.maxWeightKg)}` : ""}`;
    const place = rack.location ? `${rack.location} · ` : "";
    parts.push(
      `<text x="9" y="34" font-family="${FONT}" font-size="10" fill="#adb5bd">${esc(place)}${totals.units}/${rack.u} U · ${rack.width}″ · <tspan fill="${totals.overPower ? warn : "#adb5bd"}" font-weight="${totals.overPower ? 700 : 400}">${esc(power)}</tspan> · <tspan fill="${totals.overWeight ? warn : "#adb5bd"}" font-weight="${totals.overWeight ? 700 : 400}">${esc(weight)}</tspan></text>`,
    );
    if (totals.overPower || totals.overWeight)
      parts.push(
        `<g class="wb-rack-warning"><circle cx="${w - 16}" cy="31" r="7" fill="#e03131"/><text x="${w - 16}" y="34.5" text-anchor="middle" font-family="${FONT}" font-size="10" font-weight="800" fill="#ffffff">!</text><title>${esc(
          [totals.overPower ? t("Stromgrenze überschritten", "Power limit exceeded") : "", totals.overWeight ? t("Gewichtsgrenze überschritten", "Weight limit exceeded") : ""].filter(Boolean).join(" · "),
        )}</title></g>`,
      );
  }
  return parts.join("");
}

function portShape(x: number, y: number, w: number, h: number, type: string, cable: string | undefined) {
  const category = portCategory(type as never);
  const fill = cable || (category === "power" ? "#0d0f11" : category === "fibre" ? "#c3c9d0" : type === "console" || type === "usb" ? "#748ffc" : "#121417");
  const stroke = category === "fibre" ? "#6c757d" : "#8b949e";
  const rx = category === "power" ? Math.min(w, h) * 0.25 : 0.6;
  let inner = "";
  if (!cable && category === "fibre") inner = `<rect x="${f(x + w * 0.15)}" y="${f(y + h * 0.3)}" width="${f(w * 0.7)}" height="${f(h * 0.4)}" fill="#343a40"/>`;
  if (!cable && type === "rj45") inner = `<rect x="${f(x + w * 0.3)}" y="${f(y + h * 0.62)}" width="${f(w * 0.4)}" height="${f(h * 0.38)}" fill="#3b4148"/>`;
  return `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${f(rx)}" fill="${fill}" stroke="${stroke}" stroke-width="0.5"/>${inner}`;
}

export function deviceSvg(item: WhiteboardItem, items: Map<string, WhiteboardItem>, context: RackContext, t: T) {
  const device = deviceOf(item);
  if (!device) return "";
  const rackItem = item.rackId ? items.get(item.rackId) : undefined;
  const rack = rackItem ? rackOf(rackItem) || undefined : undefined;
  const face = visibleFace(device, rack);
  const { w, h } = item;
  const color = deviceColor(item);
  const ink = textOn(color);
  const name = (item.text || "").trim() || t("Gerät", "Device");
  const bad = context.collisions.has(item.id);
  const load = context.loads.get(item.id);
  const parts: string[] = [];
  const tip = [
    name,
    [device.manufacturer, device.model].filter(Boolean).join(" "),
    device.powerW ? formatPower(device.powerW) : "",
    device.weightKg ? formatWeight(device.weightKg) : "",
    load ? `${t("Last", "Load")} ${formatPower(load.loadW)}${load.maxPowerW ? ` / ${formatPower(load.maxPowerW)}` : ""}` : "",
    bad ? t("Überschneidung mit einem anderen Gerät", "Overlaps another device") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (face === "ghost") {
    // A half-depth device on the other side: its outline only.
    parts.push(`<rect class="wb-device-ghost" x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="2" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-dasharray="4 3"/>`);
    parts.push(
      `<text x="8" y="${f(h / 2 + 3.5)}" font-family="${FONT}" font-size="10" font-style="italic" fill="#adb5bd">${esc(name)} · ${esc(device.depth === "rear" ? t("hinten", "rear") : t("vorne", "front"))}</text>`,
    );
  } else {
    parts.push(`<rect class="wb-device-body" x="0" y="0" width="${w}" height="${h}" rx="2" fill="${color}" stroke="#0b0d0f" stroke-opacity="0.55"/>`);
    if (!zeroU(device)) {
      // Mounting ears.
      parts.push(`<rect x="0" y="0" width="4" height="${h}" fill="#000" fill-opacity="0.22"/><rect x="${w - 4}" y="0" width="4" height="${h}" fill="#000" fill-opacity="0.22"/>`);
      if (device.kind === "blank") parts.push(`<path d="${Array.from({ length: Math.floor(w / 8) }, (_, i) => `M ${8 + i * 8} 4 v ${h - 8}`).join(" ")}" stroke="#000" stroke-opacity="0.18"/>`);
      if (device.kind === "cable") parts.push(`<rect x="${w * 0.15}" y="${h * 0.3}" width="${w * 0.7}" height="${h * 0.4}" rx="3" fill="#000" fill-opacity="0.3"/>`);
      if (device.kind === "shelf") parts.push(`<rect x="4" y="${h - 4}" width="${w - 8}" height="3" fill="#000" fill-opacity="0.3"/>`);
      const ports = device.ports.filter((p) => p.face === face).length;
      const room = labelWidth(w, ports) - 8;
      const size = Math.min(11, h - 6);
      const chars = Math.max(3, Math.floor(room / (size * 0.56)));
      const label = name.length > chars ? `${name.slice(0, chars - 1)}…` : name;
      const sub = h >= RACK_U * 2 && device.model ? device.model : "";
      parts.push(
        `<text x="8" y="${f(sub ? h / 2 - 2 : h / 2 + size * 0.36)}" font-family="${FONT}" font-size="${size}" font-weight="600" fill="${ink}">${esc(label)}</text>` +
          (sub ? `<text x="8" y="${f(h / 2 + 10)}" font-family="${FONT}" font-size="9" fill="${ink}" fill-opacity="0.75">${esc(sub.slice(0, chars))}</text>` : ""),
      );
    }
    for (const box of portLayout(item, items)) {
      if (!box.visible) continue;
      const cable = context.ports.get(`${item.id}:${box.port.id}`);
      parts.push(
        `<g class="wb-rack-port" data-port="${esc(box.port.id)}">${portShape(box.x - item.x, box.y - item.y, box.w, box.h, box.port.type, cable)}<title>${esc(
          `${name} · ${box.port.name} · ${portTypeNames[box.port.type]}${box.port.label ? ` · ${box.port.label}` : ""}`,
        )}</title></g>`,
      );
    }
    if (load?.over) parts.push(`<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="2" fill="none" stroke="#ff6b6b" stroke-width="2"/>`);
  }
  if (bad)
    parts.push(
      `<g class="wb-device-collision"><rect x="0" y="0" width="${w}" height="${h}" rx="2" fill="url(#wb-rack-clash)" stroke="#fa5252" stroke-width="2"/><circle cx="${w - 9}" cy="${Math.min(9, h / 2)}" r="6.5" fill="#e03131"/><text x="${w - 9}" y="${f(Math.min(9, h / 2) + 3.4)}" text-anchor="middle" font-family="${FONT}" font-size="9.5" font-weight="800" fill="#fff">!</text></g>`,
    );
  parts.push(`<title>${esc(tip)}</title>`);
  return parts.join("");
}
// Pattern behind colliding devices (in every drawing's defs).
export const RACK_DEFS = `<pattern id="wb-rack-clash" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#e03131" fill-opacity="0.18"/><rect width="3" height="8" fill="#e03131" fill-opacity="0.38"/></pattern>`;
