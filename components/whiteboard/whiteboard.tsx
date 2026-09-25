"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as Y from "yjs";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  ArrowUpRight,
  ArrowsOut,
  CornersIn,
  CornersOut,
  Cursor,
  DownloadSimple,
  FileText,
  FrameCorners,
  Hand,
  ImageSquare,
  LockSimple,
  LockSimpleOpen,
  Minus,
  Note,
  PencilSimple,
  Plus,
  Shapes,
  Smiley,
  StackSimple,
  TextT,
  Trash,
  CopySimple,
  SquaresFour,
  Table,
  ChatCircle,
  ThumbsUp,
  Timer,
  PresentationChart,
  CaretLeft,
  CaretRight,
  X,
} from "@phosphor-icons/react";
import { Modal, api } from "../ui";
import { Select } from "../select";
import {
  templateItems,
  whiteboardTemplates,
  type WhiteboardTemplate,
} from "@/lib/whiteboard-templates";
import {
  WhiteboardDefs,
  WhiteboardShape,
  connectorGeometry,
  shapePath,
  contentBounds,
  type PageRef,
} from "./render";
import {
  fillColors,
  shapeKinds,
  stickyColors,
  strokeColors,
  type ConnectorEnd,
  type Point,
  type ShapeKind,
  type WhiteboardItem,
  type WhiteboardItemType,
  type WhiteboardMeta,
  emptyTable,
} from "@/lib/whiteboard-model";

const EmojiPicker = dynamic(() => import("../emoji-picker"), {
  ssr: false,
  loading: () => <p className="muted">Emojis werden geladen …</p>,
});
const LOCAL = "local";
const to64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const from64 = (text: string) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
type Tool =
  | "select"
  | "hand"
  | "sticky"
  | "text"
  | "shape"
  | "connector"
  | "pen"
  | "frame"
  | "table"
  | "comment";
type View = { x: number; y: number; zoom: number };
type Gesture =
  | { kind: "pan"; client: Point; view: View }
  | { kind: "marquee"; start: Point; current: Point; add: boolean }
  | {
      kind: "move";
      start: Point;
      origins: Map<string, { x: number; y: number; from?: Point; to?: Point }>;
      moved: boolean;
      clicked?: string;
    }
  | {
      kind: "resize";
      id: string;
      handle: string;
      start: Point;
      origin: { x: number; y: number; w: number; h: number };
    }
  | { kind: "rotate"; id: string; center: Point }
  | { kind: "create"; id: string; start: Point }
  | { kind: "connector"; id: string }
  | { kind: "pen"; id: string; points: Point[] };
const shapeNames: Record<ShapeKind, string> = {
  rectangle: "Rechteck",
  rounded: "Abgerundet",
  ellipse: "Ellipse",
  triangle: "Dreieck",
  diamond: "Raute",
  star: "Stern",
  hexagon: "Sechseck",
  parallelogram: "Parallelogramm",
  arrow: "Pfeilform",
  cloud: "Wolke",
};
const personColors = [
  "#e03131",
  "#1971c2",
  "#2f9e44",
  "#f08c00",
  "#7048e8",
  "#c2255c",
];
const colorFor = (id: string) =>
  personColors[
    [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) %
      personColors.length
  ];
let clipboard: WhiteboardItem[] = [];

