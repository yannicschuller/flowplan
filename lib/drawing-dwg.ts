// Reads what LibreDWG (@mlightcad/libredwg-web, GPL-3.0, in the parsing
// worker) makes of a DWG file – its DwgDatabase – into the drawing
// viewer's model (#384, lib/drawing-model.ts). Only the shapes are used
// here, so this file needs nothing of LibreDWG itself; the tests feed it
// a database the same build produced.
import { aciColor, emptyDrawing, mirroredOcs, mtextAnchor, plainMText, plainText, textAnchor, textUsesAlignmentPoint, type ColorRef, type Drawing, type DrawingEntity } from "./drawing-model";
import { arcPoints, ellipsePoints, polylinePoints, splinePoints, type Pt } from "./drawing-geometry";

type Raw = Record<string, unknown> & { type?: string };
type DwgDatabaseLike = {
  header?: Record<string, unknown>;
  entities?: Raw[];
  tables?: {
    BLOCK_RECORD?: { entries?: { name?: string; basePoint?: unknown; entities?: Raw[] }[] };
    LAYER?: { entries?: { name?: string; colorIndex?: number; color?: number; off?: boolean; frozen?: boolean; lineType?: string }[] };
    LTYPE?: { entries?: { name?: string; pattern?: { elementLength?: number }[] }[] };
  };
};

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const pt = (v: unknown): Pt => {
  const p = (v || {}) as { x?: unknown; y?: unknown };
  return { x: num(p.x), y: num(p.y) };
};

// Index 256 BYLAYER, 0 BYBLOCK, 1–255 the palette. LibreDWG also fills
// `color` for indexed colours (with white for layers), so it counts only
// without a palette index.
function colorOf(raw: { colorIndex?: unknown; color?: unknown } | Record<string, unknown>): ColorRef {
  const index = typeof raw.colorIndex === "number" ? raw.colorIndex : 256;
  const rgb = typeof raw.color === "number" ? raw.color : undefined;
  if (index === 0 || index === 256 || aciColor(Math.abs(index)) !== null) return { aci: index };
  return rgb !== undefined && rgb >= 0 ? { aci: 257, rgb } : { aci: 256 };
}

