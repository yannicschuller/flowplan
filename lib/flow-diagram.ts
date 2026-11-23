// Flow diagrams (Sankey, #427): amounts flowing from one node to the next,
// drawn left to right – nodes as bars, bands as wide as their amount.
//
// The source is plain text, one flow per line:
//
//   Hauptjob -> Budget: 2750
//   Budget → Fixkosten: 1.100,00
//   Fixkosten #f5c542
//
// "->", "→" or "=>" between the nodes, the amount after the last colon
// (comma or point as decimal separator, thousands separators allowed). A
// line "Name #colour" gives a node its colour. Lines starting with "//" are
// comments. Several lines for the same pair add up; cycles and negative
// amounts are refused line by line, the rest is still drawn.
//
// The layout is our own and small: columns by the longest path from a
// source, node heights by max(in, out), the order within a column improved
// by a few barycentre sweeps. The SVG is a string (escaped throughout, only
// presentation attributes – no style="", the CSP forbids it), used by the
// document block, read-only pages, the print export and the chart view.
import { LOCALE_TAG, tr } from "./locale-tag";

export const MAX_FLOW_SOURCE = 10_000;
export const MAX_FLOW_UNIT = 16;
export const MAX_FLOWS = 200;
export const MAX_FLOW_NAME = 60;
export const FLOW_COLORS = ["#4f70d5", "#299287", "#d98a2b", "#8d62bb", "#c26373", "#51849b", "#8c853b", "#2f9e44", "#e0644f", "#1098ad"];
export const DEFAULT_FLOW = "Hauptjob -> Budget: 2750\nNebenjob -> Budget: 550\nBudget -> Fixkosten: 1100\nBudget -> Sparen: 1250\nBudget -> Konsum: 950";

type Translate = (de: string, en: string) => string;
export type Flow = { source: string; target: string; value: number };
export type FlowError = { line: number; message: string };
export type FlowGraph = { flows: Flow[]; colors: Record<string, string>; order: string[]; errors: FlowError[] };

// What a block may store: the source and the unit within their limits,
// without control characters (line breaks and tabs stay in the source).
export const cleanFlowSource = (value: unknown) =>
  String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .slice(0, MAX_FLOW_SOURCE);
export const cleanFlowUnit = (value: unknown) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_FLOW_UNIT);

