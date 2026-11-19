// Reads a DXF file into the drawing viewer's model (#384,
// lib/drawing-model.ts) with dxf-parser (MIT), which knows the common
// entities; HATCH, ATTRIB (the values of block attributes) and CIRCLE
// (with its extrusion, for mirrored circles) are read by the handlers
// below, the layers' linetypes and true colours by layerExtras(). Runs in
// the parsing worker and in the tests.
import DxfParser from "dxf-parser";
import { arcPoints, ellipsePoints, polylinePoints, splinePoints, type Pt } from "./drawing-geometry";
import {
  BYLAYER,
  emptyDrawing,
  mirroredOcs,
  mtextAnchor,
  plainMText,
  plainText,
  textAnchor,
  textUsesAlignmentPoint,
  type ColorRef,
  type Drawing,
  type DrawingEntity,
} from "./drawing-model";

type Group = { code: number; value: number | string | boolean };
type Scanner = { next(): Group; isEOF(): boolean; lastReadGroup: Group };
type Raw = Record<string, unknown> & { type: string };

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const pt = (v: unknown): Pt => {
  const p = (v || {}) as { x?: unknown; y?: unknown };
  return { x: num(p.x), y: num(p.y) };
};
const DEG = Math.PI / 180;

// The groups of one entity up to the next 0 group (where the scanner
// stays, as dxf-parser expects of a handler).
function readGroups(scanner: Scanner): Group[] {
  const groups: Group[] = [];
  let g = scanner.next();
  while (!scanner.isEOF() && g.code !== 0) {
    groups.push(g);
    g = scanner.next();
  }
  return groups;
}
// Layer, colour, linetype and visibility, which every entity may have.
function common(entity: Raw, g: Group) {
  switch (g.code) {
    case 6:
      entity.lineType = g.value;
      return true;
    case 8:
      entity.layer = g.value;
      return true;
    case 48:
      entity.lineTypeScale = g.value;
      return true;
    case 60:
      entity.visible = g.value === 0;
      return true;
    case 62:
      entity.colorIndex = g.value;
      return true;
    case 67:
      entity.inPaperSpace = g.value !== 0;
      return true;
    case 420:
      entity.trueColor = g.value;
      return true;
  }
  return false;
}

// HATCH: the boundary paths (polylines with bulges, or edges: lines, arcs,
// elliptic arcs, splines) as closed rings; solid fill or pattern.
export type HatchRaw = Raw & { solid: boolean; rings: Pt[][]; extrusionZ?: number };
class HatchHandler {
  ForEntityName = "HATCH";
  parseEntity(scanner: Scanner, curr: Group): HatchRaw {
    const entity: HatchRaw = { type: String(curr.value), solid: false, rings: [] };
    const groups = readGroups(scanner);
    let i = 0;
    const peek = () => groups[i];
    const take = () => groups[i++];
    const value = (code: number, fallback = 0) => (peek()?.code === code ? num(take().value, fallback) : fallback);
    const point = (xCode: number): Pt => {
      const x = value(xCode);
      const y = value(xCode + 10);
      return { x, y };
    };
    while (i < groups.length) {
      const g = take();
      if (common(entity, g)) continue;
      if (g.code === 70) entity.solid = g.value === 1;
      else if (g.code === 230) entity.extrusionZ = num(g.value, 1);
      else if (g.code === 91) {
        const paths = num(g.value);
        for (let p = 0; p < paths && i < groups.length; p++) {
          // Skip to the path's type flag.
          while (i < groups.length && peek().code !== 92) i++;
          if (i >= groups.length) break;
          const flag = num(take().value);
          const ring: Pt[] = [];
          if (flag & 2) {
            const hasBulge = value(72) !== 0;
            // The "closed" flag: boundary paths are always closed.
            value(73);
            const count = value(93);
            const vertices: (Pt & { bulge?: number })[] = [];
            for (let v = 0; v < count && peek()?.code === 10; v++) {
              const at = point(10);
              vertices.push({ ...at, bulge: hasBulge && peek()?.code === 42 ? num(take().value) : 0 });
            }
            ring.push(...polylinePoints(vertices, true));
          } else {
            const edges = value(93);
            for (let e = 0; e < edges && peek()?.code === 72; e++) {
              const kind = num(take().value);
              if (kind === 1) {
                const a = point(10),
                  b = point(11);
                if (!ring.length) ring.push(a);
                ring.push(b);
              } else if (kind === 2) {
                const c = point(10);
                const r = value(40);
                const start = value(50) * DEG,
                  end = value(51) * DEG;
                const ccw = value(73, 1) !== 0;
                // Clockwise arcs are stored with mirrored angles.
                ring.push(...(ccw ? arcPoints(c, r, start, end, true) : arcPoints(c, r, -start, -end, false)));
              } else if (kind === 3) {
                const c = point(10),
                  major = point(11);
                const ratio = value(40, 1);
                const start = value(50) * DEG,
                  end = value(51) * DEG;
                const ccw = value(73, 1) !== 0;
                ring.push(...(ccw ? ellipsePoints(c, major, ratio, start, end, true) : ellipsePoints(c, major, ratio, -start, -end, false)));
              } else if (kind === 4) {
                const degree = value(94, 3);
                value(73);
                value(74);
                const knotCount = value(95);
                const controlCount = value(96);
                const knots: number[] = [];
                for (let k = 0; k < knotCount && peek()?.code === 40; k++) knots.push(num(take().value));
                const controls: Pt[] = [];
                const weights: number[] = [];
                for (let c = 0; c < controlCount && peek()?.code === 10; c++) {
                  controls.push(point(10));
                  if (peek()?.code === 42) weights.push(num(take().value, 1));
                }
                const fit: Pt[] = [];
                const fitCount = value(97);
                for (let f = 0; f < fitCount && peek()?.code === 11; f++) fit.push(point(11));
                if (peek()?.code === 12) point(12);
                if (peek()?.code === 13) point(13);
                ring.push(...splinePoints(degree, controls, knots, weights.length === controls.length ? weights : undefined, fit));
              } else break;
            }
          }
          // The source objects of an associative hatch.
          const sources = value(97);
          for (let s = 0; s < sources && peek()?.code === 330; s++) take();
          if (ring.length >= 3) entity.rings.push(ring);
        }
      }
    }
    return entity;
  }
}

