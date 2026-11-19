// Small 3D files for the 3D viewer's tests (#384), made at runtime: a binary
// STL cube and a STEP box (a closed B-rep solid in AP214, millimetres) that
// OpenCascade reads like a file from a CAD program.

type P = [number, number, number];
// The corners of a box from (0,0,0) to (x,y,z); corner i has bit 0 = x,
// bit 1 = y, bit 2 = z.
const corners = (x: number, y: number, z: number): P[] =>
  Array.from({ length: 8 }, (_, i) => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0] as P);
// The six faces as corner indices and their outward normal.
const FACES: { corners: number[]; normal: P }[] = [
  { corners: [0, 2, 3, 1], normal: [0, 0, -1] },
  { corners: [4, 5, 7, 6], normal: [0, 0, 1] },
  { corners: [0, 1, 5, 4], normal: [0, -1, 0] },
  { corners: [2, 6, 7, 3], normal: [0, 1, 0] },
  { corners: [0, 4, 6, 2], normal: [-1, 0, 0] },
  { corners: [1, 3, 7, 5], normal: [1, 0, 0] },
];

// A binary STL of a cube with edge `size`, centred on the origin.
export function stlCube(size = 20): Buffer {
  const h = size / 2;
  const points = corners(size, size, size).map((p) => p.map((v) => v - h) as P);
  const triangles: [P, P, P, P][] = [];
  for (const face of FACES) {
    const [a, b, c, d] = face.corners.map((i) => points[i]);
    triangles.push([face.normal, a, b, c], [face.normal, a, c, d]);
  }
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.write("Flowplan test cube", 0, "latin1");
  buffer.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, t) => {
    let at = 84 + t * 50;
    for (const vector of triangle)
      for (const value of vector) {
        buffer.writeFloatLE(value, at);
        at += 4;
      }
  });
  return buffer;
}

const real = (v: number) => (Number.isInteger(v) ? `${v}.` : String(v));
const triple = (p: P) => `(${p.map(real).join(",")})`;

// A STEP file of a box x × y × z mm with one corner at the origin.
export function stepBox(x = 30, y = 20, z = 10, name = "Box"): string {
  const lines: string[] = [];
  let n = 0;
  const add = (entity: string) => {
    lines.push(`#${++n}=${entity};`);
    return `#${n}`;
  };
  const context = add("APPLICATION_CONTEXT('automotive design')");
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${context})`);
  const productContext = add(`PRODUCT_CONTEXT('',${context},'mechanical')`);
  const product = add(`PRODUCT('${name}','${name}','',(${productContext}))`);
  const formation = add(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
  const definitionContext = add(`PRODUCT_DEFINITION_CONTEXT('part definition',${context},'design')`);
  const definition = add(`PRODUCT_DEFINITION('design','',${formation},${definitionContext})`);
  const shape = add(`PRODUCT_DEFINITION_SHAPE('','',${definition})`);
  const length = add("( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )");
  const angle = add("( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )");
  const solidAngle = add("( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )");
  const uncertainty = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${length},'distance_accuracy_value','confusion accuracy')`);
  const geometricContext = add(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${length},${angle},${solidAngle})) REPRESENTATION_CONTEXT('Context3D','3D context') )`,
  );

  const points = corners(x, y, z);
  const vertices = points.map((p) => add(`VERTEX_POINT('',${add(`CARTESIAN_POINT('',${triple(p)})`)})`));
  // Each edge once, from the lower corner index to the higher.
  const edges = new Map<string, string>();
  const edge = (a: number, b: number) => {
    const [from, to] = a < b ? [a, b] : [b, a];
    const key = `${from}-${to}`;
    if (!edges.has(key)) {
      const p = points[from],
        q = points[to];
      const d: P = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const len = Math.hypot(...d);
      const direction = add(`DIRECTION('',${triple(d.map((v) => v / len) as P)})`);
      const vector = add(`VECTOR('',${direction},${real(len)})`);
      const line = add(`LINE('',${add(`CARTESIAN_POINT('',${triple(p)})`)},${vector})`);
      edges.set(key, add(`EDGE_CURVE('',${vertices[from]},${vertices[to]},${line},.T.)`));
    }
    return { curve: edges.get(key)!, forward: a < b };
  };
  const faces = FACES.map((face) => {
    const loop = face.corners.map((a, i) => {
      const { curve, forward } = edge(a, face.corners[(i + 1) % 4]);
      return add(`ORIENTED_EDGE('',*,*,${curve},${forward ? ".T." : ".F."})`);
    });
    const bound = add(`FACE_OUTER_BOUND('',${add(`EDGE_LOOP('',(${loop.join(",")}))`)},.T.)`);
    const reference: P = Math.abs(face.normal[0]) > 0.5 ? [0, 1, 0] : [1, 0, 0];
    const placement = add(
      `AXIS2_PLACEMENT_3D('',${add(`CARTESIAN_POINT('',${triple(points[face.corners[0]])})`)},${add(`DIRECTION('',${triple(face.normal)})`)},${add(`DIRECTION('',${triple(reference)})`)})`,
    );
    return add(`ADVANCED_FACE('',(${bound}),${add(`PLANE('',${placement})`)},.T.)`);
  });
  const shell = add(`CLOSED_SHELL('',(${faces.join(",")}))`);
  const solid = add(`MANIFOLD_SOLID_BREP('${name}',${shell})`);
  const origin = add(
    `AXIS2_PLACEMENT_3D('',${add("CARTESIAN_POINT('',(0.,0.,0.))")},${add("DIRECTION('',(0.,0.,1.))")},${add("DIRECTION('',(1.,0.,0.))")})`,
  );
  const representation = add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${solid},${origin}),${geometricContext})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(${shape},${representation})`);
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('Flowplan test box'),'2;1');",
    `FILE_NAME('${name}.step','2026-01-01T00:00:00',(''),(''),'Flowplan tests','Flowplan tests','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;",
    "DATA;",
    ...lines,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}