// The unit in a ```flow fence's meta: unit=€, or unit="Mio. €" with spaces.
export function flowFenceMeta(unit: string) {
  const u = cleanFlowUnit(unit).replace(/["`]/g, "");
  return !u ? "" : /\s/.test(u) ? `unit="${u}"` : `unit=${u}`;
}
export function flowFenceUnit(meta: string) {
  const found = /(?:^|\s)unit=(?:"([^"]*)"|(\S+))/.exec(meta);
  return cleanFlowUnit(found ? (found[1] ?? found[2]) : "");
}
// Whether a ```flow fence is a flow diagram (and not code of the Flow
// language): at least one flow and every line understood.
export function isFlowSource(text: string) {
  const graph = parseFlow(text, (de) => de);
  return graph.flows.length > 0 && !graph.errors.length;
}

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const fullColor = (c: string) => (c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c).toLowerCase();

// "2750", "2.750,00", "2,750.50", "12,5", "1'000" → a number; null when it
// is none. One separator followed by exactly three digits groups thousands
// ("1.100" and "1,100" are 1100); "0,125" stays a fraction.
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[\s  ']/g, "").replace(/^(?:€|\$|£|¥|₹|₽|EUR|USD|CHF|GBP)|(?:€|\$|£|¥|₹|₽|EUR|USD|CHF|GBP)$/gi, "");
  const negative = /^[-−–]/.test(s);
  s = s.replace(/^[-−–+]/, "");
  if (!/^\d[\d.,]*$/.test(s) || /[.,]$/.test(s)) return null;
  const dot = s.lastIndexOf("."),
    comma = s.lastIndexOf(",");
  let whole = s,
    fraction = "";
  if (dot >= 0 && comma >= 0) {
    const at = Math.max(dot, comma);
    const grouping = at === dot ? "," : ".";
    whole = s.slice(0, at);
    fraction = s.slice(at + 1);
    if (whole.includes(at === dot ? "." : ",") || !groupsOfThree(whole.split(grouping))) return null;
    whole = whole.split(grouping).join("");
  } else if (dot >= 0 || comma >= 0) {
    const parts = s.split(dot >= 0 ? "." : ",");
    if (parts.length > 2) {
      if (!groupsOfThree(parts)) return null;
      whole = parts.join("");
    } else if (parts[1].length === 3 && parts[0] !== "0" && parts[0].length <= 3) whole = parts.join("");
    else [whole, fraction] = parts;
  }
  const value = Number(`${whole}.${fraction || "0"}`);
  if (!Number.isFinite(value) || value > 1e15) return null;
  return negative ? -value : value;
}
const groupsOfThree = (parts: string[]) => parts.length > 0 && parts[0].length >= 1 && parts[0].length <= 3 && parts.slice(1).every((p) => /^\d{3}$/.test(p));

const FLOW_LINE = /^(.+?)\s*(?:->|→|=>|⇒)\s*(.+)$/;
const NODE_LINE = /^(.+?)\s+(#[0-9a-f]{3}|#[0-9a-f]{6})$/i;

// The flows of a source, the node colours and the order of first mention;
// every line that cannot be used gives an error (1-based line numbers).
export function parseFlow(source: string, t: Translate = tr): FlowGraph {
  const graph = collector(t);
  cleanFlowSource(source)
    .split("\n")
    .forEach((raw, index) => {
      const line = raw.trim();
      const number = index + 1;
      if (!line || line.startsWith("//")) return;
      const fail = (message: string) => graph.errors.push({ line: number, message });
      const flow = FLOW_LINE.exec(line);
      if (!flow) {
        const node = NODE_LINE.exec(line);
        if (node && !/[:→]|->/.test(node[1])) {
          const name = node[1].trim();
          if (name.length > MAX_FLOW_NAME) return fail(t(`Namen dürfen höchstens ${MAX_FLOW_NAME} Zeichen lang sein.`, `Names can be at most ${MAX_FLOW_NAME} characters long.`));
          graph.colors[name] = fullColor(node[2]);
          graph.mention(name);
          return;
        }
        return fail(t("Zeile nicht verstanden – schreib „Quelle -> Ziel: Betrag“ oder „Name #Farbe“.", "Line not understood – write “Source -> Target: amount” or “Name #colour”."));
      }
      const rest = flow[2];
      const colon = rest.lastIndexOf(":");
      if (colon < 0) return fail(t("Der Betrag fehlt – schreib ihn nach einem Doppelpunkt: „Quelle -> Ziel: 100“.", "The amount is missing – write it after a colon: “Source -> Target: 100”."));
      const amountText = rest.slice(colon + 1).trim();
      const value = parseAmount(amountText);
      if (value === null) return fail(t(`„${amountText.slice(0, 30)}“ ist keine Zahl.`, `“${amountText.slice(0, 30)}” is not a number.`));
      const error = graph.add(flow[1].trim(), rest.slice(0, colon).trim(), value);
      if (error) fail(error);
    });
  return { flows: graph.flows(), colors: graph.colors, order: graph.order, errors: graph.errors };
}
// Adds flows one by one and says why one cannot be added.
function collector(t: Translate) {
  const errors: FlowError[] = [];
  const colors: Record<string, string> = {};
  const order: string[] = [];
  const pairs = new Map<string, Flow>();
  const outgoing = new Map<string, Set<string>>();
  const mention = (name: string) => {
    if (!order.includes(name)) order.push(name);
  };
  const add = (sourceName: string, targetName: string, value: number): string | null => {
    if (!sourceName || !targetName) return t("Quelle oder Ziel fehlt.", "Source or target is missing.");
    if (sourceName.length > MAX_FLOW_NAME || targetName.length > MAX_FLOW_NAME)
      return t(`Namen dürfen höchstens ${MAX_FLOW_NAME} Zeichen lang sein.`, `Names can be at most ${MAX_FLOW_NAME} characters long.`);
    if (!Number.isFinite(value)) return t("Der Betrag ist keine Zahl.", "The amount is not a number.");
    if (value < 0) return t("Negative Beträge gehen nicht – dreh die Richtung des Flusses um.", "Negative amounts are not allowed – reverse the direction of the flow.");
    if (sourceName === targetName) return t("Quelle und Ziel sind gleich – ein Fluss braucht zwei verschiedene Knoten.", "Source and target are the same – a flow needs two different nodes.");
    const key = JSON.stringify([sourceName, targetName]);
    if (!pairs.has(key)) {
      if (pairs.size >= MAX_FLOWS) return t(`Höchstens ${MAX_FLOWS} Flüsse pro Diagramm.`, `At most ${MAX_FLOWS} flows per diagram.`);
      const cycle = pathBetween(outgoing, targetName, sourceName);
      if (cycle) {
        const path = [sourceName, ...cycle].join(" → ");
        return t(`Dieser Fluss schließt einen Kreis (${path}) – Sankey-Diagramme laufen nur in eine Richtung.`, `This flow closes a cycle (${path}) – Sankey diagrams only run one way.`);
      }
      pairs.set(key, { source: sourceName, target: targetName, value: 0 });
      if (!outgoing.has(sourceName)) outgoing.set(sourceName, new Set());
      outgoing.get(sourceName)!.add(targetName);
    }
    pairs.get(key)!.value += value;
    mention(sourceName);
    mention(targetName);
    return null;
  };
  return { errors, colors, order, mention, add, flows: () => [...pairs.values()] };
}
// The path from `from` to `to` along the flows so far (both included), or null.
function pathBetween(outgoing: Map<string, Set<string>>, from: string, to: string): string[] | null {
  const previous = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift()!;
    if (at === to) {
      const path = [at];
      for (let p = previous.get(at); p != null; p = previous.get(p)) path.unshift(p);
      return path;
    }
    for (const next of outgoing.get(at) || [])
      if (!previous.has(next)) {
        previous.set(next, at);
        queue.push(next);
      }
  }
  return null;
}
// Flows from elsewhere (a database's records): summed per pair; flows that
// cannot be drawn (cycles, negative amounts) are left out and counted.
export function flowGraph(list: Flow[], colors: Record<string, string> = {}): FlowGraph & { dropped: number } {
  const graph = collector((de) => de);
  let dropped = 0;
  for (const flow of list) if (graph.add(flow.source.slice(0, MAX_FLOW_NAME), flow.target.slice(0, MAX_FLOW_NAME), flow.value)) dropped++;
  return { flows: graph.flows(), colors: { ...colors }, order: graph.order, errors: [], dropped };
}

export type FlowNode = {
  name: string;
  color: string;
  inValue: number;
  outValue: number;
  value: number;
  column: number;
  x: number;
  y: number;
  height: number;
};
export type FlowLink = { source: number; target: number; value: number; width: number; sy: number; ty: number };
export type FlowLayout = { width: number; height: number; nodes: FlowNode[]; links: FlowLink[]; labelRight: number };
export const FLOW_BAR = 14;
const GAP = 18,
  PAD = 10,
  INNER_WIDTH = 600;

// Positions for the nodes and bands. `labelWidth` estimates how wide the
// labels of the last column are (they stand right of their bars).
export function layoutFlow(graph: Pick<FlowGraph, "flows" | "colors" | "order">, options: { palette?: readonly string[]; labelWidth?: (node: FlowNode) => number } = {}): FlowLayout {
  const palette = options.palette?.length ? options.palette : FLOW_COLORS;
  const names = graph.order.filter((name) => graph.flows.some((f) => f.source === name || f.target === name));
  for (const f of graph.flows) for (const n of [f.source, f.target]) if (!names.includes(n)) names.push(n);
  const index = new Map(names.map((n, i) => [n, i]));
  const nodes: FlowNode[] = names.map((name, i) => ({
    name,
    color: graph.colors[name] && COLOR.test(graph.colors[name]) ? fullColor(graph.colors[name]) : palette[i % palette.length],
    inValue: 0,
    outValue: 0,
    value: 0,
    column: 0,
    x: 0,
    y: 0,
    height: 0,
  }));
  const links: FlowLink[] = graph.flows.map((f) => ({ source: index.get(f.source)!, target: index.get(f.target)!, value: f.value, width: 0, sy: 0, ty: 0 }));
  for (const l of links) {
    nodes[l.source].outValue += l.value;
    nodes[l.target].inValue += l.value;
  }
  for (const n of nodes) n.value = Math.max(n.inValue, n.outValue);
  // Columns: the longest path from a node without inflow (the graph has no
  // cycles; at most n rounds).
  for (let round = 0; round < nodes.length; round++) {
    let moved = false;
    for (const l of links)
      if (nodes[l.target].column < nodes[l.source].column + 1) {
        nodes[l.target].column = nodes[l.source].column + 1;
        moved = true;
      }
    if (!moved) break;
  }
  const columnCount = nodes.length ? Math.max(...nodes.map((n) => n.column)) + 1 : 0;
  const columns: number[][] = Array.from({ length: columnCount }, () => []);
  nodes.forEach((n, i) => columns[n.column].push(i));
  const most = Math.max(1, ...columns.map((c) => c.length));
  const height = Math.round(Math.min(1000, Math.max(260, most * 46)));
  // One scale for all columns: the fullest column fills the height.
  const scale = Math.min(
    ...columns.map((c) => {
      const total = c.reduce((sum, i) => sum + nodes[i].value, 0);
      return total > 0 ? (height - 2 * PAD - (c.length - 1) * GAP) / total : Infinity;
    }),
  );
  const ky = Number.isFinite(scale) && scale > 0 ? scale : 1;
  for (const n of nodes) n.height = Math.max(1, n.value * ky);
  const place = (column: number[]) => {
    const total = column.reduce((sum, i) => sum + nodes[i].height, 0) + (column.length - 1) * GAP;
    let y = Math.max(PAD, (height - total) / 2);
    for (const i of column) {
      nodes[i].y = y;
      y += nodes[i].height + GAP;
    }
  };
  columns.forEach(place);
  // Fewer crossings: sort each column by the weighted centre of its
  // neighbours, left to right and back, a few times (stable, so ties keep
  // the order of the source).
  const centre = (i: number) => nodes[i].y + nodes[i].height / 2;
  const sweep = (column: number[], neighbours: (i: number) => { at: number; value: number }[]) => {
    const keys = new Map(
      column.map((i) => {
        const list = neighbours(i);
        const weight = list.reduce((sum, n) => sum + n.value, 0);
        return [i, list.length && weight > 0 ? list.reduce((sum, n) => sum + centre(n.at) * n.value, 0) / weight : centre(i)];
      }),
    );
    column.sort((a, b) => keys.get(a)! - keys.get(b)!);
    place(column);
  };
  for (let round = 0; round < 3; round++) {
    for (let c = 1; c < columnCount; c++) sweep(columns[c], (i) => links.filter((l) => l.target === i).map((l) => ({ at: l.source, value: l.value })));
    for (let c = columnCount - 2; c >= 0; c--) sweep(columns[c], (i) => links.filter((l) => l.source === i).map((l) => ({ at: l.target, value: l.value })));
  }
  // Horizontal positions: the last column leaves room for its labels.
  const labelWidth = options.labelWidth ?? ((n: FlowNode) => n.name.length * 7 + 80);
  const last = columns[columnCount - 1] || [];
  const labelRight = Math.min(320, Math.max(60, ...last.map((i) => labelWidth(nodes[i]))));
  const span = INNER_WIDTH - FLOW_BAR;
  for (const n of nodes) n.x = PAD + (columnCount > 1 ? (n.column / (columnCount - 1)) * span : 0);
  // Bands: stacked at their source in the order of their targets and at
  // their target in the order of their sources.
  for (const l of links) l.width = Math.max(1, l.value * ky);
  nodes.forEach((_, i) => {
    let sy = nodes[i].y;
    for (const l of links.filter((l) => l.source === i).sort((a, b) => centre(a.target) - centre(b.target))) {
      l.sy = sy;
      sy += l.width;
    }
    let ty = nodes[i].y;
    for (const l of links.filter((l) => l.target === i).sort((a, b) => centre(a.source) - centre(b.source))) {
      l.ty = ty;
      ty += l.width;
    }
  });
  return { width: PAD + INNER_WIDTH + 8 + labelRight, height, nodes, links, labelRight };
}

// Currency symbols the number format knows by their ISO code.
const CURRENCIES: Record<string, string> = { "€": "EUR", $: "USD", US$: "USD", "£": "GBP", "¥": "JPY", "₹": "INR", "₽": "RUB", "Fr.": "CHF", "zł": "PLN", "₺": "TRY" };
// Amounts as the reader's language writes them, with the unit: "1.100,00 €"
// in German, "€1,100.00" in English, "12,5 kWh".
export function flowFormat(unit: string, locale: string = LOCALE_TAG, values: number[] = []) {
  const u = cleanFlowUnit(unit);
  const code = CURRENCIES[u] ?? (/^[A-Z]{3}$/.test(u) ? u : null);
  if (code)
    try {
      const format = new Intl.NumberFormat(locale, { style: "currency", currency: code });
      return (n: number) => format.format(n);
    } catch {
      // Not a currency after all: shown as a unit.
    }
  const fractions = values.some((v) => Math.abs(v - Math.round(v)) > 1e-9);
  const format = new Intl.NumberFormat(locale, { minimumFractionDigits: fractions ? 2 : 0, maximumFractionDigits: 2 });
  return (n: number) => format.format(n) + (u ? ` ${u}` : "");
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (n: number) => (Math.round(n * 100) / 100).toString();
// The band between two nodes: two cubic curves and the bars' edges.
export function bandPath(x0: number, y0: number, x1: number, y1: number, width: number) {
  const mid = (x0 + x1) / 2;
  return `M${f(x0)},${f(y0)}C${f(mid)},${f(y0)} ${f(mid)},${f(y1)} ${f(x1)},${f(y1)}L${f(x1)},${f(y1 + width)}C${f(mid)},${f(y1 + width)} ${f(mid)},${f(y0 + width)} ${f(x0)},${f(y0 + width)}Z`;
}

export type FlowSvgOptions = {
  unit?: string;
  locale?: string;
  label?: string;
  palette?: readonly string[];
  t?: Translate;
  // Width and height in pixels (a picture on its own, e.g. in an export)
  // rather than the box's width.
  fixedSize?: boolean;
};
// The diagram as an SVG string. Colours and opacity are presentation
// attributes (exports without the app's CSS look right); the app's CSS
// (.flow-svg in app/globals.css) adjusts text and bands for dark mode.
export function flowSvg(graph: Pick<FlowGraph, "flows" | "colors" | "order">, options: FlowSvgOptions = {}): string {
  const t = options.t ?? tr;
  const values = graph.flows.map((x) => x.value);
  const format = flowFormat(options.unit || "", options.locale, values);
  const label = options.label || t("Sankey-Diagramm", "Sankey diagram");
  if (!graph.flows.length)
    return `<svg class="flow-svg flow-empty" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 80" ${options.fixedSize ? 'width="640" height="80"' : 'width="100%"'} role="img" aria-label="${escape(label)}"><text class="flow-hint" x="320" y="44" text-anchor="middle" font-size="13" fill="#6b6b6b">${escape(t("Noch keine Flüsse – schreib z. B. „Lohn -> Budget: 2500“.", "No flows yet – write e.g. “Salary -> Budget: 2500”."))}</text></svg>`;
  const text = (n: FlowNode) => `${n.name}: ${format(n.value)}`;
  // Width of a label at 14px: about 7.7px per character.
  const layout = layoutFlow(graph, { palette: options.palette, labelWidth: (n) => text(n).length * 7.9 + 12 });
  const { nodes, links } = layout;
  const parts: string[] = [];
  parts.push(`<title>${escape(label)}</title>`);
  parts.push('<g class="flow-links">');
  for (const l of links) {
    const s = nodes[l.source],
      d = nodes[l.target];
    parts.push(
      `<path class="flow-link" d="${bandPath(s.x + FLOW_BAR, l.sy, d.x, l.ty, l.width)}" fill="${s.color}" fill-opacity="0.38"><title>${escape(`${s.name} → ${d.name}: ${format(l.value)}`)}</title></path>`,
    );
  }
  parts.push('</g><g class="flow-nodes">');
  for (const n of nodes)
    parts.push(`<rect class="flow-node" x="${f(n.x)}" y="${f(n.y)}" width="${FLOW_BAR}" height="${f(n.height)}" rx="2" fill="${n.color}"><title>${escape(text(n))}</title></rect>`);
  parts.push('</g><g class="flow-labels" font-size="14" fill="#1f2328" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke">');
  for (const n of nodes)
    parts.push(
      `<text class="flow-label" x="${f(n.x + FLOW_BAR + 6)}" y="${f(n.y + n.height / 2)}" dominant-baseline="middle"><tspan class="flow-name" font-weight="600">${escape(n.name)}:</tspan> <tspan class="flow-value">${escape(format(n.value))}</tspan></text>`,
    );
  parts.push("</g>");
  return `<svg class="flow-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(layout.width)} ${layout.height}" ${options.fixedSize ? `width="${Math.ceil(layout.width)}" height="${layout.height}"` : 'width="100%"'} role="img" aria-label="${escape(label)}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">${parts.join("")}</svg>`;
}
// A block's SVG straight from its source.
export const flowSourceSvg = (source: string, options: FlowSvgOptions = {}) => flowSvg(parseFlow(source, options.t), options);