function hatchRings(raw: Raw): Pt[][] {
  const rings: Pt[][] = [];
  for (const path of (raw.boundaryPaths as Raw[]) || []) {
    const ring: Pt[] = [];
    if (Array.isArray(path.vertices)) {
      ring.push(...polylinePoints((path.vertices as Raw[]).map((v) => ({ ...pt(v), bulge: num(v.bulge) })), true));
    } else
      for (const edge of (path.edges as Raw[]) || []) {
        const kind = num(edge.type);
        if (kind === 1) {
          if (!ring.length) ring.push(pt(edge.start));
          ring.push(pt(edge.end));
        } else if (kind === 2) {
          const ccw = edge.isCCW !== false;
          const start = num(edge.startAngle),
            end = num(edge.endAngle);
          ring.push(...(ccw ? arcPoints(pt(edge.center), num(edge.radius), start, end, true) : arcPoints(pt(edge.center), num(edge.radius), -start, -end, false)));
        } else if (kind === 3) {
          const ccw = edge.isCCW !== false;
          const start = num(edge.startAngle),
            end = num(edge.endAngle);
          const ratio = num(edge.lengthOfMinorAxis, 1);
          ring.push(...(ccw ? ellipsePoints(pt(edge.center), pt(edge.end), ratio, start, end, true) : ellipsePoints(pt(edge.center), pt(edge.end), ratio, -start, -end, false)));
        } else if (kind === 4) {
          const controls = ((edge.controlPoints as Raw[]) || []).map(pt);
          const weights = ((edge.controlPoints as Raw[]) || []).map((c) => num(c.weight, 1));
          ring.push(...splinePoints(num(edge.degree, 3), controls, ((edge.knots as number[]) || []).map((k) => num(k)), weights, ((edge.fitDatum as unknown[]) || []).map(pt)));
        }
      }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

function textOf(base: { layer: string; color: ColorRef; lineType?: string; lineTypeScale: number }, t: Raw, mirror: boolean): DrawingEntity | null {
  const h = num(t.halign),
    v = num(t.valign);
  const at = textUsesAlignmentPoint(h, v) ? pt(t.endPoint ?? t.alignmentPoint) : pt(t.startPoint);
  const rotation = num(t.rotation);
  return {
    ...base,
    type: "text",
    at: mirror ? { x: -at.x, y: at.y } : at,
    height: num(t.textHeight, 1),
    rotation: mirror ? Math.PI - rotation : rotation,
    lines: [plainText(String(t.text ?? ""))],
    anchor: textAnchor(h, v),
  };
}

function convert(raw: Raw, skipped: Record<string, number>): DrawingEntity | DrawingEntity[] | null {
  if (raw.isInPaperSpace || raw.isVisible === false) return null;
  const base = {
    layer: String(raw.layer ?? "0"),
    color: colorOf(raw),
    lineType: typeof raw.lineType === "string" && raw.lineType ? raw.lineType : undefined,
    lineTypeScale: num(raw.lineTypeScale, 1) || 1,
  };
  const mirror = mirroredOcs(raw.extrusionDirection as { z?: number });
  const ocs = (p: Pt): Pt => (mirror ? { x: -p.x, y: p.y } : p);
  switch (raw.type) {
    case "LINE":
      return { ...base, type: "line", a: pt(raw.startPoint), b: pt(raw.endPoint) };
    case "LWPOLYLINE":
    case "POLYLINE2D":
    case "POLYLINE3D": {
      const flat = raw.type !== "POLYLINE3D";
      const vertices = ((raw.vertices as Raw[]) || [])
        .filter((v) => !(num(v.flag) & 16))
        .map((v) => ({ ...(flat ? ocs(pt(v)) : pt(v)), bulge: (mirror && flat ? -1 : 1) * num(v.bulge) }));
      if (vertices.length < 2) return null;
      const flag = num(raw.flag);
      return { ...base, type: "polyline", vertices, closed: !!(flag & 1) || (raw.type === "LWPOLYLINE" && !!(flag & 512)) };
    }
    case "CIRCLE":
      return { ...base, type: "circle", c: ocs(pt(raw.center)), r: num(raw.radius) };
    case "ARC": {
      const start = num(raw.startAngle),
        end = num(raw.endAngle);
      return mirror
        ? { ...base, type: "arc", c: ocs(pt(raw.center)), r: num(raw.radius), start: Math.PI - end, end: Math.PI - start }
        : { ...base, type: "arc", c: pt(raw.center), r: num(raw.radius), start, end };
    }
    case "ELLIPSE":
      return { ...base, type: "ellipse", c: pt(raw.center), major: pt(raw.majorAxisEndPoint), ratio: num(raw.axisRatio, 1), start: num(raw.startAngle), end: num(raw.endAngle, Math.PI * 2) };
    case "SPLINE":
      return {
        ...base,
        type: "spline",
        degree: num(raw.degree, 3),
        controls: ((raw.controlPoints as unknown[]) || []).map(pt),
        knots: ((raw.knots as number[]) || []).map((k) => num(k)),
        weights: Array.isArray(raw.weights) && raw.weights.length ? (raw.weights as number[]) : undefined,
        fit: ((raw.fitPoints as unknown[]) || []).map(pt),
        closed: !!(num(raw.flag) & 1),
      };
    case "TEXT":
      return textOf(base, raw, mirror);
    case "ATTRIB":
      if (num(raw.flags) & 1) return null;
      return textOf(base, { ...((raw.text as Raw) || {}), text: ((raw.text as Raw) || {}).text }, mirror);
    case "MTEXT": {
      const d = pt(raw.direction);
      const rotation = d.x || d.y ? Math.atan2(d.y, d.x) : num(raw.rotation);
      return {
        ...base,
        type: "text",
        at: pt(raw.insertionPoint),
        height: num(raw.textHeight, 1),
        rotation,
        lines: plainMText(String(raw.text ?? "")),
        anchor: mtextAnchor(num(raw.attachmentPoint, 1)),
        lineSpacing: (5 / 3) * (num(raw.lineSpacing, 1) || 1),
      };
    }
    case "INSERT": {
      const rotation = num(raw.rotation);
      const insert: DrawingEntity = {
        ...base,
        type: "insert",
        block: String(raw.name ?? ""),
        at: ocs(pt(raw.insertionPoint)),
        sx: (mirror ? -1 : 1) * (num(raw.xScale, 1) || 1),
        sy: num(raw.yScale, 1) || 1,
        rotation: mirror ? -rotation : rotation,
        columns: num(raw.columnCount, 1) || 1,
        rows: num(raw.rowCount, 1) || 1,
        columnSpacing: num(raw.columnSpacing),
        rowSpacing: num(raw.rowSpacing),
      };
      // Attribute values, already where the reference shows them.
      const attributes = ((raw.attribs as Raw[]) || []).map((a) => convert({ ...a, type: "ATTRIB" }, skipped)).filter(Boolean) as DrawingEntity[];
      return [insert, ...attributes];
    }
    case "DIMENSION":
      if (!raw.name) return null;
      return { ...base, type: "insert", block: String(raw.name), at: { x: 0, y: 0 }, sx: 1, sy: 1, rotation: 0, columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0 };
    case "SOLID":
    case "TRACE": {
      const p = [raw.corner1, raw.corner2, raw.corner3, raw.corner4].filter(Boolean).map((q) => ocs(pt(q)));
      if (p.length < 3) return null;
      const ring = p.length >= 4 ? [p[0], p[1], p[3], p[2], p[0]] : [...p, p[0]];
      return { ...base, type: "fill", rings: [ring], solid: true };
    }
    case "3DFACE": {
      const p = [raw.corner1, raw.corner2, raw.corner3, raw.corner4].filter(Boolean).map(pt);
      if (p.length < 3) return null;
      return { ...base, type: "polyline", vertices: [...p, p[0]], closed: false };
    }
    case "HATCH": {
      const rings = hatchRings(raw).map((ring) => ring.map(ocs));
      if (!rings.length) return null;
      return { ...base, type: "fill", rings, solid: num(raw.solidFill) === 1 };
    }
    case "POINT":
      return { ...base, type: "point", at: pt(raw.position) };
    case "ATTDEF":
    case "VIEWPORT":
      return null;
    default:
      skipped[String(raw.type)] = (skipped[String(raw.type)] || 0) + 1;
      return null;
  }
}

const list = (out: DrawingEntity[], value: DrawingEntity | DrawingEntity[] | null) => {
  if (Array.isArray(value)) out.push(...value);
  else if (value) out.push(value);
};

export function readDwgDatabase(db: DwgDatabaseLike): Drawing {
  const drawing = emptyDrawing();
  drawing.units = num(db.header?.INSUNITS);
  drawing.lineTypeScale = num(db.header?.LTSCALE, 1) || 1;
  for (const layer of db.tables?.LAYER?.entries || []) {
    if (!layer?.name) continue;
    drawing.layers.push({ name: layer.name, color: colorOf(layer), on: !layer.off && num(layer.colorIndex, 7) >= 0, frozen: !!layer.frozen, lineType: layer.lineType });
  }
  for (const lt of db.tables?.LTYPE?.entries || []) if (lt?.name && lt.pattern?.length) drawing.lineTypes[lt.name] = lt.pattern.map((e) => num(e.elementLength));
  let model: Raw[] | null = null;
  for (const record of db.tables?.BLOCK_RECORD?.entries || []) {
    const name = String(record.name ?? "");
    if (/^\*model_space$/i.test(name)) {
      model = record.entities || [];
      continue;
    }
    if (/^\*paper_space/i.test(name)) continue;
    const entities: DrawingEntity[] = [];
    for (const raw of record.entities || []) list(entities, convert(raw, drawing.skipped));
    drawing.blocks[name] = { base: pt(record.basePoint), entities };
  }
  // R11/R12 files have no block record for the model space.
  if (!model || !model.length) model = (db.entities || []).filter((e) => !e.isInPaperSpace);
  for (const raw of model) list(drawing.entities, convert(raw, drawing.skipped));
  return drawing;
}