// ATTRIB: an attribute's value where its block reference shows it.
class AttribHandler {
  ForEntityName = "ATTRIB";
  parseEntity(scanner: Scanner, curr: Group): Raw {
    const entity: Raw = { type: String(curr.value) };
    for (const g of readGroups(scanner)) {
      if (common(entity, g)) continue;
      const v = g.value;
      if (g.code === 1) entity.text = v;
      else if (g.code === 10) entity.x = v;
      else if (g.code === 20) entity.y = v;
      else if (g.code === 11) entity.x2 = v;
      else if (g.code === 21) entity.y2 = v;
      else if (g.code === 40) entity.textHeight = v;
      else if (g.code === 50) entity.rotation = v;
      else if (g.code === 70) entity.flags = v;
      else if (g.code === 72) entity.halign = v;
      else if (g.code === 74) entity.valign = v;
      else if (g.code === 230) entity.extrusionZ = v;
    }
    return entity;
  }
}

// CIRCLE with its extrusion direction (dxf-parser drops it).
class CircleHandler {
  ForEntityName = "CIRCLE";
  parseEntity(scanner: Scanner, curr: Group): Raw {
    const entity: Raw = { type: String(curr.value) };
    const center = { x: 0, y: 0 };
    for (const g of readGroups(scanner)) {
      if (common(entity, g)) continue;
      if (g.code === 10) center.x = num(g.value);
      else if (g.code === 20) center.y = num(g.value);
      else if (g.code === 40) entity.radius = g.value;
      else if (g.code === 230) entity.extrusionZ = g.value;
    }
    entity.center = center;
    return entity;
  }
}

// What dxf-parser leaves out of the LAYER table: each layer's linetype (6)
// and true colour (420). Read from the TABLES section's lines only.
export function layerExtras(text: string): Record<string, { lineType?: string; rgb?: number }> {
  const extras: Record<string, { lineType?: string; rgb?: number }> = {};
  const start = text.search(/\n\s*TABLES\s*\r?\n/);
  if (start < 0) return extras;
  const end = text.indexOf("ENDSEC", start);
  const lines = text.slice(start, end < 0 ? undefined : end).split(/\r?\n/);
  let inLayers = false,
    current: { lineType?: string; rgb?: number } | null = null;
  // lines[1] is "TABLES" (the value of the section's 2 group): pairs from 2.
  for (let i = 2; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim()),
      value = lines[i + 1].trim();
    if (code === 0) {
      current = null;
      if (value === "ENDTAB") inLayers = false;
      else if (value === "LAYER" && inLayers) current = {};
      continue;
    }
    if (code === 2 && !current && value === "LAYER") inLayers = true;
    if (!inLayers || !current) continue;
    if (code === 2) extras[value] = current;
    else if (code === 6) current.lineType = value;
    else if (code === 420) current.rgb = Number(value);
  }
  return extras;
}

