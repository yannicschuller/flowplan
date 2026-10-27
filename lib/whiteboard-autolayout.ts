// Automatic layout of diagrams on whiteboards: a layered ("Sugiyama")
// layout, top → bottom or left → right. Implemented here instead of a
// dependency: it is small, deterministic and testable.
//
//   1. cycles are broken by turning back edges around (found by a depth-first
//      search in the given order),
//   2. every node gets a layer (longest path from the sources; sources move
//      down next to their first successor),
//   3. edges over several layers get dummy nodes,
//   4. the order inside the layers is improved with barycentre sweeps
//      (nodes of the same group stay together),
//   5. positions: layers one after another, inside a layer the nodes move
//      towards their neighbours without overlapping.
import { connectorPoint, type WhiteboardItem } from "./whiteboard-model";

export type LayoutDirection = "TB" | "LR" | "BT" | "RL";
export type LayoutNode = { id: string; w: number; h: number; group?: string };
export type LayoutEdge = { from: string; to: string };
export type LayoutOptions = { direction?: LayoutDirection; rankGap?: number; nodeGap?: number };

type Inner = { id: string; size: number; depth: number; dummy: boolean; group?: string; layer: number; pos: number };

export function layeredLayout(nodes: LayoutNode[], edges: LayoutEdge[], options: LayoutOptions = {}) {
  const direction = options.direction || "TB";
  const vertical = direction === "TB" || direction === "BT";
  const rankGap = options.rankGap ?? 70,
    nodeGap = options.nodeGap ?? 40;
  const out = new Map<string, { x: number; y: number }>();
  if (!nodes.length) return out;
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  // "size" runs along a layer, "depth" across it.
  const inner: Inner[] = nodes.map((n) => ({
    id: n.id,
    size: vertical ? n.w : n.h,
    depth: vertical ? n.h : n.w,
    dummy: false,
    group: n.group,
    layer: 0,
    pos: 0,
  }));
  const valid = edges.filter((e) => index.has(e.from) && index.has(e.to) && e.from !== e.to);
  // Unique edges only.
  const seen = new Set<string>();
  const list = valid.filter((e) => {
    const key = `${e.from}\u0000${e.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 1. Cycles: back edges of a DFS in input order are turned around.
  const succ = new Map<number, number[]>();
  for (const e of list) succ.set(index.get(e.from)!, [...(succ.get(index.get(e.from)!) || []), index.get(e.to)!]);
  const state = new Uint8Array(nodes.length);
  const back = new Set<string>();
  for (let root = 0; root < nodes.length; root++) {
    if (state[root]) continue;
    const stack: { v: number; i: number }[] = [{ v: root, i: 0 }];
    state[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = succ.get(top.v) || [];
      if (top.i >= next.length) {
        state[top.v] = 2;
        stack.pop();
        continue;
      }
      const w = next[top.i++];
      if (state[w] === 1) back.add(`${top.v}:${w}`);
      else if (!state[w]) {
        state[w] = 1;
        stack.push({ v: w, i: 0 });
      }
    }
  }
  const dag: [number, number][] = list.map((e) => {
    const a = index.get(e.from)!,
      b = index.get(e.to)!;
    return back.has(`${a}:${b}`) ? [b, a] : [a, b];
  });

  // 2. Layers: longest path from the sources (Kahn's order).
  const outs = new Map<number, number[]>(),
    ins = new Map<number, number[]>();
  for (const [a, b] of dag) {
    outs.set(a, [...(outs.get(a) || []), b]);
    ins.set(b, [...(ins.get(b) || []), a]);
  }
  const indegree = inner.map((_, i) => ins.get(i)?.length || 0);
  const queue = inner.map((_, i) => i).filter((i) => !indegree[i]);
  const order: number[] = [];
  while (queue.length) {
    const v = queue.shift()!;
    order.push(v);
    for (const w of outs.get(v) || []) {
      inner[w].layer = Math.max(inner[w].layer, inner[v].layer + 1);
      if (!--indegree[w]) queue.push(w);
    }
  }
  // Sources sit right above their nearest successor.
  for (const v of [...order].reverse()) {
    if (ins.get(v)?.length) continue;
    const next = outs.get(v) || [];
    if (next.length) inner[v].layer = Math.max(0, Math.min(...next.map((w) => inner[w].layer)) - 1);
  }

  // 3. Dummy nodes for long edges.
  const links: [number, number][] = [];
  for (const [a, b] of dag) {
    let from = a;
    for (let layer = inner[a].layer + 1; layer < inner[b].layer; layer++) {
      inner.push({ id: `\u0000d${inner.length}`, size: 0, depth: 0, dummy: true, layer, pos: 0 });
      links.push([from, inner.length - 1]);
      from = inner.length - 1;
    }
    links.push([from, b]);
  }
  const layerCount = Math.max(...inner.map((n) => n.layer)) + 1;
  const layers: number[][] = Array.from({ length: layerCount }, () => []);
  // Initial order: depth-first from the sources, so trees start untangled.
  const down = new Map<number, number[]>(),
    up = new Map<number, number[]>();
  for (const [a, b] of links) {
    down.set(a, [...(down.get(a) || []), b]);
    up.set(b, [...(up.get(b) || []), a]);
  }
  const placed = new Uint8Array(inner.length);
  const visit = (v: number) => {
    const stack = [v];
    while (stack.length) {
      const x = stack.pop()!;
      if (placed[x]) continue;
      placed[x] = 1;
      layers[inner[x].layer].push(x);
      for (const w of [...(down.get(x) || [])].reverse()) stack.push(w);
    }
  };
  for (let i = 0; i < nodes.length; i++) if (!up.get(i)?.length) visit(i);
  for (let i = 0; i < inner.length; i++) if (!placed[i]) visit(i);
  const setPositions = () => layers.forEach((layer) => layer.forEach((v, i) => (inner[v].pos = i)));
  setPositions();

  // 4. Ordering: barycentre sweeps, keeping the best result.
  const crossings = () => {
    let count = 0;
    for (let l = 0; l + 1 < layerCount; l++) {
      const pairs = links.filter(([a]) => inner[a].layer === l).map(([a, b]) => [inner[a].pos, inner[b].pos]);
      for (let i = 0; i < pairs.length; i++)
        for (let j = i + 1; j < pairs.length; j++)
          if ((pairs[i][0] - pairs[j][0]) * (pairs[i][1] - pairs[j][1]) < 0) count++;
    }
    return count;
  };
  const sortLayer = (layer: number[], neighbours: Map<number, number[]>) => {
    const value = new Map<number, number>();
    for (const v of layer) {
      const ns = neighbours.get(v) || [];
      value.set(v, ns.length ? ns.reduce((s, n) => s + inner[n].pos, 0) / ns.length : inner[v].pos);
    }
    // Nodes of a group stay together, at the group's mean value.
    const groups = new Map<string, number[]>();
    for (const v of layer) if (inner[v].group) groups.set(inner[v].group!, [...(groups.get(inner[v].group!) || []), v]);
    const groupValue = new Map([...groups].map(([g, vs]) => [g, vs.reduce((s, v) => s + value.get(v)!, 0) / vs.length]));
    layer.sort((a, b) => {
      const ga = inner[a].group,
        gb = inner[b].group;
      const va = ga ? groupValue.get(ga)! : value.get(a)!,
        vb = gb ? groupValue.get(gb)! : value.get(b)!;
      return va - vb || (ga === gb ? value.get(a)! - value.get(b)! : (ga || "").localeCompare(gb || "")) || inner[a].pos - inner[b].pos;
    });
    layer.forEach((v, i) => (inner[v].pos = i));
  };
  let best = layers.map((l) => [...l]),
    bestCount = crossings();
  if (inner.length <= 1500)
    for (let round = 0; round < 12 && bestCount > 0; round++) {
      if (round % 2 === 0) for (let l = 1; l < layerCount; l++) sortLayer(layers[l], up);
      else for (let l = layerCount - 2; l >= 0; l--) sortLayer(layers[l], down);
      const count = crossings();
      if (count < bestCount) {
        bestCount = count;
        best = layers.map((l) => [...l]);
      }
    }
  best.forEach((l, i) => (layers[i] = l));
  setPositions();

  // 5. Coordinates along the layers: packed, then pulled towards the
  // neighbours (alternately from above and below), without overlaps.
  const at = new Float64Array(inner.length);
  const gapOf = (v: number) => (inner[v].dummy ? nodeGap / 3 : nodeGap);
  for (const layer of layers) {
    let x = 0;
    for (const v of layer) {
      at[v] = x + inner[v].size / 2;
      x += inner[v].size + gapOf(v);
    }
  }
  const relax = (layer: number[], neighbours: Map<number, number[]>) => {
    const want = layer.map((v) => {
      const ns = neighbours.get(v) || [];
      if (!ns.length) return at[v];
      const values = ns.map((n) => at[n]).sort((a, b) => a - b);
      const mid = Math.floor(values.length / 2);
      return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    });
    // The order stays, nothing overlaps, and the squared distance to the
    // wished positions is smallest: overlapping nodes form blocks that sit
    // at the mean of their wishes (pool adjacent violators).
    const distance = (i: number) => inner[layer[i - 1]].size / 2 + Math.max(gapOf(layer[i - 1]), gapOf(layer[i])) + inner[layer[i]].size / 2;
    type Block = { from: number; to: number; offsets: number[]; pos: number };
    const blocks: Block[] = [];
    const place = (b: Block) => {
      let sum = 0;
      for (let i = b.from; i <= b.to; i++) sum += want[i] - b.offsets[i - b.from];
      b.pos = sum / (b.to - b.from + 1);
    };
    for (let i = 0; i < layer.length; i++) {
      let block: Block = { from: i, to: i, offsets: [0], pos: want[i] };
      while (blocks.length) {
        const prev = blocks[blocks.length - 1];
        const prevEnd = prev.pos + prev.offsets[prev.offsets.length - 1];
        if (prevEnd + distance(block.from) <= block.pos + 1e-9) break;
        blocks.pop();
        const shift = prev.offsets[prev.offsets.length - 1] + distance(block.from);
        block = { from: prev.from, to: block.to, offsets: [...prev.offsets, ...block.offsets.map((o) => o + shift)], pos: 0 };
        place(block);
      }
      blocks.push(block);
    }
    for (const b of blocks) for (let i = b.from; i <= b.to; i++) at[layer[i]] = b.pos + b.offsets[i - b.from];
  };
  for (let round = 0; round < 8; round++) {
    if (round % 2 === 0) for (let l = 1; l < layerCount; l++) relax(layers[l], up);
    else for (let l = layerCount - 2; l >= 0; l--) relax(layers[l], down);
  }
  // Depth of the layers: the deepest node of each.
  const offsets: number[] = [];
  let depth = 0;
  for (let l = 0; l < layerCount; l++) {
    const deepest = Math.max(0, ...layers[l].map((v) => inner[v].depth));
    offsets.push(depth + deepest / 2);
    depth += deepest + rankGap;
  }
  const total = depth - rankGap;
  let min = Infinity;
  for (let v = 0; v < nodes.length; v++) min = Math.min(min, at[v] - inner[v].size / 2);
  for (let v = 0; v < nodes.length; v++) {
    const n = inner[v];
    const along = at[v] - min - n.size / 2;
    let across = offsets[n.layer] - n.depth / 2;
    if (direction === "BT" || direction === "RL") across = total - across - n.depth;
    out.set(
      n.id,
      vertical ? { x: Math.round(along), y: Math.round(across) } : { x: Math.round(across), y: Math.round(along) },
    );
  }
  return out;
}

// ---- on the board ----

const LAYOUT_TYPES = new Set(["sticky", "text", "shape", "card", "image", "emoji", "table"]);
// New positions for the selected diagram: the shapes among `ids` (or all
// shapes when `ids` is empty) and the connectors between them. The group
// keeps its top-left corner; connectors stay attached as they follow their
// items. Returns null when there is nothing to arrange.
export function autoLayoutItems(items: WhiteboardItem[], ids: Set<string> | null, direction: LayoutDirection) {
  const chosen = items.filter((i) => LAYOUT_TYPES.has(i.type) && !i.locked && (!ids || !ids.size || ids.has(i.id)));
  if (chosen.length < 2) return null;
  const set = new Set(chosen.map((i) => i.id));
  const edges = items
    .filter((i) => i.type === "connector" && i.from?.id && i.to?.id && set.has(i.from.id) && set.has(i.to.id))
    .map((i) => ({ from: i.from!.id!, to: i.to!.id! }));
  if (!edges.length) return null;
  // Keep the reading order of what is there: top to bottom, left to right.
  const sorted = [...chosen].sort((a, b) => (direction === "LR" || direction === "RL" ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x));
  const layout = layeredLayout(
    sorted.map((i) => ({ id: i.id, w: i.w, h: i.h })),
    edges,
    { direction, rankGap: 70, nodeGap: 48 },
  );
  const minX = Math.min(...chosen.map((i) => i.x)),
    minY = Math.min(...chosen.map((i) => i.y));
  return [...layout].map(([id, p]) => ({ id, x: p.x + minX, y: p.y + minY }));
}

// The direction a drawn diagram mostly runs (for "Als Mermaid kopieren").
export function mainDirection(items: WhiteboardItem[], map: Map<string, WhiteboardItem>): "TD" | "LR" {
  let dx = 0,
    dy = 0;
  for (const c of items)
    if (c.type === "connector" && c.from?.id && c.to?.id) {
      const a = connectorPoint(c.from, map),
        b = connectorPoint(c.to, map);
      dx += Math.abs(b.x - a.x);
      dy += Math.abs(b.y - a.y);
    }
  return dx > dy * 1.2 ? "LR" : "TD";
}