export default function Whiteboard({
  pageId,
  state,
  generation,
  editable,
  pages,
  onReload,
  onError,
  onOpenPage,
  userId = "",
  userName = "",
}: {
  userId?: string;
  userName?: string;
  pageId: string;
  state: string;
  generation: string;
  editable: boolean;
  pages: PageRef[];
  onReload: () => void;
  onError: (message: string) => void;
  onOpenPage: (pageId: string) => void;
}) {
  const doc = useMemo(() => {
    const d = new Y.Doc();
    Y.applyUpdate(d, from64(state), "remote");
    return d;
    // The initial state only matters for this generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, generation]);
  const itemsMap = useMemo(() => doc.getMap<Y.Map<unknown>>("items"), [doc]);
  const read = useCallback(() => {
    const list: WhiteboardItem[] = [];
    itemsMap.forEach((value, key) => {
      if (value instanceof Y.Map)
        list.push({ ...(value.toJSON() as WhiteboardItem), id: key });
    });
    return list.sort((a, b) => (a.z || 0) - (b.z || 0));
  }, [itemsMap]);
  const [items, setItems] = useState<WhiteboardItem[]>(read);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const undo = useMemo(
    () =>
      new Y.UndoManager(itemsMap, {
        trackedOrigins: new Set([LOCAL]),
        captureTimeout: 400,
      }),
    [itemsMap],
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [cellEdit, setCellEdit] = useState<{
      id: string;
      r: number;
      c: number;
    } | null>(null),
    [commentOpen, setCommentOpen] = useState<string | null>(null),
    [showComments, setShowComments] = useState(true),
    [votingOpen, setVotingOpen] = useState(false),
    [timerOpen, setTimerOpen] = useState(false),
    [meta, setMeta] = useState<WhiteboardMeta>({}),
    [now, setNow] = useState(() => Date.now());
  // Full screen covers the page (dialogs stay visible) and, where the
  // browser allows it, hides the browser interface too.
  async function toggleFullscreen() {
    if (fullscreen) {
      setFullscreen(false);
      if (document.fullscreenElement)
        await document.exitFullscreen().catch(() => {});
    } else {
      setFullscreen(true);
      await document.documentElement.requestFullscreen?.().catch(() => {});
    }
    requestAnimationFrame(() =>
      container.current?.focus({ preventScroll: true }),
    );
  }
  useEffect(() => {
    const change = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  const [templatesOpen, setTemplatesOpen] = useState(false),
    [presenting, setPresenting] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>("select"),
    [shapeKind, setShapeKind] = useState<ShapeKind>("rectangle"),
    [stickyColor, setStickyColor] = useState(stickyColors[0]),
    [selection, setSelection] = useState<Set<string>>(new Set()),
    [editing, setEditing] = useState<string | null>(null),
    [view, setView] = useState<View>({ x: -80, y: -60, zoom: 1 }),
    [marquee, setMarquee] = useState<{ a: Point; b: Point } | null>(null),
    [presence, setPresence] = useState<
      { user_id: string; name: string; x: number; y: number }[]
    >([]),
    [shapeMenu, setShapeMenu] = useState(false),
    [emojiOpen, setEmojiOpen] = useState(false),
    [cardOpen, setCardOpen] = useState(false),
    [cardQuery, setCardQuery] = useState(""),
    [status, setStatus] = useState("Gespeichert"),
    [space, setSpace] = useState(false);
  const container = useRef<HTMLDivElement>(null),
    svg = useRef<SVGSVGElement>(null),
    gesture = useRef<Gesture | null>(null),
    pointers = useRef(new Map<number, Point>()),
    pinch = useRef<{ distance: number; center: Point; view: View } | null>(
      null,
    ),
    fileInput = useRef<HTMLInputElement>(null),
    dirty = useRef(false),
    lastVector = useRef<Uint8Array | null>(null),
    inflight = useRef(false),
    cursor = useRef<Point | null | undefined>(undefined);
  const viewRef = useRef(view);
  viewRef.current = view;
  // Board changes (own and remote) re-render once per frame.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setItems(read()));
    };
    itemsMap.observeDeep(update);
    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      if (origin !== "remote") {
        dirty.current = true;
        setStatus("Änderungen …");
      }
    };
    doc.on("update", onUpdate);
    setItems(read());
    return () => {
      cancelAnimationFrame(frame);
      itemsMap.unobserveDeep(update);
      doc.off("update", onUpdate);
    };
  }, [doc, itemsMap, read]);
  // Start with the whole board in view (or the last view on this device).
  useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`flowplan-board-view:${pageId}`) || "null",
      );
      if (saved && Number.isFinite(saved.zoom)) {
        setView(saved);
        return;
      }
    } catch {}
    fitToContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          `flowplan-board-view:${pageId}`,
          JSON.stringify(view),
        );
      } catch {}
    }, 400);
    return () => clearTimeout(timer);
  }, [view, pageId]);
  // Exchange with the server like documents do; cursors travel along.
  const sync = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    const send = editable && dirty.current;
    const vector = Y.encodeStateVector(doc);
    const update = send
      ? Y.encodeStateAsUpdate(doc, lastVector.current || undefined)
      : null;
    if (send) {
      dirty.current = false;
      setStatus("Speichern …");
    }
    const c = cursor.current;
    cursor.current = undefined;
    try {
      const result = await api<{
        state: string;
        presence: { user_id: string; name: string; x: number; y: number }[];
      }>("/api/command", {
        action: "whiteboard.sync",
        pageId,
        generation,
        ...(update ? { update: to64(update) } : {}),
        ...(c !== undefined ? { cursor: c } : {}),
      });
      Y.applyUpdate(doc, from64(result.state), "remote");
      if (send) lastVector.current = vector;
      setPresence(result.presence);
      setStatus(dirty.current ? "Änderungen …" : "Gespeichert");
    } catch (e) {
      if (send) dirty.current = true;
      const message = (e as Error).message;
      if (/neue Version/.test(message)) onReload();
      else {
        setStatus(navigator.onLine ? "Speichern fehlgeschlagen" : "Offline");
        if (navigator.onLine && send) onError(message);
      }
    } finally {
      inflight.current = false;
    }
  }, [doc, editable, generation, onError, onReload, pageId]);
  useEffect(() => {
    const timer = setInterval(() => void sync(), 900);
    const leave = () => {
      if (!editable || !dirty.current) return;
      const body = JSON.stringify({
        action: "whiteboard.sync",
        pageId,
        generation,
        update: to64(
          Y.encodeStateAsUpdate(doc, lastVector.current || undefined),
        ),
        cursor: null,
      });
      void fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: body.length < 60000,
      }).catch(() => {});
    };
    window.addEventListener("pagehide", leave);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [sync, doc, editable, generation, pageId]);

  // ---- coordinates ----
  const toWorld = useCallback((clientX: number, clientY: number): Point => {
    const rect = svg.current!.getBoundingClientRect(),
      v = viewRef.current;
    return {
      x: (clientX - rect.left) / v.zoom + v.x,
      y: (clientY - rect.top) / v.zoom + v.y,
    };
  }, []);
  const toScreen = (p: Point) => ({
    x: (p.x - view.x) * view.zoom,
    y: (p.y - view.y) * view.zoom,
  });
  // Inserts a ready-made board around the middle of the view.
  function insertTemplate(kind: WhiteboardTemplate) {
    const drafts = templateItems(kind);
    const box = contentBounds(
      drafts.map((d) => ({ ...d, z: 0 })),
      new Map(drafts.map((d) => [d.id, { ...d, z: 0 }])),
    );
    const at = center();
    const dx = at.x - (box ? box.x + box.w / 2 : 0),
      dy = at.y - (box ? box.y + box.h / 2 : 0);
    const ids = new Map(drafts.map((d) => [d.id, crypto.randomUUID()]));
    change(() => {
      const zs = read().map((i) => i.z || 0);
      let top = Math.max(0, ...zs),
        bottom = Math.min(0, ...zs);
      for (const d of drafts) {
        const map = new Y.Map<unknown>();
        const item: Partial<WhiteboardItem> = {
          ...d,
          x: d.x + dx,
          y: d.y + dy,
          z: d.type === "frame" ? --bottom : ++top,
          ...(d.type === "connector"
            ? {
                from: { ...d.from!, id: ids.get(d.from!.id!) },
                to: { ...d.to!, id: ids.get(d.to!.id!) },
              }
            : {}),
        };
        delete item.id;
        for (const [key, value] of Object.entries(item))
          if (value !== undefined) map.set(key, value);
        itemsMap.set(ids.get(d.id)!, map);
      }
    });
    setSelection(new Set(ids.values()));
    setTemplatesOpen(false);
  }
  // Presentation: frames in reading order, one at a time.
  const slides = items
    .filter((i) => i.type === "frame")
    .sort((a, b) => a.y - b.y || a.x - b.x);
  function showSlide(index: number) {
    const frame = slides[index];
    const rect = container.current?.getBoundingClientRect();
    if (!frame || !rect) return setPresenting(null);
    setPresenting(index);
    setSelection(new Set());
    setEditing(null);
    const zoom = Math.min(
      4,
      (rect.width - 80) / frame.w,
      (rect.height - 120) / (frame.h + 30),
    );
    setView({
      zoom,
      x: frame.x + frame.w / 2 - rect.width / zoom / 2,
      y: frame.y - 15 + frame.h / 2 - rect.height / zoom / 2,
    });
  }
  function fitToContent(list = read()) {
    const rect = container.current?.getBoundingClientRect();
    const box = contentBounds(list, new Map(list.map((i) => [i.id, i])));
    if (!rect || !box) return setView({ x: -80, y: -60, zoom: 1 });
    const zoom = Math.max(
      0.1,
      Math.min(2, (rect.width - 120) / box.w, (rect.height - 120) / box.h),
    );
    setView({
      zoom,
      x: box.x + box.w / 2 - rect.width / zoom / 2,
      y: box.y + box.h / 2 - rect.height / zoom / 2,
    });
  }
  const zoomAt = useCallback((factor: number, at?: Point) => {
    setView((v) => {
      const rect = svg.current?.getBoundingClientRect();
      const sx = at ? at.x : (rect?.width || 0) / 2,
        sy = at ? at.y : (rect?.height || 0) / 2;
      const zoom = Math.max(0.1, Math.min(4, v.zoom * factor));
      const wx = sx / v.zoom + v.x,
        wy = sy / v.zoom + v.y;
      return { zoom, x: wx - sx / zoom, y: wy - sy / zoom };
    });
  }, []);
  // Wheel: pinch or Ctrl zooms, otherwise the board scrolls.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey)
        zoomAt(Math.exp(-e.deltaY * 0.01), {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      else
        setView((v) => ({
          ...v,
          x: v.x + e.deltaX / v.zoom,
          y: v.y + e.deltaY / v.zoom,
        }));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
    // The canvas is a new element after entering or leaving full screen.
  }, [zoomAt, fullscreen]);

  // ---- editing the board ----
  const change = useCallback(
    (fn: () => void) => doc.transact(fn, LOCAL),
    [doc],
  );
  const setProps = useCallback(
    (id: string, props: Partial<WhiteboardItem>) => {
      const map = itemsMap.get(id);
      if (!map) return;
      for (const [key, value] of Object.entries(props))
        if (value === undefined) map.delete(key);
        else if (JSON.stringify(map.get(key)) !== JSON.stringify(value))
          map.set(key, value);
    },
    [itemsMap],
  );
  // Board-wide state (voting, timer) lives next to the items.
  const metaMap = useMemo(() => doc.getMap<unknown>("meta"), [doc]);
  useEffect(() => {
    const update = () => setMeta(metaMap.toJSON() as WhiteboardMeta);
    update();
    metaMap.observe(update);
    return () => metaMap.unobserve(update);
  }, [metaMap]);
  const setMetaValue = (key: keyof WhiteboardMeta, value: unknown) =>
    doc.transact(() => {
      if (value === undefined) metaMap.delete(key);
      else metaMap.set(key, value);
    }, LOCAL);
  function addMessage(id: string, text: string) {
    const map = itemsMap.get(id);
    if (!map || !text.trim()) return;
    change(() => {
      let list = map.get("messages");
      if (!(list instanceof Y.Array)) {
        list = new Y.Array();
        map.set("messages", list);
      }
      (list as Y.Array<unknown>).push([
        {
          id: crypto.randomUUID(),
          author: userId,
          name: userName || "Unbekannt",
          text: text.trim().slice(0, 5000),
          at: Date.now(),
        },
      ]);
    });
  }
  function closeComment() {
    const item = commentOpen ? itemsMap.get(commentOpen) : undefined;
    // A pin without any message is not kept.
    if (commentOpen && item && !(item.toJSON().messages || []).length)
      change(() => itemsMap.delete(commentOpen));
    setCommentOpen(null);
  }
  const myVotes = items.filter((i) => i.votes?.[userId]).length;
  function toggleVote(id: string) {
    const voting = meta.voting;
    const map = itemsMap.get(id);
    if (!voting?.active || !map || !userId) return;
    const has = !!(map.toJSON().votes || {})[userId];
    if (!has && myVotes >= voting.max)
      return onError(`Du hast alle ${voting.max} Stimmen vergeben.`);
    change(() => {
      let votes = map.get("votes");
      if (!(votes instanceof Y.Map)) {
        votes = new Y.Map();
        map.set("votes", votes);
      }
      if (has) (votes as Y.Map<unknown>).delete(userId);
      else (votes as Y.Map<unknown>).set(userId, true);
    });
  }
  function resetVotes() {
    change(() => itemsMap.forEach((map) => map.delete("votes")));
  }
  // The timer counts down from the moment someone starts it.
  const timer = meta.timer;
  const remaining = timer
    ? timer.endsAt
      ? Math.max(0, timer.endsAt - now)
      : timer.remaining
    : 0;
  useEffect(() => {
    if (!timer) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [timer]);
  const rang = useRef(false);
  useEffect(() => {
    if (!timer?.endsAt) {
      rang.current = false;
      return;
    }
    if (remaining > 0 || rang.current) return;
    rang.current = true;
    try {
      const audio = new AudioContext();
      const tone = audio.createOscillator(),
        gain = audio.createGain();
      tone.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.8);
      tone.connect(gain).connect(audio.destination);
      tone.start();
      tone.stop(audio.currentTime + 0.8);
    } catch {}
  }, [remaining, timer]);
  const startTimer = (ms: number) =>
    setMetaValue("timer", {
      endsAt: Date.now() + ms,
      remaining: ms,
      duration: ms,
    });
  const clock = (ms: number) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  function setCell(id: string, r: number, c: number, text: string) {
    const item = byId.get(id);
    if (!item) return;
    const cells = (item.cells?.length ? item.cells : [[""]]).map((row) => [
      ...row,
    ]);
    while (cells[r].length <= c) cells[r].push("");
    cells[r][c] = text.slice(0, 2000);
    change(() => setProps(id, { cells }));
  }
  function resizeTable(item: WhiteboardItem, rows: number, cols: number) {
    const cells = item.cells?.length ? item.cells : [[""]];
    const oldCols = Math.max(1, ...cells.map((r) => r.length));
    const nextRows = Math.max(1, Math.min(50, cells.length + rows)),
      nextCols = Math.max(1, Math.min(20, oldCols + cols));
    const next = Array.from({ length: nextRows }, (_, r) =>
      Array.from({ length: nextCols }, (_, c) => cells[r]?.[c] || ""),
    );
    change(() =>
      setProps(item.id, {
        cells: next,
        h: Math.round((item.h / cells.length) * nextRows),
        w: Math.round((item.w / oldCols) * nextCols),
      }),
    );
  }
  const addItem = useCallback(
    (item: Omit<WhiteboardItem, "id" | "z"> & { z?: number }) => {
      const id = crypto.randomUUID();
      const zs = read().map((i) => i.z || 0);
      const z =
        item.z ??
        (item.type === "frame"
          ? Math.min(0, ...zs) - 1
          : Math.max(0, ...zs) + 1);
      const map = new Y.Map<unknown>();
      for (const [key, value] of Object.entries({ ...item, z }))
        if (value !== undefined) map.set(key, value);
      itemsMap.set(id, map);
      return id;
    },
    [itemsMap, read],
  );
  const selected = items.filter((i) => selection.has(i.id));
  const removeSelected = () =>
    change(() => {
      for (const id of selection) {
        if (byId.get(id)?.locked) continue;
        itemsMap.delete(id);
        // Connectors attached to removed items keep their last position.
        for (const c of items)
          if (c.type === "connector") {
            const map = itemsMap.get(c.id);
            if (!map) continue;
            for (const end of ["from", "to"] as const) {
              const e = c[end];
              if (e?.id === id) {
                const target = byId.get(id)!;
                map.set(end, {
                  x: target.x + target.w / 2,
                  y: target.y + target.h / 2,
                });
              }
            }
          }
      }
    });
  const duplicate = (list = selected, offset = 24) => {
    const ids = new Map(list.map((i) => [i.id, crypto.randomUUID()]));
    const created: string[] = [];
    change(() => {
      const top = Math.max(0, ...read().map((i) => i.z || 0));
      list.forEach((item, n) => {
        const map = new Y.Map<unknown>();
        const copy: Partial<WhiteboardItem> = {
          ...item,
          x: item.x + offset,
          y: item.y + offset,
          z: item.type === "frame" ? item.z : top + 1 + n,
          locked: false,
        };
        if (item.type === "connector")
          for (const end of ["from", "to"] as const) {
            const e = item[end];
            if (e)
              copy[end] =
                e.id && ids.has(e.id)
                  ? { ...e, id: ids.get(e.id) }
                  : { x: e.x + offset, y: e.y + offset };
          }
        delete copy.id;
        for (const [key, value] of Object.entries(copy))
          if (value !== undefined) map.set(key, value);
        const nid = ids.get(item.id)!;
        itemsMap.set(nid, map);
        created.push(nid);
      });
    });
    setSelection(new Set(created));
  };
  const order = (front: boolean) =>
    change(() => {
      const zs = read().map((i) => i.z || 0);
      let next = front ? Math.max(0, ...zs) : Math.min(0, ...zs);
      for (const item of selected)
        setProps(item.id, { z: front ? ++next : --next });
    });
  function hitItem(p: Point, exclude?: string) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.id === exclude || it.type === "connector" || it.type === "pen")
        continue;
      if (
        p.x >= it.x &&
        p.x <= it.x + it.w &&
        p.y >= it.y &&
        p.y <= it.y + it.h
      )
        return it;
    }
    return undefined;
  }

  // ---- pointer handling ----
  function beginPan(e: ReactPointerEvent) {
    gesture.current = {
      kind: "pan",
      client: { x: e.clientX, y: e.clientY },
      view: viewRef.current,
    };
  }
  function onBackgroundDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (e.pointerType === "touch") {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        gesture.current = null;
        pinch.current = {
          distance: Math.hypot(a.x - b.x, a.y - b.y),
          center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          view: viewRef.current,
        };
        return;
      }
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    container.current?.focus({ preventScroll: true });
    if (editing) setEditing(null);
    const p = toWorld(e.clientX, e.clientY);
    if (e.button === 1 || tool === "hand" || space) return beginPan(e);
    if (!editable || tool === "select") {
      if (!editable || e.pointerType === "touch") return beginPan(e);
      gesture.current = {
        kind: "marquee",
        start: p,
        current: p,
        add: e.shiftKey,
      };
      if (!e.shiftKey) setSelection(new Set());
      return;
    }
    create(tool, p, e);
  }
  function create(kind: Tool, p: Point, e: ReactPointerEvent) {
    let id = "";
    change(() => {
      if (kind === "sticky")
        id = addItem({
          type: "sticky",
          x: p.x - 100,
          y: p.y - 100,
          w: 200,
          h: 200,
          fill: stickyColor,
          text: "",
        });
      else if (kind === "text")
        id = addItem({
          type: "text",
          x: p.x,
          y: p.y - 16,
          w: 240,
          h: 40,
          text: "",
          fontSize: 20,
          align: "left",
        });
      else if (kind === "shape")
        id = addItem({
          type: "shape",
          shape: shapeKind,
          x: p.x,
          y: p.y,
          w: 1,
          h: 1,
          fill: "#ffffff",
          stroke: "#1f2937",
          strokeWidth: 2,
          text: "",
        });
      else if (kind === "frame")
        id = addItem({
          type: "frame",
          x: p.x,
          y: p.y,
          w: 1,
          h: 1,
          text: "Rahmen",
          fill: "#ffffff",
        });
      else if (kind === "connector") {
        const hit = hitItem(p);
        const end: ConnectorEnd = hit
          ? { id: hit.id, x: p.x, y: p.y }
          : { x: p.x, y: p.y };
        id = addItem({
          type: "connector",
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          from: end,
          to: { x: p.x, y: p.y },
          stroke: "#1f2937",
          strokeWidth: 2,
          endArrow: true,
          route: "straight",
        });
      } else if (kind === "table")
        id = addItem({
          type: "table",
          x: p.x - 180,
          y: p.y - 60,
          w: 360,
          h: 120,
          cells: emptyTable(3, 3),
          header: true,
          fontSize: 14,
        });
      else if (kind === "comment") {
        id = addItem({
          type: "comment",
          x: p.x - 2,
          y: p.y - 32,
          w: 32,
          h: 32,
        });
        itemsMap.get(id)?.set("messages", new Y.Array());
      } else if (kind === "pen")
        id = addItem({
          type: "pen",
          x: p.x,
          y: p.y,
          w: 1,
          h: 1,
          points: [0, 0],
          stroke: strokeColors[0],
          strokeWidth: 3,
        });
    });
    if (!id) return;
    if (kind === "table" || kind === "comment") {
      setTool("select");
      setSelection(new Set([id]));
      gesture.current = null;
      if (kind === "comment") setCommentOpen(id);
      return;
    }
    if (kind === "sticky" || kind === "text") {
      setTool("select");
      setSelection(new Set([id]));
      setEditing(id);
      gesture.current = null;
      return;
    }
    if (kind === "connector") gesture.current = { kind: "connector", id };
    else if (kind === "pen") gesture.current = { kind: "pen", id, points: [p] };
    else gesture.current = { kind: "create", id, start: p };
    void e;
  }
  function onItemDown(e: ReactPointerEvent, item: WhiteboardItem) {
    if (e.button === 1 || tool === "hand" || space || !editable) return;
    if (tool !== "select") return; // creation tools work on top of items
    e.stopPropagation();
    if (e.pointerType === "touch")
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    svg.current?.setPointerCapture(e.pointerId);
    container.current?.focus({ preventScroll: true });
    const next = new Set(selection);
    if (e.shiftKey)
      next.has(item.id) ? next.delete(item.id) : next.add(item.id);
    else if (!next.has(item.id)) {
      next.clear();
      next.add(item.id);
    }
    setSelection(next);
    if (editing && editing !== item.id) setEditing(null);
    const start = toWorld(e.clientX, e.clientY);
    const origins = new Map<
      string,
      { x: number; y: number; from?: Point; to?: Point }
    >();
    const moving = items.filter((i) => next.has(i.id) && !i.locked);
    // Frames carry what lies inside them.
    for (const frame of moving.filter((i) => i.type === "frame"))
      for (const inner of items)
        if (
          inner.id !== frame.id &&
          !inner.locked &&
          inner.type !== "connector" &&
          inner.x >= frame.x &&
          inner.y >= frame.y &&
          inner.x + inner.w <= frame.x + frame.w &&
          inner.y + inner.h <= frame.y + frame.h
        )
          moving.push(inner);
    for (const i of moving)
      origins.set(i.id, {
        x: i.x,
        y: i.y,
        ...(i.type === "connector"
          ? {
              from:
                i.from && !i.from.id ? { x: i.from.x, y: i.from.y } : undefined,
              to: i.to && !i.to.id ? { x: i.to.x, y: i.to.y } : undefined,
            }
          : {}),
      });
    gesture.current = {
      kind: "move",
      start,
      origins,
      moved: false,
      clicked: item.id,
    };
  }
  function onHandleDown(
    e: ReactPointerEvent,
    item: WhiteboardItem,
    handle: string,
  ) {
    e.stopPropagation();
    svg.current?.setPointerCapture(e.pointerId);
    if (handle === "rotate")
      gesture.current = {
        kind: "rotate",
        id: item.id,
        center: { x: item.x + item.w / 2, y: item.y + item.h / 2 },
      };
    else if (handle === "from" || handle === "to")
      gesture.current = {
        kind: "connector",
        id: item.id,
        ...(handle === "from" ? { end: "from" } : {}),
      } as Gesture;
    else
      gesture.current = {
        kind: "resize",
        id: item.id,
        handle,
        start: toWorld(e.clientX, e.clientY),
        origin: { x: item.x, y: item.y, w: item.w, h: item.h },
      };
  }
  function onMove(e: ReactPointerEvent<SVGSVGElement>) {
    const p = toWorld(e.clientX, e.clientY);
    cursor.current = { x: Math.round(p.x), y: Math.round(p.y) };
    if (e.pointerType === "touch" && pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.current && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const start = pinch.current;
        const rect = svg.current!.getBoundingClientRect();
        const zoom = Math.max(
          0.1,
          Math.min(4, start.view.zoom * (distance / start.distance)),
        );
        const wx =
            (start.center.x - rect.left) / start.view.zoom + start.view.x,
          wy = (start.center.y - rect.top) / start.view.zoom + start.view.y;
        setView({
          zoom,
          x: wx - (center.x - rect.left) / zoom,
          y: wy - (center.y - rect.top) / zoom,
        });
        return;
      }
    }
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      setView({
        ...g.view,
        x: g.view.x - (e.clientX - g.client.x) / g.view.zoom,
        y: g.view.y - (e.clientY - g.client.y) / g.view.zoom,
      });
    } else if (g.kind === "marquee") {
      g.current = p;
      setMarquee({ a: g.start, b: p });
    } else if (g.kind === "move") {
      let dx = p.x - g.start.x,
        dy = p.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) * view.zoom < 3) return;
      g.moved = true;
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      change(() => {
        for (const [id, o] of g.origins) {
          const item = byId.get(id);
          if (item?.type === "connector") {
            if (o.from)
              setProps(id, { from: { x: o.from.x + dx, y: o.from.y + dy } });
            if (o.to) setProps(id, { to: { x: o.to.x + dx, y: o.to.y + dy } });
          } else
            setProps(id, { x: Math.round(o.x + dx), y: Math.round(o.y + dy) });
        }
      });
    } else if (g.kind === "resize") {
      const { origin, handle } = g;
      const dx = p.x - g.start.x,
        dy = p.y - g.start.y;
      let { x, y, w, h } = origin;
      if (handle.includes("e")) w = origin.w + dx;
      if (handle.includes("s")) h = origin.h + dy;
      if (handle.includes("w")) {
        w = origin.w - dx;
        x = origin.x + dx;
      }
      if (handle.includes("n")) {
        h = origin.h - dy;
        y = origin.y + dy;
      }
      const item = byId.get(g.id);
      if (
        (e.shiftKey ||
          item?.type === "sticky" ||
          item?.type === "image" ||
          item?.type === "emoji") &&
        handle.length === 2
      ) {
        const ratio = origin.w / origin.h || 1;
        if (w / h > ratio) w = h * ratio;
        else h = w / ratio;
        if (handle.includes("w")) x = origin.x + origin.w - w;
        if (handle.includes("n")) y = origin.y + origin.h - h;
      }
      change(() =>
        setProps(g.id, {
          x: Math.round(w < 20 ? origin.x : x),
          y: Math.round(h < 20 ? origin.y : y),
          w: Math.round(Math.max(20, w)),
          h: Math.round(Math.max(20, h)),
        }),
      );
    } else if (g.kind === "rotate") {
      let angle =
        (Math.atan2(p.y - g.center.y, p.x - g.center.x) * 180) / Math.PI + 90;
      if (e.shiftKey) angle = Math.round(angle / 15) * 15;
      change(() =>
        setProps(g.id, { rotation: Math.round(((angle % 360) + 360) % 360) }),
      );
    } else if (g.kind === "create") {
      const x = Math.min(g.start.x, p.x),
        y = Math.min(g.start.y, p.y);
      change(() =>
        setProps(g.id, {
          x: Math.round(x),
          y: Math.round(y),
          w: Math.round(Math.abs(p.x - g.start.x)),
          h: Math.round(Math.abs(p.y - g.start.y)),
        }),
      );
    } else if (g.kind === "connector") {
      const hit = hitItem(p, g.id);
      const end = (g as { end?: string }).end === "from" ? "from" : "to";
      change(() =>
        setProps(g.id, {
          [end]: hit
            ? { id: hit.id, x: p.x, y: p.y }
            : { x: Math.round(p.x), y: Math.round(p.y) },
        }),
      );
    } else if (g.kind === "pen") {
      g.points.push(p);
      const xs = g.points.map((q) => q.x),
        ys = g.points.map((q) => q.y);
      const x = Math.min(...xs),
        y = Math.min(...ys),
        w = Math.max(1, Math.max(...xs) - x),
        h = Math.max(1, Math.max(...ys) - y);
      change(() =>
        setProps(g.id, {
          x,
          y,
          w,
          h,
          points: g.points.flatMap((q) => [
            Math.round(((q.x - x) / w) * 1000) / 1000,
            Math.round(((q.y - y) / h) * 1000) / 1000,
          ]),
        }),
      );
    }
  }
  function onUp(e: ReactPointerEvent<SVGSVGElement>) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "move" && !g.moved && g.clicked) {
      if (byId.get(g.clicked)?.type === "comment") setCommentOpen(g.clicked);
    }
    if (g.kind === "marquee") {
      const a = g.start,
        b = g.current;
      const box = {
        x1: Math.min(a.x, b.x),
        y1: Math.min(a.y, b.y),
        x2: Math.max(a.x, b.x),
        y2: Math.max(a.y, b.y),
      };
      setMarquee(null);
      if (box.x2 - box.x1 < 2 && box.y2 - box.y1 < 2) return;
      const inside = items.filter((i) => {
        const bb =
          i.type === "connector"
            ? (() => {
                const { a: p1, b: p2 } = connectorGeometry(i, byId);
                return {
                  x: Math.min(p1.x, p2.x),
                  y: Math.min(p1.y, p2.y),
                  w: Math.abs(p1.x - p2.x),
                  h: Math.abs(p1.y - p2.y),
                };
              })()
            : i;
        return (
          bb.x >= box.x1 &&
          bb.y >= box.y1 &&
          bb.x + bb.w <= box.x2 &&
          bb.y + bb.h <= box.y2
        );
      });
      setSelection(
        (s) => new Set([...(g.add ? s : []), ...inside.map((i) => i.id)]),
      );
    } else if (g.kind === "create") {
      const item = byId.get(g.id);
      // A click without dragging gives a default size.
      if (item && item.w < 12 && item.h < 12)
        change(() =>
          setProps(
            g.id,
            item.type === "frame"
              ? { x: item.x - 300, y: item.y - 200, w: 600, h: 400 }
              : { x: item.x - 80, y: item.y - 50, w: 160, h: 100 },
          ),
        );
      setTool("select");
      setSelection(new Set([g.id]));
    } else if (g.kind === "connector") {
      const item = byId.get(g.id);
      if (
        item &&
        item.from &&
        item.to &&
        Math.hypot(item.from.x - item.to.x, item.from.y - item.to.y) < 4 &&
        !item.to.id
      )
        change(() =>
          setProps(g.id, { to: { x: item.from!.x + 160, y: item.from!.y } }),
        );
      setTool("select");
      setSelection(new Set([g.id]));
    }
  }
  function onDoubleClick(e: React.MouseEvent) {
    const p = toWorld(e.clientX, e.clientY);
    // Pointer capture sends the event to the canvas; find the item at the point.
    const target = document
      .elementsFromPoint(e.clientX, e.clientY)
      .map((el) => el.closest("[data-item]"))
      .find(Boolean)
      ?.getAttribute("data-item");
    const item = target ? byId.get(target) : undefined;
    if (item?.type === "card" && item.pageId) return onOpenPage(item.pageId);
    if (!editable) return;
    if (item?.type === "table" && !item.locked) {
      const cells = item.cells?.length ? item.cells : [[""]];
      const cols = Math.max(1, ...cells.map((r) => r.length));
      setSelection(new Set([item.id]));
      setCellEdit({
        id: item.id,
        r: Math.min(
          cells.length - 1,
          Math.max(0, Math.floor(((p.y - item.y) / item.h) * cells.length)),
        ),
        c: Math.min(
          cols - 1,
          Math.max(0, Math.floor(((p.x - item.x) / item.w) * cols)),
        ),
      });
      return;
    }
    if (item?.type === "comment") {
      setCommentOpen(item.id);
      return;
    }
    if (
      item &&
      !item.locked &&
      ["sticky", "text", "shape", "frame", "connector"].includes(item.type)
    ) {
      setSelection(new Set([item.id]));
      setEditing(item.id);
      return;
    }
    if (!item) {
      let id = "";
      change(() => {
        id = addItem({
          type: "sticky",
          x: p.x - 100,
          y: p.y - 100,
          w: 200,
          h: 200,
          fill: stickyColor,
          text: "",
        });
      });
      setSelection(new Set([id]));
      setEditing(id);
    }
  }

  // ---- keyboard, clipboard, files ----
  function onKeyDown(e: React.KeyboardEvent) {
    if (
      editing ||
      (e.target as HTMLElement).closest(
        "input, textarea, select, [contenteditable=true]",
      )
    )
      return;
    if (presenting !== null) {
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)) {
        e.preventDefault();
        showSlide(Math.min(slides.length - 1, presenting + 1));
      } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) {
        e.preventDefault();
        showSlide(Math.max(0, presenting - 1));
      } else if (e.key === "Escape") setPresenting(null);
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === " ") {
      setSpace(true);
      e.preventDefault();
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (!editable) return;
      if (e.shiftKey) undo.redo();
      else undo.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      if (editable) undo.redo();
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelection(new Set(items.map((i) => i.id)));
      return;
    }
    if (mod && e.key.toLowerCase() === "d" && editable) {
      e.preventDefault();
      duplicate();
      return;
    }
    if (mod && e.key.toLowerCase() === "c") {
      clipboard = selected.map((i) => ({ ...i }));
      return;
    }
    if (mod && e.key.toLowerCase() === "v" && editable && clipboard.length) {
      e.preventDefault();
      duplicate(clipboard, 40);
      return;
    }
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      editable &&
      selection.size
    ) {
      e.preventDefault();
      removeSelected();
      setSelection(new Set());
      return;
    }
    if (e.key === "Escape") {
      if (!selection.size && tool === "select" && fullscreen)
        void toggleFullscreen();
      setSelection(new Set());
      setTool("select");
      return;
    }
    if (e.key === "Enter" && selection.size === 1 && editable) {
      e.preventDefault();
      setEditing([...selection][0]);
      return;
    }
    if (e.key.startsWith("Arrow") && selection.size && editable) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx =
          e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
        dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      change(() => {
        for (const i of selected)
          if (!i.locked && i.type !== "connector")
            setProps(i.id, { x: i.x + dx, y: i.y + dy });
      });
      return;
    }
    if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      zoomAt(1.2);
      return;
    }
    if (mod && e.key === "-") {
      e.preventDefault();
      zoomAt(1 / 1.2);
      return;
    }
    if (e.shiftKey && e.key === "!") return fitToContent();
    if (mod || e.altKey) return;
    const keys: Record<string, Tool> = {
      v: "select",
      h: "hand",
      n: "sticky",
      s: "sticky",
      t: "text",
      r: "shape",
      l: "connector",
      p: "pen",
      f: "frame",
      g: "table",
      c: "comment",
    };
    const next = keys[e.key.toLowerCase()];
    if (next && (editable || next === "select" || next === "hand"))
      setTool(next);
  }
  async function upload(file: File) {
    const body = new FormData();
    body.set("pageId", pageId);
    body.set("file", file);
    const response = await fetch("/api/upload", { method: "POST", body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Upload fehlgeschlagen.");
    return result.url as string;
  }
  const center = () => {
    const rect = svg.current!.getBoundingClientRect();
    return toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  };
  async function addImage(file: File, at = center()) {
    if (!file.type.startsWith("image/"))
      return onError("Nur Bilder können auf das Whiteboard gelegt werden.");
    try {
      setStatus("Bild wird hochgeladen …");
      const url = await upload(file);
      const size = await new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image();
        img.onload = () =>
          resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 400, h: 300 });
        img.src = url;
      });
      const scale = Math.min(1, 480 / Math.max(size.w, size.h));
      let id = "";
      change(() => {
        id = addItem({
          type: "image",
          src: url,
          x: at.x - (size.w * scale) / 2,
          y: at.y - (size.h * scale) / 2,
          w: Math.round(size.w * scale),
          h: Math.round(size.h * scale),
        });
      });
      setSelection(new Set([id]));
    } catch (e) {
      onError((e as Error).message);
    }
  }
  function onPaste(e: React.ClipboardEvent) {
    if (!editable || editing) return;
    const file = [...e.clipboardData.files].find((f) =>
      f.type.startsWith("image/"),
    );
    if (file) {
      e.preventDefault();
      void addImage(file);
      return;
    }
    const text = e.clipboardData.getData("text/plain").trim();
    if (text && !clipboard.length) {
      e.preventDefault();
      const at = center();
      let id = "";
      change(() => {
        id = addItem({
          type: "text",
          x: at.x - 120,
          y: at.y - 20,
          w: 240,
          h: 40,
          text: text.slice(0, 5000),
          fontSize: 20,
          align: "left",
        });
      });
      setSelection(new Set([id]));
    }
  }
  function exportBoard(kind: "svg" | "png") {
    const node = svg.current;
    const box = contentBounds(items, byId);
    if (!node || !box) return onError("Das Whiteboard ist leer.");
    const clone = node.cloneNode(true) as SVGSVGElement;
    clone.querySelectorAll("[data-ui]").forEach((el) => el.remove());
    const world = clone.querySelector("[data-world]");
    world?.removeAttribute("transform");
    const pad = 40;
    clone.setAttribute(
      "viewBox",
      `${box.x - pad} ${box.y - pad} ${box.w + pad * 2} ${box.h + pad * 2}`,
    );
    clone.setAttribute("width", String(Math.round(box.w + pad * 2)));
    clone.setAttribute("height", String(Math.round(box.h + pad * 2)));
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const style = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "style",
    );
    style.textContent =
      ".wb-text{width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;white-space:pre-wrap;word-break:break-word;font-family:system-ui,sans-serif;box-sizing:border-box}.wb-frame-title{font:600 14px system-ui;color:#495057}.wb-card-body{display:flex;flex-direction:column;justify-content:center;height:100%;font:14px system-ui}.wb-card-body small{color:#868e96}.wb-emoji-glyph{display:flex;align-items:center;justify-content:center;height:100%}";
    clone.prepend(style);
    const source = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([source], { type: "image/svg+xml" });
    const save = (b: Blob, ext: string) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `whiteboard.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    if (kind === "svg") return save(blob, "svg");
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const scale = Math.min(2, 8000 / Math.max(img.width, img.height));
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      try {
        canvas.toBlob((b) => b && save(b, "png"));
      } catch {
        onError(
          "Der Browser erlaubt keinen PNG-Export dieses Boards. Bitte SVG verwenden.",
        );
      }
    };
    img.onerror = () =>
      onError("PNG-Export fehlgeschlagen. Bitte SVG verwenden.");
    img.src = URL.createObjectURL(blob);
  }

  // ---- rendering ----
  const frames = items.filter((i) => i.type === "frame"),
    others = items.filter((i) => i.type !== "frame");
  const single = selected.length === 1 ? selected[0] : null;
  const selectionBox = selected.length ? contentBounds(selected, byId) : null;
  const editingItem = editing ? byId.get(editing) : undefined;
  const cursorStyle =
    tool === "hand" || space
      ? gesture.current?.kind === "pan"
        ? "grabbing"
        : "grab"
      : tool === "select"
        ? "default"
        : "crosshair";
  const handle = (item: WhiteboardItem, name: string, x: number, y: number) => (
    <rect
      key={name}
      data-ui
      className={`wb-handle wb-handle-${name}`}
      x={x - 5 / view.zoom}
      y={y - 5 / view.zoom}
      width={10 / view.zoom}
      height={10 / view.zoom}
      rx={2 / view.zoom}
      onPointerDown={(e) => onHandleDown(e, item, name)}
    />
  );
  const stylePanel =
    editable &&
    selected.length > 0 &&
    selected.some((i) => i.type !== "comment") &&
    !gesture.current &&
    selectionBox &&
    (() => {
      const s = toScreen({ x: selectionBox.x, y: selectionBox.y - 30 });
      const types = new Set(selected.map((i) => i.type));
      const first = selected[0];
      const set = (props: Partial<WhiteboardItem>) =>
        change(() =>
          selected.forEach((i) => !i.locked && setProps(i.id, props)),
        );
      return (
        <div
          className="wb-style-bar"
          role="toolbar"
          aria-label="Element gestalten"
          style={{ left: Math.max(8, s.x), top: Math.max(8, s.y - 44) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {types.has("sticky") &&
            stickyColors.map((c) => (
              <button
                key={c}
                className={`wb-swatch${first.fill === c ? " active" : ""}`}
                style={{ background: c }}
                aria-label={`Farbe ${c}`}
                onClick={() => set({ fill: c })}
              />
            ))}
          {(types.has("shape") || types.has("frame")) &&
            fillColors.map((c) => (
              <button
                key={c}
                className={`wb-swatch${first.fill === c ? " active" : ""}${c === "transparent" ? " none" : ""}`}
                style={{ background: c }}
                aria-label={`Füllung ${c}`}
                onClick={() => set({ fill: c })}
              />
            ))}
          {(types.has("shape") ||
            types.has("connector") ||
            types.has("pen")) && (
            <>
              <span className="wb-sep" />
              {strokeColors.map((c) => (
                <button
                  key={c}
                  className={`wb-swatch line${first.stroke === c ? " active" : ""}`}
                  style={{ borderColor: c }}
                  aria-label={`Linienfarbe ${c}`}
                  onClick={() => set({ stroke: c })}
                />
              ))}
              <Select
                aria-label="Linienstärke"
                value={first.strokeWidth ?? 2}
                onChange={(e) => set({ strokeWidth: Number(e.target.value) })}
              >
                {[1, 2, 3, 5, 8].map((w) => (
                  <option key={w} value={w}>
                    {w} px
                  </option>
                ))}
              </Select>
            </>
          )}
          {(types.has("sticky") || types.has("text") || types.has("shape")) && (
            <>
              <span className="wb-sep" />
              <Select
                aria-label="Schriftgröße"
                value={first.fontSize || 16}
                onChange={(e) => set({ fontSize: Number(e.target.value) })}
              >
                {[12, 14, 16, 20, 24, 32, 48, 64].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
              <button
                className={first.bold ? "active" : ""}
                aria-pressed={!!first.bold}
                aria-label="Fett"
                onClick={() => set({ bold: !first.bold })}
              >
                <strong>F</strong>
              </button>
              <Select
                aria-label="Ausrichtung"
                value={
                  first.align || (first.type === "text" ? "left" : "center")
                }
                onChange={(e) =>
                  set({ align: e.target.value as WhiteboardItem["align"] })
                }
              >
                <option value="left">Links</option>
                <option value="center">Mitte</option>
                <option value="right">Rechts</option>
              </Select>
              {strokeColors.slice(0, 6).map((c) => (
                <button
                  key={`text-${c}`}
                  className={`wb-text-swatch${(first.textColor || "#1f2937") === c ? " active" : ""}`}
                  style={{ color: c }}
                  aria-label={`Textfarbe ${c}`}
                  onClick={() => set({ textColor: c })}
                >
                  A
                </button>
              ))}
            </>
          )}
          {types.has("shape") && types.size === 1 && (
            <Select
              aria-label="Form"
              value={first.shape || "rectangle"}
              onChange={(e) => set({ shape: e.target.value as ShapeKind })}
            >
              {shapeKinds.map((k) => (
                <option key={k} value={k}>
                  {shapeNames[k]}
                </option>
              ))}
            </Select>
          )}
          {types.has("connector") && types.size === 1 && (
            <>
              <Select
                aria-label="Linienverlauf"
                value={first.route || "straight"}
                onChange={(e) =>
                  set({ route: e.target.value as WhiteboardItem["route"] })
                }
              >
                <option value="straight">Gerade</option>
                <option value="elbow">Gewinkelt</option>
                <option value="curved">Geschwungen</option>
              </Select>
              <button
                className={first.startArrow ? "active" : ""}
                aria-pressed={!!first.startArrow}
                onClick={() => set({ startArrow: !first.startArrow })}
              >
                ← Pfeil
              </button>
              <button
                className={first.endArrow !== false ? "active" : ""}
                aria-pressed={first.endArrow !== false}
                onClick={() => set({ endArrow: first.endArrow === false })}
              >
                Pfeil →
              </button>
              <button
                className={first.dashed ? "active" : ""}
                aria-pressed={!!first.dashed}
                onClick={() => set({ dashed: !first.dashed })}
              >
                Gestrichelt
              </button>
            </>
          )}
          {types.has("table") && types.size === 1 && (
            <>
              <span className="wb-sep" />
              <button onClick={() => resizeTable(first, 1, 0)}>+ Zeile</button>
              <button onClick={() => resizeTable(first, -1, 0)}>− Zeile</button>
              <button onClick={() => resizeTable(first, 0, 1)}>+ Spalte</button>
              <button onClick={() => resizeTable(first, 0, -1)}>
                − Spalte
              </button>
              <button
                className={first.header !== false ? "active" : ""}
                aria-pressed={first.header !== false}
                onClick={() => set({ header: first.header === false })}
              >
                Kopfzeile
              </button>
            </>
          )}
          <span className="wb-sep" />
          <button
            aria-label="Nach vorne"
            title="Nach vorne"
            onClick={() => order(true)}
          >
            <StackSimple size={16} />
          </button>
          <button
            aria-label="Nach hinten"
            title="Nach hinten"
            onClick={() => order(false)}
          >
            <StackSimple size={16} style={{ transform: "scaleY(-1)" }} />
          </button>
          <button
            aria-label="Duplizieren"
            title="Duplizieren (⌘D)"
            onClick={() => duplicate()}
          >
            <CopySimple size={16} />
          </button>
          <button
            aria-label={first.locked ? "Entsperren" : "Sperren"}
            title={first.locked ? "Entsperren" : "Sperren"}
            onClick={() =>
              change(() =>
                selected.forEach((i) =>
                  setProps(i.id, { locked: !first.locked }),
                ),
              )
            }
          >
            {first.locked ? (
              <LockSimpleOpen size={16} />
            ) : (
              <LockSimple size={16} />
            )}
          </button>
          <button
            aria-label="Löschen"
            title="Löschen (Entf)"
            onClick={() => {
              removeSelected();
              setSelection(new Set());
            }}
          >
            <Trash size={16} />
          </button>
        </div>
      );
    })();
  const editor =
    editingItem &&
    (() => {
      const it = editingItem;
      let box: { x: number; y: number; w: number; h: number };
      if (it.type === "connector") {
        const { a, b } = connectorGeometry(it, byId);
        box = {
          x: (a.x + b.x) / 2 - 80,
          y: (a.y + b.y) / 2 - 14,
          w: 160,
          h: 28,
        };
      } else if (it.type === "frame")
        box = { x: it.x, y: it.y - 28, w: it.w, h: 26 };
      else box = it;
      const s = toScreen(box);
      return (
        <textarea
          className={`wb-editor wb-editor-${it.type}`}
          aria-label="Text bearbeiten"
          autoFocus
          style={{
            left: s.x,
            top: s.y,
            width: box.w * view.zoom,
            height: box.h * view.zoom,
            fontSize:
              (it.type === "frame"
                ? 14
                : it.type === "connector"
                  ? 13
                  : it.fontSize || 16) * view.zoom,
            fontWeight: it.bold ? 700 : undefined,
            textAlign:
              it.type === "text" ? it.align || "left" : it.align || "center",
            color: it.textColor || "#1f2937",
            transform: it.rotation ? `rotate(${it.rotation}deg)` : undefined,
            padding:
              (it.type === "text"
                ? 2
                : it.type === "frame" || it.type === "connector"
                  ? 2
                  : 10) * view.zoom,
          }}
          defaultValue={it.text || ""}
          onChange={(e) =>
            change(() =>
              setProps(it.id, { text: e.target.value.slice(0, 10000) }),
            )
          }
          onBlur={() => setEditing(null)}
          onKeyDown={(e) => {
            if (
              e.key === "Escape" ||
              (e.key === "Enter" && (e.metaKey || e.ctrlKey))
            ) {
              e.preventDefault();
              setEditing(null);
              container.current?.focus();
            }
            e.stopPropagation();
          }}
        />
      );
    })();
  const tools: [Tool, string, React.ReactNode, string][] = [
    ["select", "Auswählen", <Cursor key="s" size={18} />, "V"],
    ["hand", "Verschieben", <Hand key="h" size={18} />, "H"],
    ...(editable
      ? ([
          ["sticky", "Notizzettel", <Note key="n" size={18} />, "N"],
          ["text", "Text", <TextT key="t" size={18} />, "T"],
          ["shape", "Form", <Shapes key="r" size={18} />, "R"],
          [
            "connector",
            "Verbindungslinie",
            <ArrowUpRight key="l" size={18} />,
            "L",
          ],
          ["pen", "Stift", <PencilSimple key="p" size={18} />, "P"],
          ["frame", "Rahmen", <FrameCorners key="f" size={18} />, "F"],
          ["table", "Tabelle", <Table key="g" size={18} />, "G"],
          ["comment", "Kommentar", <ChatCircle key="c" size={18} />, "C"],
        ] as [Tool, string, React.ReactNode, string][])
      : []),
  ];
  const cardPages = pages
    .filter(
      (p) =>
        p.id !== pageId &&
        p.title
          .toLocaleLowerCase("de")
          .includes(cardQuery.toLocaleLowerCase("de")),
    )
    .slice(0, 60);
  const board = (
    <div
      ref={container}
      className={`whiteboard${fullscreen ? " wb-fullscreen" : ""}`}
      tabIndex={0}
      aria-label="Whiteboard"
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.key === " " && setSpace(false)}
      onPaste={onPaste}
      onDragOver={(e) =>
        editable && e.dataTransfer.types.includes("Files") && e.preventDefault()
      }
      onDrop={(e) => {
        const file = [...e.dataTransfer.files].find((f) =>
          f.type.startsWith("image/"),
        );
        if (!editable || !file) return;
        e.preventDefault();
        void addImage(file, toWorld(e.clientX, e.clientY));
      }}
    >
      <svg
        ref={svg}
        className="wb-canvas"
        style={{ cursor: cursorStyle }}
        onPointerDown={onBackgroundDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => (cursor.current = null)}
        onDoubleClick={onDoubleClick}
      >
        <WhiteboardDefs />
        <rect
          data-ui
          x={0}
          y={0}
          width="100%"
          height="100%"
          fill="url(#wb-grid)"
          style={{
            transform: `translate(${(-view.x * view.zoom) % (24 * view.zoom)}px, ${(-view.y * view.zoom) % (24 * view.zoom)}px) scale(${view.zoom})`,
            transformOrigin: "0 0",
          }}
          className="wb-grid"
        />
        <g
          data-world
          transform={`scale(${view.zoom}) translate(${-view.x} ${-view.y})`}
        >
          {[...frames, ...others]
            .filter((item) => showComments || item.type !== "comment")
            .map((item) => (
              <g
                key={item.id}
                data-item={item.id}
                className={`wb-item wb-${item.type}${selection.has(item.id) ? " selected" : ""}${item.locked ? " locked" : ""}`}
                onPointerDown={(e) => onItemDown(e, item)}
              >
                <WhiteboardShape
                  item={item}
                  items={byId}
                  pages={pages}
                  editing={editing === item.id ? "" : undefined}
                />
              </g>
            ))}
          {selectionBox && (
            <rect
              data-ui
              className="wb-selection"
              x={selectionBox.x - 4 / view.zoom}
              y={selectionBox.y - 4 / view.zoom}
              width={selectionBox.w + 8 / view.zoom}
              height={selectionBox.h + 8 / view.zoom}
              strokeWidth={1.5 / view.zoom}
            />
          )}
          {editable &&
            single &&
            !single.locked &&
            single.type !== "connector" &&
            single.type !== "pen" &&
            single.type !== "comment" &&
            !editing && (
              <g data-ui>
                {handle(single, "nw", single.x, single.y)}
                {handle(single, "ne", single.x + single.w, single.y)}
                {handle(single, "sw", single.x, single.y + single.h)}
                {handle(single, "se", single.x + single.w, single.y + single.h)}
                {single.type !== "sticky" &&
                  single.type !== "image" &&
                  single.type !== "emoji" && (
                    <>
                      {handle(single, "n", single.x + single.w / 2, single.y)}
                      {handle(
                        single,
                        "s",
                        single.x + single.w / 2,
                        single.y + single.h,
                      )}
                      {handle(single, "w", single.x, single.y + single.h / 2)}
                      {handle(
                        single,
                        "e",
                        single.x + single.w,
                        single.y + single.h / 2,
                      )}
                    </>
                  )}
                {single.type !== "frame" && (
                  <circle
                    className="wb-handle wb-rotate"
                    cx={single.x + single.w / 2}
                    cy={single.y - 28 / view.zoom}
                    r={6 / view.zoom}
                    onPointerDown={(e) => onHandleDown(e, single, "rotate")}
                  >
                    <title>Drehen</title>
                  </circle>
                )}
              </g>
            )}
          {editable &&
            single?.type === "connector" &&
            !single.locked &&
            (() => {
              const { a, b } = connectorGeometry(single, byId);
              return (
                <g data-ui>
                  {handle(single, "from", a.x, a.y)}
                  {handle(single, "to", b.x, b.y)}
                </g>
              );
            })()}
          {marquee && (
            <rect
              data-ui
              className="wb-marquee"
              x={Math.min(marquee.a.x, marquee.b.x)}
              y={Math.min(marquee.a.y, marquee.b.y)}
              width={Math.abs(marquee.a.x - marquee.b.x)}
              height={Math.abs(marquee.a.y - marquee.b.y)}
              strokeWidth={1 / view.zoom}
            />
          )}
        </g>
      </svg>
      {presence.map((p) => {
        const s = toScreen(p);
        return (
          <div
            key={p.user_id}
            className="wb-cursor"
            style={{
              transform: `translate(${s.x}px, ${s.y}px)`,
              color: colorFor(p.user_id),
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M1 1 L6 15 L8 9 L14 7 Z"
                fill="currentColor"
                stroke="#fff"
                strokeWidth="1"
              />
            </svg>
            <span style={{ background: colorFor(p.user_id) }}>{p.name}</span>
          </div>
        );
      })}
      {editor}
      {cellEdit &&
        (() => {
          const item = byId.get(cellEdit.id);
          if (!item) return null;
          const cells = item.cells?.length ? item.cells : [[""]];
          const cols = Math.max(1, ...cells.map((r) => r.length));
          const cw = item.w / cols,
            ch = item.h / cells.length;
          const s = toScreen({
            x: item.x + cellEdit.c * cw,
            y: item.y + cellEdit.r * ch,
          });
          const move = (r: number, c: number) => {
            if (r < 0 || c < 0) return;
            if (r >= cells.length) {
              resizeTable(item, 1, 0);
            }
            setCellEdit({ id: item.id, r, c: Math.min(c, cols - 1) });
          };
          return (
            <textarea
              key={`${cellEdit.r}:${cellEdit.c}`}
              className="wb-editor wb-cell-editor"
              aria-label={`Zelle ${cellEdit.r + 1}/${cellEdit.c + 1}`}
              autoFocus
              style={{
                left: s.x,
                top: s.y,
                width: cw * view.zoom,
                height: ch * view.zoom,
                fontSize: (item.fontSize || 14) * view.zoom,
                padding: `${4 * view.zoom}px ${8 * view.zoom}px`,
              }}
              defaultValue={cells[cellEdit.r]?.[cellEdit.c] || ""}
              onChange={(e) =>
                setCell(item.id, cellEdit.r, cellEdit.c, e.target.value)
              }
              onBlur={() => setCellEdit(null)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                  e.preventDefault();
                  setCellEdit(null);
                  container.current?.focus();
                } else if (e.key === "Tab") {
                  e.preventDefault();
                  const last = cellEdit.c >= cols - 1;
                  if (e.shiftKey)
                    move(
                      cellEdit.c ? cellEdit.r : cellEdit.r - 1,
                      cellEdit.c ? cellEdit.c - 1 : cols - 1,
                    );
                  else
                    move(
                      last ? cellEdit.r + 1 : cellEdit.r,
                      last ? 0 : cellEdit.c + 1,
                    );
                } else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  move(cellEdit.r + 1, cellEdit.c);
                }
              }}
            />
          );
        })()}
      {commentOpen &&
        (() => {
          const item = byId.get(commentOpen);
          if (!item) return null;
          const s = toScreen({ x: item.x + item.w, y: item.y });
          const rect = container.current?.getBoundingClientRect();
          const left = Math.min(s.x + 8, (rect?.width || 400) - 320);
          return (
            <div
              className="wb-comment-popover"
              role="dialog"
              aria-label="Kommentar"
              style={{ left: Math.max(8, left), top: Math.max(8, s.y) }}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") closeComment();
              }}
            >
              <div className="wb-comment-head">
                <strong>
                  {item.resolved ? "Erledigter Kommentar" : "Kommentar"}
                </strong>
                {editable && !!item.messages?.length && (
                  <button
                    onClick={() =>
                      change(() =>
                        setProps(item.id, { resolved: !item.resolved }),
                      )
                    }
                  >
                    {item.resolved ? "Wieder öffnen" : "Erledigt"}
                  </button>
                )}
                {editable && (
                  <button
                    aria-label="Kommentar löschen"
                    onClick={() => {
                      change(() => itemsMap.delete(item.id));
                      setCommentOpen(null);
                    }}
                  >
                    <Trash size={14} />
                  </button>
                )}
                <button aria-label="Kommentar schließen" onClick={closeComment}>
                  <X size={14} />
                </button>
              </div>
              <div className="wb-comment-thread">
                {(item.messages || []).map((m) => (
                  <div key={m.id} className="wb-comment-message">
                    <span>
                      <strong>{m.name}</strong>
                      <small>
                        {new Date(m.at).toLocaleString("de-DE", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </small>
                    </span>
                    <p>{m.text}</p>
                  </div>
                ))}
              </div>
              {editable && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const field = e.currentTarget.elements.namedItem(
                      "message",
                    ) as HTMLTextAreaElement;
                    addMessage(item.id, field.value);
                    field.value = "";
                  }}
                >
                  <textarea
                    name="message"
                    aria-label={
                      item.messages?.length
                        ? "Antworten"
                        : "Kommentar schreiben"
                    }
                    placeholder={
                      item.messages?.length
                        ? "Antworten …"
                        : "Kommentar schreiben …"
                    }
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <button className="button primary compact">Senden</button>
                </form>
              )}
            </div>
          );
        })()}
      {(meta.voting?.active ||
        items.some((i) => i.votes && Object.keys(i.votes).length)) &&
        items
          .filter((i) =>
            [
              "sticky",
              "shape",
              "card",
              "text",
              "image",
              "table",
              "emoji",
            ].includes(i.type),
          )
          .map((item) => {
            const count = Object.keys(item.votes || {}).length;
            if (!meta.voting?.active && !count) return null;
            const s = toScreen({ x: item.x + item.w, y: item.y });
            const mine = !!item.votes?.[userId];
            return (
              <button
                key={`vote-${item.id}`}
                className={`wb-vote${mine ? " mine" : ""}`}
                style={{ left: s.x - 18, top: s.y - 14 }}
                aria-label={`Stimme für ${item.text || item.type}: ${count}`}
                aria-pressed={mine}
                disabled={!meta.voting?.active || !editable}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => toggleVote(item.id)}
              >
                <ThumbsUp size={12} weight={mine ? "fill" : "regular"} />{" "}
                {count}
              </button>
            );
          })}
      {timer && (
        <div
          className={`wb-timer${remaining === 0 ? " done" : ""}`}
          role="timer"
          aria-label="Timer"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Timer size={16} />
          <strong>
            {remaining === 0 ? "Zeit abgelaufen" : clock(remaining)}
          </strong>
          {editable && (
            <>
              {timer.endsAt && remaining > 0 ? (
                <button
                  onClick={() =>
                    setMetaValue("timer", { ...timer, endsAt: null, remaining })
                  }
                >
                  Pause
                </button>
              ) : remaining > 0 ? (
                <button
                  onClick={() =>
                    setMetaValue("timer", {
                      ...timer,
                      endsAt: Date.now() + remaining,
                    })
                  }
                >
                  Weiter
                </button>
              ) : null}
              <button
                onClick={() =>
                  setMetaValue(
                    "timer",
                    timer.endsAt
                      ? {
                          ...timer,
                          endsAt: Math.max(Date.now(), timer.endsAt) + 60000,
                        }
                      : { ...timer, remaining: remaining + 60000 },
                  )
                }
              >
                +1 Min
              </button>
              <button
                aria-label="Timer beenden"
                onClick={() => setMetaValue("timer", undefined)}
              >
                <X size={14} />
              </button>
            </>
          )}
        </div>
      )}
      {votingOpen && editable && (
        <div
          className="wb-panel"
          role="dialog"
          aria-label="Abstimmung"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <strong>Abstimmung</strong>
          {meta.voting?.active ? (
            <>
              <p>
                Du hast noch {Math.max(0, meta.voting.max - myVotes)} von{" "}
                {meta.voting.max} Stimmen. Klicke auf 👍 an Zetteln, Formen oder
                Karten.
              </p>
              <button
                className="button"
                onClick={() =>
                  setMetaValue("voting", { ...meta.voting, active: false })
                }
              >
                Abstimmung beenden
              </button>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const max =
                  Number(
                    (
                      e.currentTarget.elements.namedItem(
                        "max",
                      ) as HTMLSelectElement
                    ).value,
                  ) || 3;
                setMetaValue("voting", { active: true, max });
              }}
            >
              <label>
                Stimmen pro Person
                <Select
                  name="max"
                  defaultValue="3"
                  aria-label="Stimmen pro Person"
                >
                  {[1, 2, 3, 5, 10].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </label>
              <button className="button primary">Abstimmung starten</button>
            </form>
          )}
          {items.some((i) => i.votes && Object.keys(i.votes).length) && (
            <>
              <ol className="wb-results" aria-label="Ergebnis">
                {items
                  .filter((i) => i.votes && Object.keys(i.votes).length)
                  .sort(
                    (a, b) =>
                      Object.keys(b.votes!).length -
                      Object.keys(a.votes!).length,
                  )
                  .slice(0, 8)
                  .map((i) => (
                    <li key={i.id}>
                      <span>
                        {i.text ||
                          i.emoji ||
                          (i.type === "card"
                            ? pages.find((p) => p.id === i.pageId)?.title
                            : "") ||
                          "Element"}
                      </span>
                      <strong>{Object.keys(i.votes!).length}</strong>
                    </li>
                  ))}
              </ol>
              <button className="text-button" onClick={resetVotes}>
                Stimmen zurücksetzen
              </button>
            </>
          )}
        </div>
      )}
      {timerOpen && editable && (
        <div
          className="wb-panel"
          role="dialog"
          aria-label="Timer einstellen"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <strong>Timer</strong>
          <div className="wb-timer-presets">
            {[1, 3, 5, 10, 15].map((m) => (
              <button
                key={m}
                className="button"
                onClick={() => {
                  startTimer(m * 60000);
                  setTimerOpen(false);
                }}
              >
                {m} Min
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const minutes = Number(
                (
                  e.currentTarget.elements.namedItem(
                    "minutes",
                  ) as HTMLInputElement
                ).value,
              );
              if (minutes > 0 && minutes <= 180) {
                startTimer(Math.round(minutes * 60000));
                setTimerOpen(false);
              }
            }}
          >
            <label>
              Minuten
              <input
                name="minutes"
                type="number"
                min={0.5}
                max={180}
                step={0.5}
                defaultValue={5}
                aria-label="Minuten"
              />
            </label>
            <button className="button primary">Starten</button>
          </form>
        </div>
      )}
      {stylePanel}
      <div
        className="wb-toolbar"
        role="toolbar"
        aria-label="Werkzeuge"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {tools.map(([key, label, icon, shortcut]) => (
          <button
            key={key}
            className={tool === key ? "active" : ""}
            aria-pressed={tool === key}
            aria-label={label}
            title={`${label} (${shortcut})`}
            onClick={() => {
              setTool(key);
              setShapeMenu(
                key === "shape" && tool === "shape"
                  ? !shapeMenu
                  : key === "shape",
              );
            }}
          >
            {icon}
          </button>
        ))}
        {editable && (
          <>
            <button
              aria-label="Bild"
              title="Bild einfügen"
              onClick={() => fileInput.current?.click()}
            >
              <ImageSquare size={18} />
            </button>
            <button
              aria-label="Emoji"
              title="Emoji oder Sticker"
              onClick={() => setEmojiOpen(true)}
            >
              <Smiley size={18} />
            </button>
            <button
              aria-label="Seite verknüpfen"
              title="Seite, Datenbank oder Whiteboard verknüpfen"
              onClick={() => setCardOpen(true)}
            >
              <FileText size={18} />
            </button>
            <button
              aria-label="Vorlagen"
              title="Vorlagen: Retro, Kanban, Mindmap, SWOT, Flussdiagramm"
              onClick={() => setTemplatesOpen(true)}
            >
              <SquaresFour size={18} />
            </button>
            <button
              aria-label="Abstimmung"
              title="Abstimmung"
              className={meta.voting?.active ? "active" : ""}
              onClick={() => {
                setVotingOpen((v) => !v);
                setTimerOpen(false);
              }}
            >
              <ThumbsUp size={18} />
            </button>
            <button
              aria-label="Timer"
              title="Timer"
              className={timer ? "active" : ""}
              onClick={() => {
                setTimerOpen((v) => !v);
                setVotingOpen(false);
              }}
            >
              <Timer size={18} />
            </button>
            <span className="wb-sep" />
            <button
              aria-label="Rückgängig"
              title="Rückgängig (⌘Z)"
              onClick={() => undo.undo()}
            >
              <ArrowCounterClockwise size={18} />
            </button>
            <button
              aria-label="Wiederholen"
              title="Wiederholen (⇧⌘Z)"
              onClick={() => undo.redo()}
            >
              <ArrowClockwise size={18} />
            </button>
          </>
        )}
        <input
          ref={fileInput}
          type="file"
          hidden
          accept="image/*"
          aria-label="Bild für das Whiteboard"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void addImage(f);
          }}
        />
      </div>
      {editable && tool === "shape" && shapeMenu && (
        <div
          className="wb-shape-menu"
          role="menu"
          aria-label="Formen"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {shapeKinds.map((k) => (
            <button
              key={k}
              role="menuitemradio"
              aria-checked={shapeKind === k}
              className={shapeKind === k ? "active" : ""}
              title={shapeNames[k]}
              aria-label={shapeNames[k]}
              onClick={() => {
                setShapeKind(k);
                setShapeMenu(false);
              }}
            >
              <svg width="22" height="22" viewBox="-2 -2 28 28">
                <path
                  d={shapePath(k, 24, 24)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
            </button>
          ))}
        </div>
      )}
      {editable && tool === "sticky" && (
        <div
          className="wb-shape-menu"
          aria-label="Zettelfarbe"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {stickyColors.map((c) => (
            <button
              key={c}
              className={`wb-swatch${stickyColor === c ? " active" : ""}`}
              style={{ background: c }}
              aria-label={`Zettelfarbe ${c}`}
              onClick={() => setStickyColor(c)}
            />
          ))}
        </div>
      )}
      <div className="wb-zoom" onPointerDown={(e) => e.stopPropagation()}>
        <span className="wb-status" aria-live="polite">
          {status}
        </span>
        <button aria-label="Verkleinern" onClick={() => zoomAt(1 / 1.2)}>
          <Minus size={16} />
        </button>
        <button
          aria-label="Zoom zurücksetzen"
          className="wb-zoom-value"
          onClick={() => setView((v) => ({ ...v, zoom: 1 }))}
        >
          {Math.round(view.zoom * 100)} %
        </button>
        <button aria-label="Vergrößern" onClick={() => zoomAt(1.2)}>
          <Plus size={16} />
        </button>
        <button
          aria-label="Alles anzeigen"
          title="Alles anzeigen (⇧1)"
          onClick={() => fitToContent()}
        >
          <ArrowsOut size={16} />
        </button>
        <button
          aria-label={fullscreen ? "Vollbild beenden" : "Vollbild"}
          aria-pressed={fullscreen}
          title={fullscreen ? "Vollbild beenden (Esc)" : "Vollbild"}
          onClick={() => void toggleFullscreen()}
        >
          {fullscreen ? <CornersIn size={16} /> : <CornersOut size={16} />}
        </button>
        <button
          aria-label={
            showComments ? "Kommentare ausblenden" : "Kommentare anzeigen"
          }
          aria-pressed={showComments}
          title={showComments ? "Kommentare ausblenden" : "Kommentare anzeigen"}
          onClick={() => setShowComments((v) => !v)}
        >
          <ChatCircle size={16} weight={showComments ? "fill" : "regular"} />
        </button>
        <button
          aria-label="Als SVG exportieren"
          title="Als SVG exportieren"
          onClick={() => exportBoard("svg")}
        >
          <DownloadSimple size={16} /> SVG
        </button>
        <button
          aria-label="Als PNG exportieren"
          title="Als PNG exportieren"
          onClick={() => exportBoard("png")}
        >
          <DownloadSimple size={16} /> PNG
        </button>
      </div>
      {presenting !== null ? (
        <div
          className="wb-present"
          onPointerDown={(e) => e.stopPropagation()}
          // Buttons that get disabled must not take the keyboard away.
          onClickCapture={() =>
            setTimeout(() => container.current?.focus({ preventScroll: true }))
          }
        >
          <button
            aria-label="Vorheriger Rahmen"
            disabled={presenting === 0}
            onClick={() => showSlide(presenting - 1)}
          >
            <CaretLeft size={18} />
          </button>
          <span>
            {slides[presenting]?.text || "Rahmen"} · {presenting + 1} /{" "}
            {slides.length}
          </span>
          <button
            aria-label="Nächster Rahmen"
            disabled={presenting >= slides.length - 1}
            onClick={() => showSlide(presenting + 1)}
          >
            <CaretRight size={18} />
          </button>
          <button
            aria-label="Präsentation beenden"
            onClick={() => setPresenting(null)}
          >
            <X size={18} />
          </button>
        </div>
      ) : (
        slides.length > 0 && (
          <button
            className="wb-present-start"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              showSlide(0);
              container.current?.focus({ preventScroll: true });
            }}
          >
            <PresentationChart size={16} /> Präsentieren
          </button>
        )
      )}
      <Modal
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        title="Vorlage einfügen"
      >
        <div className="wb-template-list">
          {(
            Object.entries(whiteboardTemplates) as [
              WhiteboardTemplate,
              string,
            ][]
          ).map(([kind, name]) => (
            <button
              key={kind}
              className="button"
              onClick={() => insertTemplate(kind)}
            >
              {name}
            </button>
          ))}
        </div>
      </Modal>
      {!items.length && (
        <div className="wb-empty" aria-hidden="true">
          {editable
            ? "Doppelklick für einen Notizzettel – oder links ein Werkzeug wählen."
            : "Dieses Whiteboard ist noch leer."}
        </div>
      )}
      <Modal
        open={emojiOpen}
        onClose={() => setEmojiOpen(false)}
        title="Emoji einfügen"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          container.current?.focus({ preventScroll: true });
        }}
      >
        <EmojiPicker
          onSelect={async (emoji) => {
            const at = center();
            let id = "";
            change(() => {
              id = addItem({
                type: "emoji",
                emoji,
                x: at.x - 40,
                y: at.y - 40,
                w: 80,
                h: 80,
              });
            });
            setSelection(new Set([id]));
            setEmojiOpen(false);
          }}
          allowSymbols={false}
        />
      </Modal>
      <Modal
        open={cardOpen}
        onClose={() => setCardOpen(false)}
        title="Seite verknüpfen"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          container.current?.focus({ preventScroll: true });
        }}
      >
        <input
          autoFocus
          aria-label="Seiten suchen"
          placeholder="Seite, Datenbank oder Whiteboard suchen …"
          value={cardQuery}
          onChange={(e) => setCardQuery(e.target.value)}
          className="wb-card-search"
        />
        <div className="wb-card-list">
          {cardPages.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                const at = center();
                let id = "";
                change(() => {
                  id = addItem({
                    type: "card",
                    pageId: p.id,
                    x: at.x - 140,
                    y: at.y - 40,
                    w: 280,
                    h: 80,
                    fill:
                      p.kind === "whiteboard"
                        ? "#7048e8"
                        : p.kind === "database"
                          ? "#2f9e44"
                          : "#3479e7",
                  });
                });
                setSelection(new Set([id]));
                setCardOpen(false);
              }}
            >
              {p.title || "Ohne Titel"}
              <small>
                {p.kind === "database"
                  ? "Datenbank"
                  : p.kind === "whiteboard"
                    ? "Whiteboard"
                    : "Dokument"}
              </small>
            </button>
          ))}
          {!cardPages.length && (
            <p className="muted">Keine passenden Seiten.</p>
          )}
        </div>
      </Modal>
    </div>
  );
  // In full screen the board is rendered into the page body, so no parent
  // (scrolling, transforms) can hold it back.
  return fullscreen && typeof document !== "undefined"
    ? createPortal(board, document.body)
    : board;
}
export type { WhiteboardItemType };