// The colour of a dxf-parser entity: index 62 (0 BYBLOCK, 256 or none
// BYLAYER) and true colour 420. dxf-parser keeps the true colour in
// `color` and also fills it from the index, so a true colour is one that
// is not the index's.
function colorOf(raw: Raw): ColorRef {
  const index = typeof raw.colorIndex === "number" ? (raw.colorIndex as number) : BYLAYER;
  if (typeof raw.trueColor === "number") return { aci: index === BYLAYER || index === 0 ? 257 : index, rgb: raw.trueColor as number };
  return { aci: index };
}

// One dxf-parser entity in the viewer's model (null: not drawn).
function convert(raw: Raw, skipped: Record<string, number>): DrawingEntity | DrawingEntity[] | null {
  if (raw.inPaperSpace || raw.visible === false) return null;
  const base = {
    layer: String(raw.layer ?? "0"),
    color: colorOf(raw),
    lineType: typeof raw.lineType === "string" ? raw.lineType : undefined,
    lineTypeScale: num(raw.lineTypeScale, 1),
  };
  const mirror = mirroredOcs(raw.extrusionDirection as { z?: number }) || num(raw.extrusionDirectionZ, 1) < -0.5 || num(raw.extrusionZ, 1) < -0.5;
  const ocs = (p: Pt): Pt => (mirror ? { x: -p.x, y: p.y } : p);
  switch (raw.type) {
    case "LINE": {
      const v = (raw.vertices as unknown[]) || [];
      if (v.length < 2) return null;
      return { ...base, type: "line", a: pt(v[0]), b: pt(v[1]) };
    }
    case "LWPOLYLINE":
    case "POLYLINE": {
      if (raw.isPolyfaceMesh || raw.is3dPolygonMesh) {
        skipped[raw.type] = (skipped[raw.type] || 0) + 1;
        return null;
      }
      const flat = raw.type === "LWPOLYLINE" || !raw.is3dPolyline;
      const vertices = ((raw.vertices as Record<string, unknown>[]) || [])
        .filter((v) => !v.splineControlPoint)
        .map((v) => ({ ...(flat ? ocs(pt(v)) : pt(v)), bulge: (mirror && flat ? -1 : 1) * num(v.bulge) }));
      if (vertices.length < 2) return null;
      return { ...base, type: "polyline", vertices, closed: !!raw.shape };
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
        degree: num(raw.degreeOfSplineCurve, 3),
        controls: ((raw.controlPoints as unknown[]) || []).map(pt),
        knots: ((raw.knotValues as number[]) || []).map((k) => num(k)),
        weights: Array.isArray(raw.weights) ? (raw.weights as number[]) : undefined,
        fit: ((raw.fitPoints as unknown[]) || []).map(pt),
        closed: !!raw.closed,
      };
    case "TEXT":
    case "ATTRIB": {
      if (raw.type === "ATTRIB" && num(raw.flags) & 1) return null;
      const h = num(raw.halign),
        v = num(raw.valign);
      const at = textUsesAlignmentPoint(h, v)
        ? raw.type === "ATTRIB"
          ? { x: num(raw.x2, num(raw.x)), y: num(raw.y2, num(raw.y)) }
          : pt(raw.endPoint ?? raw.startPoint)
        : raw.type === "ATTRIB"
          ? { x: num(raw.x), y: num(raw.y) }
          : pt(raw.startPoint);
      const rotation = num(raw.rotation) * DEG;
      return {
        ...base,
        type: "text",
        at: ocs(at),
        height: num(raw.textHeight, 1),
        rotation: mirror ? Math.PI - rotation : rotation,
        lines: [plainText(String(raw.text ?? ""))],
        anchor: textAnchor(h, v),
      };
    }
    case "MTEXT": {
      const direction = raw.directionVector as { x?: number; y?: number } | undefined;
      const rotation = direction && (num(direction.x) || num(direction.y)) ? Math.atan2(num(direction.y), num(direction.x)) : num(raw.rotation) * DEG;
      return { ...base, type: "text", at: pt(raw.position), height: num(raw.height, 1), rotation, lines: plainMText(String(raw.text ?? "")), anchor: mtextAnchor(num(raw.attachmentPoint, 1)), lineSpacing: 5 / 3 };
    }
    case "INSERT": {
      const rotation = num(raw.rotation) * DEG;
      return {
        ...base,
        type: "insert",
        block: String(raw.name ?? ""),
        at: ocs(pt(raw.position)),
        sx: (mirror ? -1 : 1) * num(raw.xScale, 1),
        sy: num(raw.yScale, 1),
        rotation: mirror ? -rotation : rotation,
        columns: num(raw.columnCount, 1),
        rows: num(raw.rowCount, 1),
        columnSpacing: num(raw.columnSpacing),
        rowSpacing: num(raw.rowSpacing),
      };
    }
    case "DIMENSION":
      // The dimension's picture is an anonymous block (*D…) in world
      // coordinates.
      if (!raw.block) return null;
      return { ...base, type: "insert", block: String(raw.block), at: { x: 0, y: 0 }, sx: 1, sy: 1, rotation: 0, columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0 };
    case "SOLID":
    case "3DFACE": {
      const p = ((raw.points as unknown[]) || (raw.vertices as unknown[]) || []).map((q) => ocs(pt(q)));
      if (p.length < 3) return null;
      // SOLID's third and fourth corners are crossed (1, 2, 4, 3).
      const ring = raw.type === "SOLID" && p.length >= 4 ? [p[0], p[1], p[3], p[2], p[0]] : [...p, p[0]];
      return raw.type === "SOLID" ? { ...base, type: "fill", rings: [ring], solid: true } : { ...base, type: "polyline", vertices: ring, closed: false };
    }
    case "HATCH": {
      const hatch = raw as HatchRaw;
      if (!hatch.rings.length) return null;
      return { ...base, type: "fill", rings: hatch.rings.map((ring) => ring.map(ocs)), solid: hatch.solid };
    }
    case "POINT":
      return { ...base, type: "point", at: pt(raw.position) };
    case "ATTDEF":
      // The definition inside a block; the reference shows ATTRIB values.
      return null;
    default:
      skipped[raw.type] = (skipped[raw.type] || 0) + 1;
      return null;
  }
}

