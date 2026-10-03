"use client";
// The workspace as a graph: pages are dots, links between them are lines.
// A small force layout places linked pages close together; drag to pan,
// scroll or pinch to zoom, click a page to open it.
import { useT } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Graph, MagnifyingGlass } from "@phosphor-icons/react";
import { api } from "./ui";

type Node = { id: string; title: string; icon: string; kind: string; links: number };
type Edge = { from: string; to: string; kind: "link" | "parent" };
type Point = { x: number; y: number; vx: number; vy: number };

// Deterministic start positions (a spiral), then repulsion between all
// pages, springs along edges and a pull to the middle.
export function layoutGraph(nodes: Node[], edges: Edge[], steps = 300) {
  const pos = new Map<string, Point>();
  nodes.forEach((node, i) => {
    const angle = i * 2.399963;
    const radius = 30 * Math.sqrt(i + 1);
    pos.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 });
  });
  const list = nodes.map((n) => pos.get(n.id)!);
  const springs: [Point, Point, number][] = [];
  for (const e of edges) {
    const a = pos.get(e.from),
      b = pos.get(e.to);
    if (a && b) springs.push([a, b, e.kind === "parent" ? 0.5 : 1]);
  }
  const many = list.length > 400;
  const linked = new Set(springs.flatMap(([a, b]) => [a, b]));
  for (let step = 0; step < steps; step++) {
    const cool = 1 - step / steps;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      // Large graphs: only a sample of pairs per step keeps it quick.
      for (let j = i + 1; j < list.length; j += many ? 1 + ((i + step) % 4) : 1) {
        const b = list[j];
        let dx = a.x - b.x,
          dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = 0.1;
          dy = 0.1;
          d2 = 0.02;
        }
        if (d2 > 250_000) continue;
        const force = 900 / d2;
        a.vx += dx * force;
        a.vy += dy * force;
        b.vx -= dx * force;
        b.vy -= dy * force;
      }
    }
    for (const [a, b, strength] of springs) {
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = ((d - 70) / d) * 0.04 * strength;
      a.vx += dx * force;
      a.vy += dy * force;
      b.vx -= dx * force;
      b.vy -= dy * force;
    }
    for (const p of list) {
      // Pages without links gather in a ring around the connected ones.
      const pull = linked.has(p) ? 0.004 : 0.012;
      p.vx -= p.x * pull;
      p.vy -= p.y * pull;
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const limit = 12 * cool + 0.5;
      if (speed > limit) {
        p.vx = (p.vx / speed) * limit;
        p.vy = (p.vy / speed) * limit;
      }
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.6;
      p.vy *= 0.6;
    }
  }
  return pos;
}

