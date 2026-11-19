// Small DXF drawings for the drawing viewer's tests (#384), written at
// runtime: group codes and values line by line as CAD programs write them
// (AutoCAD 2000 format, millimetres). The plan: a room 100 × 50 on layer
// "Wände" (red), a block "Stuhl" inserted twice (scaled, rotated, blue,
// one copy on layer "Möbel"), an arc, a text and an MTEXT, a solid hatch,
// a dashed line, an ellipse, a spline and lines on a layer that is off and
// one that is frozen. Everything lies inside the room, so the drawing's
// bounding box is the room.

type Pair = [number, string | number];
const lines = (pairs: Pair[]) => pairs.map(([code, value]) => `${String(code).padStart(3)}\n${value}`).join("\n");

const entity = (type: string, layer: string, ...rest: Pair[]): Pair[] => [[0, type], [8, layer], ...rest];

export type DxfOptions = { units?: number; extraEntities?: Pair[] };

export function dxfPlan(options: DxfOptions = {}): string {
  const units = options.units ?? 4;
  const layers: [string, number, number, string][] = [
    // name, colour (negative: off), flags (1: frozen), linetype
    ["0", 7, 0, "CONTINUOUS"],
    ["Wände", 1, 0, "CONTINUOUS"],
    ["Möbel", 5, 0, "CONTINUOUS"],
    ["Achsen", 3, 0, "DASHED"],
    ["Bemaßung", 2, 0, "CONTINUOUS"],
    ["Aus", -6, 0, "CONTINUOUS"],
    ["Gefroren", 4, 1, "CONTINUOUS"],
  ];
  const pairs: Pair[] = [
    [999, "Flowplan test drawing"],
    [0, "SECTION"],
    [2, "HEADER"],
    [9, "$ACADVER"],
    [1, "AC1015"],
    [9, "$INSUNITS"],
    [70, units],
    [9, "$LTSCALE"],
    [40, 1],
    [0, "ENDSEC"],
    [0, "SECTION"],
    [2, "TABLES"],
    [0, "TABLE"],
    [2, "LTYPE"],
    [70, 2],
    [0, "LTYPE"],
    [2, "CONTINUOUS"],
    [70, 0],
    [3, "Solid line"],
    [72, 65],
    [73, 0],
    [40, 0],
    [0, "LTYPE"],
    [2, "DASHED"],
    [70, 0],
    [3, "__ __ __"],
    [72, 65],
    [73, 2],
    [40, 6],
    [49, 4],
    [49, -2],
    [0, "ENDTAB"],
    [0, "TABLE"],
    [2, "LAYER"],
    [70, layers.length],
    ...layers.flatMap(([name, color, flags, lineType]): Pair[] => [
      [0, "LAYER"],
      [2, name],
      [70, flags],
      [62, color],
      [6, lineType],
    ]),
    [0, "ENDTAB"],
    [0, "ENDSEC"],
    [0, "SECTION"],
    [2, "BLOCKS"],
    // A chair: a 10 × 6 rectangle in BYBLOCK colour on layer 0 (takes the
    // reference's colour and layer) and a circle on its own layer.
    [0, "BLOCK"],
    [8, "0"],
    [2, "Stuhl"],
    [70, 0],
    [10, 0],
    [20, 0],
    [30, 0],
    [3, "Stuhl"],
    ...entity("LWPOLYLINE", "0", [62, 0], [90, 4], [70, 1], [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 6], [10, 0], [20, 6]),
    ...entity("CIRCLE", "Möbel", [62, 256], [10, 5], [20, 3], [30, 0], [40, 2]),
    [0, "ENDBLK"],
    [8, "0"],
    // A dimension's picture, as CAD programs store it.
    [0, "BLOCK"],
    [8, "0"],
    [2, "*D1"],
    [70, 1],
    [10, 0],
    [20, 0],
    [30, 0],
    [3, "*D1"],
    ...entity("LINE", "Bemaßung", [10, 0], [20, 45], [30, 0], [11, 100], [21, 45], [31, 0]),
    [0, "ENDBLK"],
    [8, "0"],
    [0, "ENDSEC"],
    [0, "SECTION"],
    [2, "ENTITIES"],
    // The room.
    ...entity("LWPOLYLINE", "Wände", [90, 4], [70, 1], [10, 0], [20, 0], [10, 100], [20, 0], [10, 100], [20, 50], [10, 0], [20, 50]),
    // Two chairs: one plain on layer 0 (white/black ink for BYBLOCK), one
    // at (60, 20), scaled 2 and turned 90°, blue, on layer "Möbel".
    ...entity("INSERT", "0", [2, "Stuhl"], [10, 10], [20, 10], [30, 0]),
    ...entity("INSERT", "Möbel", [62, 5], [2, "Stuhl"], [10, 60], [20, 20], [30, 0], [41, 2], [42, 2], [50, 90]),
    ...entity("ARC", "Wände", [10, 80], [20, 40], [30, 0], [40, 5], [50, 0], [51, 90]),
    ...entity("TEXT", "0", [10, 20], [20, 30], [30, 0], [40, 2.5], [1, "Wohnzimmer %%c 12"]),
    ...entity("MTEXT", "0", [10, 30], [20, 40], [30, 0], [40, 2], [71, 1], [1, "{\\fArial|b1;Erste Zeile}\\PZweite Zeile"]),
    ...entity(
      "HATCH",
      "Wände",
      [62, 8],
      [10, 0],
      [20, 0],
      [30, 0],
      [210, 0],
      [220, 0],
      [230, 1],
      [2, "SOLID"],
      [70, 1],
      [71, 0],
      [91, 1],
      [92, 2],
      [72, 0],
      [73, 1],
      [93, 4],
      [10, 90],
      [20, 2],
      [10, 98],
      [20, 2],
      [10, 98],
      [20, 8],
      [10, 90],
      [20, 8],
      [97, 0],
      [75, 0],
      [76, 1],
      [98, 0],
    ),
    ...entity("LINE", "Achsen", [10, 50], [20, 5], [30, 0], [11, 50], [21, 45], [31, 0]),
    ...entity("ELLIPSE", "Möbel", [10, 30], [20, 15], [30, 0], [11, 6], [21, 0], [31, 0], [40, 0.5], [41, 0], [42, 6.283185307179586]),
    ...entity("SPLINE", "Möbel", [70, 8], [71, 3], [72, 8], [73, 4], [40, 0], [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1], [40, 1], [10, 70], [20, 5], [10, 75], [20, 15], [10, 85], [20, 0], [10, 90], [20, 10]),
    ...entity("DIMENSION", "Bemaßung", [2, "*D1"], [10, 100], [20, 45], [30, 0], [70, 32]),
    ...entity("LINE", "Aus", [10, 5], [20, 5], [30, 0], [11, 15], [21, 5], [31, 0]),
    ...entity("LINE", "Gefroren", [10, 5], [20, 45], [30, 0], [11, 15], [21, 45], [31, 0]),
    ...(options.extraEntities || []),
    [0, "ENDSEC"],
    [0, "EOF"],
  ];
  return `${lines(pairs)}\n`;
}

// A file that starts like a DWG of the given version but is not one (for
// the "could not be read" path): the header, then noise.
export function fakeDwg(version = "AC1032", size = 4096): Buffer {
  const buffer = Buffer.alloc(size);
  buffer.write(version, 0, "latin1");
  for (let i = 6; i < size; i++) buffer[i] = (i * 31) & 255;
  return buffer;
}