const list = (out: DrawingEntity[], value: DrawingEntity | DrawingEntity[] | null) => {
  if (Array.isArray(value)) out.push(...value);
  else if (value) out.push(value);
};

// Parses DXF text. Throws when it is not a DXF file dxf-parser can read.
export function readDxf(text: string): Drawing {
  const parser = new DxfParser();
  const register = parser.registerEntityHandler.bind(parser) as (handler: unknown) => void;
  register(HatchHandler);
  register(AttribHandler);
  register(CircleHandler);
  const dxf = parser.parseSync(text) as unknown as {
    header?: Record<string, unknown>;
    entities?: Raw[];
    blocks?: Record<string, { name?: string; position?: unknown; entities?: Raw[] }>;
    tables?: {
      layer?: { layers?: Record<string, { name: string; colorIndex?: number; color?: number; visible?: boolean; frozen?: boolean }> };
      lineType?: { lineTypes?: Record<string, { name: string; pattern?: (string | number)[] }> };
    };
  } | null;
  if (!dxf) throw new Error("Not a DXF file.");
  const drawing = emptyDrawing();
  drawing.units = num(dxf.header?.$INSUNITS);
  drawing.lineTypeScale = num(dxf.header?.$LTSCALE, 1) || 1;
  const extras = layerExtras(text);
  for (const layer of Object.values(dxf.tables?.layer?.layers || {})) {
    const extra = extras[layer.name] || {};
    const aci = num(layer.colorIndex, 7);
    drawing.layers.push({
      name: String(layer.name),
      color: extra.rgb !== undefined && Number.isFinite(extra.rgb) ? { aci: 257, rgb: extra.rgb } : { aci: layer.visible === false ? -Math.abs(aci) : aci },
      on: layer.visible !== false,
      frozen: !!layer.frozen,
      lineType: extra.lineType,
    });
  }
  for (const lt of Object.values(dxf.tables?.lineType?.lineTypes || {})) if (lt?.name && lt.pattern?.length) drawing.lineTypes[lt.name] = lt.pattern.map((v) => Number(v) || 0);
  for (const [name, block] of Object.entries(dxf.blocks || {})) {
    const entities: DrawingEntity[] = [];
    for (const raw of block.entities || []) list(entities, convert(raw, drawing.skipped));
    drawing.blocks[name] = { base: pt(block.position), entities };
  }
  for (const raw of dxf.entities || []) list(drawing.entities, convert(raw, drawing.skipped));
  return drawing;
}

// The text of a DXF file: UTF-8 (AutoCAD 2007 and later), else the
// Windows code page older versions write.
export function decodeDxf(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64 * 1024));
    const page = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*ANSI_(\d+)/i.exec(head)?.[1];
    try {
      return new TextDecoder(page ? `windows-${page}` : "windows-1252").decode(bytes);
    } catch {
      return new TextDecoder("windows-1252").decode(bytes);
    }
  }
}

// Binary DXF (rare) starts with this sentinel; dxf-parser reads text only.
export const isBinaryDxf = (head: Uint8Array) => String.fromCharCode(...head.subarray(0, 18)) === "AutoCAD Binary DXF";
