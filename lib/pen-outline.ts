// The filled shape of a pen stroke whose width follows the pressure (#548):
// the stroke as a pen tip would leave it – a disc at every point, joined by
// the band between each two neighbours – instead of one outline around the
// centre line. An outline built from the two sides crosses itself wherever
// the line turns tighter than it is wide (sharp corners, slow and shaky
// strokes with an Apple Pencil, whose points lie a fraction of a pixel
// apart), and the non-zero fill then leaves holes and gaps in the line.
// Here every piece is convex and runs the same way round, so the fill is
// exactly their union: no holes, whatever the points do.
// Used by the notebook and PDF ink (lib/ink/geometry.ts) and the
// whiteboard's pen (lib/whiteboard-tools.ts).

export type PenPoint = { x: number; y: number; r: number };
export type PenPiece = { kind: "disc"; x: number; y: number; r: number } | { kind: "band"; pts: [number, number][] };

// A disc only where the band joins turn, or where the line starts and ends:
// on a straight run the bands meet edge to edge.
const TURN = Math.cos((3 * Math.PI) / 180);

// The pieces of a stroke through `points` (radius r each). Points closer
// than `minStep` to the last one kept add nothing: the larger radius stays.
export function penPieces(input: PenPoint[], minStep = 0): PenPiece[] {
  const points: PenPoint[] = [];
  for (const p of input) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !(p.r > 0)) continue;
    const last = points[points.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) <= Math.max(minStep, 1e-6)) last.r = Math.max(last.r, p.r);
    else points.push({ ...p });
  }
  const pieces: PenPiece[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    const next = points[i + 1];
    let disc = !prev || !next;
    if (!disc) {
      const ax = p.x - prev.x,
        ay = p.y - prev.y,
        bx = next.x - p.x,
        by = next.y - p.y;
      disc = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by)) < TURN;
    }
    if (disc) pieces.push({ kind: "disc", x: p.x, y: p.y, r: p.r });
    if (!next) continue;
    const dx = next.x - p.x,
      dy = next.y - p.y;
    const len = Math.hypot(dx, dy);
    const nx = -dy / len,
      ny = dx / len;
    const band: [number, number][] = [
      [p.x + nx * p.r, p.y + ny * p.r],
      [next.x + nx * next.r, next.y + ny * next.r],
      [next.x - nx * next.r, next.y - ny * next.r],
      [p.x - nx * p.r, p.y - ny * p.r],
    ];
    // The same way round as the discs (positive area).
    if (area(band) < 0) band.reverse();
    pieces.push({ kind: "band", pts: band });
  }
  return pieces;
}

// Twice the signed area of a polygon (positive: the way the discs run).
export function area(poly: [number, number][]) {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

// The pieces as an SVG path (non-zero fill, the default): discs as two
// half-circle arcs in the positive direction, bands as quadrilaterals.
export function penPath(pieces: PenPiece[], digits = 2) {
  const scale = 10 ** digits;
  const f = (n: number) => Math.round(n * scale) / scale;
  let d = "";
  for (const piece of pieces) {
    if (piece.kind === "disc") {
      const { x, y, r } = piece;
      d += `M${f(x + r)} ${f(y)}A${f(r)} ${f(r)} 0 1 1 ${f(x - r)} ${f(y)}A${f(r)} ${f(r)} 0 1 1 ${f(x + r)} ${f(y)}Z`;
    } else d += `M${piece.pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;
  }
  return d;
}

// The pieces as polygons (discs with `sides` corners), all the same way
// round – for the PDF export and for measuring.
export function penPolygons(pieces: PenPiece[], sides = 16): [number, number][][] {
  return pieces.map((piece) =>
    piece.kind === "band"
      ? piece.pts
      : Array.from({ length: sides }, (_, k): [number, number] => {
          const a = (2 * Math.PI * k) / sides;
          return [piece.x + Math.cos(a) * piece.r, piece.y + Math.sin(a) * piece.r];
        }),
  );
}