export function PageGraph({
  workspaceId,
  currentId,
  onOpen,
  onError,
}: {
  workspaceId: string;
  currentId?: string | null;
  onOpen: (id: string) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [graph, setGraph] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const [parents, setParents] = useState(false);
  const [orphans, setOrphans] = useState(true);
  const [filter, setFilter] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  useEffect(() => {
    api<{ nodes: Node[]; edges: Edge[] }>(`/api/graph?workspace=${workspaceId}`)
      .then(setGraph)
      .catch((e) => onError((e as Error).message));
  }, [workspaceId, onError]);
  const edges = useMemo(
    () => (graph?.edges || []).filter((e) => parents || e.kind === "link"),
    [graph, parents],
  );
  const nodes = useMemo(() => {
    if (!graph) return [];
    const connected = new Set(edges.flatMap((e) => [e.from, e.to]));
    return graph.nodes.filter((n) => orphans || connected.has(n.id) || n.id === currentId);
  }, [graph, edges, orphans, currentId]);
  const positions = useMemo(() => layoutGraph(nodes, edges), [nodes, edges]);
  // Fit the graph into view once it is laid out.
  useEffect(() => {
    if (!svg.current || !nodes.length) return;
    const xs = [...positions.values()].map((p) => p.x);
    const ys = [...positions.values()].map((p) => p.y);
    const width = svg.current.clientWidth || 800;
    const height = svg.current.clientHeight || 600;
    const spanX = Math.max(100, Math.max(...xs) - Math.min(...xs) + 120);
    const spanY = Math.max(100, Math.max(...ys) - Math.min(...ys) + 80);
    const k = Math.min(2, Math.max(0.2, Math.min(width / spanX, height / spanY)));
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    setView({ x: width / 2 - cx * k, y: height / 2 - cy * k, k });
  }, [positions, nodes.length]);
  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of edges) {
      (map.get(e.from) || map.set(e.from, new Set()).get(e.from)!).add(e.to);
      (map.get(e.to) || map.set(e.to, new Set()).get(e.to)!).add(e.from);
    }
    return map;
  }, [edges]);
  const needle = filter.trim().toLocaleLowerCase("de");
  const focus = hover || currentId || null;
  const near = focus ? neighbours.get(focus) : undefined;
  // Dots and labels keep their size on screen when zoomed out.
  const screen = 1 / Math.min(1, view.k);
  const radius = (n: Node) => (5 + Math.min(12, Math.sqrt(n.links) * 2.4)) * screen;
  const zoom = (factor: number, cx: number, cy: number) =>
    setView((v) => {
      const k = Math.min(4, Math.max(0.15, v.k * factor));
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  return (
    <div className="utility-content page-graph">
      <div className="utility-title">
        <Graph size={30} />
        <h1>{t("Graph", "Graph")}</h1>
        <p>{t("Wie deine Seiten miteinander verlinkt sind. Größere Punkte haben mehr Verbindungen.", "How your pages link to each other. Bigger dots have more connections.")}</p>
      </div>
      <div className="graph-toolbar">
        <label className="graph-search">
          <MagnifyingGlass size={15} />
          <input
            aria-label={t("Seiten im Graph hervorheben", "Highlight pages in the graph")}
            placeholder={t("Hervorheben …", "Highlight …")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <label className="graph-option">
          <input type="checkbox" checked={parents} onChange={(e) => setParents(e.target.checked)} />
          {t("Unterseiten verbinden", "Connect sub-pages")}
        </label>
        <label className="graph-option">
          <input type="checkbox" checked={orphans} onChange={(e) => setOrphans(e.target.checked)} />
          {t("Seiten ohne Verbindung", "Pages without connections")}
        </label>
        <span className="graph-count">
          {nodes.length} {t("Seiten ·", "pages ·")}{" "}{edges.filter((e) => e.kind === "link").length} {t("Links", "links")}
        </span>
      </div>
      {!graph ? (
        <p className="muted">{t("Graph wird berechnet …", "Computing graph …")}</p>
      ) : (
        <svg
          ref={svg}
          className="graph-canvas"
          role="img"
          aria-label={t(`Graph mit ${nodes.length} Seiten`, `Graph with ${nodes.length} pages`)}
          onWheel={(e) => {
            const rect = svg.current!.getBoundingClientRect();
            zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
          }}
          onPointerDown={(e) => {
            if ((e.target as Element).closest("[data-node]")) return;
            drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
            (e.target as Element).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            d.moved = true;
            setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {edges.map((edge) => {
              const a = positions.get(edge.from);
              const b = positions.get(edge.to);
              if (!a || !b) return null;
              const active = focus && (edge.from === focus || edge.to === focus);
              return (
                <line
                  key={`${edge.from}-${edge.to}-${edge.kind}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className={`graph-edge ${edge.kind}${active ? " active" : ""}${focus && !active ? " dim" : ""}`}
                />
              );
            })}
            {nodes.map((node) => {
              const p = positions.get(node.id)!;
              const match = needle && node.title.toLocaleLowerCase("de").includes(needle);
              const dim = (focus && node.id !== focus && !near?.has(node.id)) || (needle && !match);
              const showLabel = node.links > 0 || node.id === focus || near?.has(node.id) || match || view.k > 0.9;
              return (
                <g
                  key={node.id}
                  data-node=""
                  className={`graph-node kind-${node.kind}${node.id === currentId ? " current" : ""}${dim ? " dim" : ""}${match ? " match" : ""}`}
                  transform={`translate(${p.x} ${p.y})`}
                  role="link"
                  tabIndex={0}
                  aria-label={node.title}
                  onPointerEnter={() => setHover(node.id)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(node.id)}
                  onBlur={() => setHover(null)}
                  onClick={() => onOpen(node.id)}
                  onKeyDown={(e) => e.key === "Enter" && onOpen(node.id)}
                >
                  <circle r={radius(node)} />
                  {showLabel && (
                    <text y={radius(node) + 12 * screen} textAnchor="middle" style={{ fontSize: 11 * screen }}>
                      {node.title.length > 32 ? `${node.title.slice(0, 30)}…` : node.title}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}
