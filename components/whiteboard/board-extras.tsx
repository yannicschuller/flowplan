"use client";
// Navigation, structure and presentation features of the board, kept out
// of whiteboard.tsx: groups (Ctrl/⌘+G), the minimap, the frames panel
// (order, hidden frames, speaker notes), search (Ctrl/⌘+F) with the tag
// filter, element links (#page=…&item=…), links and lists in texts, tags,
// embeds and PDFs, cropping pictures, the template gallery, exports and
// the presenter view. whiteboard.tsx calls useBoardExtras() once and puts
// its pieces where they belong (actions, style bar, world layer, overlays).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type * as Y from "yjs";
import {
  DownloadSimple,
  FrameCorners,
  MagnifyingGlass,
  MapTrifold,
  Notepad,
  Monitor,
  PlayCircle,
} from "@phosphor-icons/react";
import { useT } from "../i18n";
import { showToast } from "../toast";
import { openPdf } from "../pdf-viewer";
import { Minimap } from "./minimap";
import { FramesPanel } from "./frames-panel";
import { BoardSearch } from "./board-search";
import { EmbedDialog } from "./embed-dialog";
import { CropDialog, type Crop } from "./crop-dialog";
import { ExportDialog, type ExportScope } from "./export-dialog";
import { TemplateGallery } from "./template-gallery";
import { ItemTools } from "./item-tools";
import { pdfPageCount, setEmbedLoaded } from "./embed-item";
import { boardDeck, useBoardPresenter } from "./board-presenter";
import type { PageRef, RowCard } from "./render";
import { connectorPoint, type Point, type WhiteboardItem } from "@/lib/whiteboard-model";
import { contentBounds } from "@/lib/whiteboard-geometry";
import {
  expandSelection,
  groupPath,
  groupSelection,
  remapGroups,
  resizeBox,
  scaleItems,
  selectedGroup,
  selectionUnit,
  ungroupSelection,
  unitGroup,
  type ScaleOrigin,
} from "@/lib/whiteboard-groups";
import { frameMembers, frameSequence, moveFrame } from "@/lib/whiteboard-frames";
import { searchBoard } from "@/lib/whiteboard-search";
import { boardTags, hasTag } from "@/lib/whiteboard-tags";
import { elementLink, linkTarget } from "@/lib/whiteboard-links";
import { continueList, insertLink, toggleList, toggleMark, type Edit } from "@/lib/whiteboard-richtext";
import { boardEmbed, cleanCrop, type BoardEmbed } from "@/lib/whiteboard-embeds";
import { parsePageLocation } from "@/lib/page-location";
import type { Draft } from "@/lib/whiteboard-template-gallery";

type View = { x: number; y: number; zoom: number };
export type ExtraAction = {
  key: string;
  label: string;
  title: string;
  icon: ReactNode;
  run: () => void;
  active?: boolean;
  pressed?: boolean;
  keepOpen?: boolean;
};
type NewItem = Omit<WhiteboardItem, "id" | "z"> & { z?: number };
export type BoardApi = {
  pageId: string;
  title: string;
  editable: boolean;
  items: WhiteboardItem[];
  byId: Map<string, WhiteboardItem>;
  itemsMap: Y.Map<Y.Map<unknown>>;
  change: (fn: () => void) => void;
  setProps: (id: string, props: Partial<WhiteboardItem>) => void;
  addItem: (item: NewItem) => string;
  selection: Set<string>;
  setSelection: (next: Set<string>) => void;
  editing: string | null;
  view: View;
  setView: (view: View) => void;
  moveCamera: (view: View) => void;
  fitToContent: (list?: WhiteboardItem[], animate?: boolean) => void;
  toScreen: (p: Point) => Point;
  toWorld: (x: number, y: number) => Point;
  center: () => Point;
  svg: RefObject<SVGSVGElement | null>;
  container: RefObject<HTMLDivElement | null>;
  pages: PageRef[];
  rowCards: Map<string, RowCard>;
  presenting: number | null;
  slides: WhiteboardItem[];
  showSlide: (index: number) => void;
  insertDrafts: (drafts: Draft[]) => WhiteboardItem[];
  upload: (file: File) => Promise<{ url: string }>;
  onError: (message: string) => void;
  dock: boolean;
  templatesOpen: boolean;
  setTemplatesOpen: (open: boolean) => void;
};
const stored = (key: string) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};
const store = (key: string, on: boolean) => {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {}
};
const isMod = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey;

export function useBoardExtras(api: BoardApi) {
  const t = useT();
  const { items, byId, selection, editable, presenting, slides } = api;
  const ref = useRef(api);
  ref.current = api;
  const [entered, setEntered] = useState<string | null>(null),
    [minimap, setMinimap] = useState(() => stored("flowplan-board-minimap")),
    [framesOpen, setFramesOpen] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState(""),
    [hit, setHit] = useState(0),
    [tag, setTag] = useState(""),
    [embedOpen, setEmbedOpen] = useState(false),
    [cropId, setCropId] = useState<string | null>(null),
    [exportScope, setExportScope] = useState<ExportScope | null>(null),
    [galleryTab, setGalleryTab] = useState<"gallery" | "own" | "save">("gallery"),
    [notesShown, setNotesShown] = useState(false);
  const selected = useMemo(() => items.filter((i) => selection.has(i.id)), [items, selection]);

  // ---- flying to elements, element links ----
  const flyTo = useCallback((item: WhiteboardItem) => {
    const { container, moveCamera, fitToContent, byId: map } = ref.current;
    if (item.type === "frame") {
      const rect = container.current?.getBoundingClientRect();
      if (!rect) return;
      const zoom = Math.min(4, (rect.width - 120) / item.w, (rect.height - 140) / (item.h + 30));
      moveCamera({ zoom, x: item.x + item.w / 2 - rect.width / zoom / 2, y: item.y - 15 + item.h / 2 - rect.height / zoom / 2 });
    } else {
      const box = contentBounds([item], map);
      if (!box) return;
      const rect = container.current?.getBoundingClientRect();
      // Small elements are not blown up beyond 100 %.
      const zoom = rect ? Math.max(0.1, Math.min(1, (rect.width - 160) / Math.max(1, box.w), (rect.height - 160) / Math.max(1, box.h))) : 1;
      if (rect) moveCamera({ zoom, x: box.x + box.w / 2 - rect.width / zoom / 2, y: box.y + box.h / 2 - rect.height / zoom / 2 });
      else fitToContent([item]);
    }
  }, []);
  const jump = useCallback(
    (itemId: string) => {
      const item = ref.current.byId.get(itemId);
      if (!item) {
        ref.current.onError(t("Dieses Element gibt es auf dem Board nicht mehr.", "This element is no longer on the board."));
        return;
      }
      flyTo(item);
      ref.current.setSelection(new Set(selectionUnit(item, ref.current.items, null)));
    },
    [flyTo, t],
  );
  // #page=<board>&item=<element>: open zoomed to the element, also when the
  // hash changes on the open board. The element part then leaves the
  // address, so a reload shows the board as last seen.
  useEffect(() => {
    const go = () => {
      const target = parsePageLocation(location.hash);
      if (!target?.itemId || target.pageId !== ref.current.pageId) return;
      const id = target.itemId;
      history.replaceState(null, "", `${location.pathname}${location.search}#page=${target.pageId}`);
      requestAnimationFrame(() => jump(id));
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [jump]);
  const copyLink = useCallback(
    (itemId: string) => {
      const link = elementLink(location.origin, ref.current.pageId, itemId);
      void navigator.clipboard
        ?.writeText(link)
        .then(() => showToast({ text: t("Link kopiert", "Link copied") }))
        .catch(() => showToast({ text: link }));
    },
    [t],
  );

  // ---- pointer on links and buttons inside elements ----
  function onPointerDownCapture(e: React.PointerEvent): boolean {
    if (e.button !== 0) return false;
    const el = (e.target as Element | null)?.closest?.("[data-wb-href], [data-wb-item], [data-wb-embed], [data-wb-pdf]");
    if (!el) return false;
    e.stopPropagation();
    const owner = el.closest("[data-item]")?.getAttribute("data-item") || "";
    const href = el.getAttribute("data-wb-href");
    if (href) {
      // Web links open with their own click (new tab); element links of
      // this board fly there.
      const target = linkTarget(href, ref.current.pageId, location.origin);
      if (target?.kind === "item") {
        e.preventDefault();
        jump(target.itemId);
      }
      return true;
    }
    e.preventDefault();
    const item = el.getAttribute("data-wb-item");
    if (item) jump(item);
    const embed = el.getAttribute("data-wb-embed");
    if (embed && owner) setEmbedLoaded(owner, embed === "load");
    const pdf = el.getAttribute("data-wb-pdf");
    const target = owner ? ref.current.byId.get(owner) : undefined;
    if (pdf && target && ref.current.editable) {
      const count = pdfPageCount(target.src || "");
      const page = Math.max(1, Math.min(count || 1, (target.page || 1) + (pdf === "next" ? 1 : -1)));
      ref.current.change(() => ref.current.setProps(owner, { page }));
    } else if (pdf && target) {
      // Viewers page through on their own: the viewer opens.
      openPdf(target.src || "", target.text || "PDF");
    }
    return true;
  }
  // A double click on a PDF opens the viewer; on a grouped element it
  // enters the group.
  function onDoubleClickItem(item: WhiteboardItem | undefined): boolean {
    if (!item) return false;
    if (item.type === "embed") {
      const embed = boardEmbed(item);
      if (embed?.kind === "pdf") {
        openPdf(embed.src, item.text || "PDF");
        return true;
      }
    }
    // A double click enters the group: the next level inside is selected.
    const group = unitGroup(item, entered);
    if (!group) return false;
    setEntered(group);
    ref.current.setSelection(new Set(selectionUnit(item, ref.current.items, group)));
    return true;
  }

  // ---- groups ----
  const group = () => {
    const result = groupSelection(selected, items, () => crypto.randomUUID());
    if (!result) return;
    api.change(() => result.paths.forEach((path, id) => api.setProps(id, { groups: path })));
  };
  const ungroup = () => {
    const paths = ungroupSelection(selected, items);
    if (!paths) return;
    api.change(() => paths.forEach((path, id) => api.setProps(id, { groups: path.length ? path : undefined })));
    if (entered && !items.some((i) => groupPath(i).includes(entered) && !paths.get(i.id)?.includes(entered))) setEntered(null);
  };
  const canGroup = editable && !!groupSelection(selected, items, () => "probe");
  const canUngroup = editable && !!ungroupSelection(selected, items);
  // Resizing a group as one, from the corners of the selection.
  const scaling = useRef<{ handle: string; start: Point; box: { x: number; y: number; w: number; h: number }; origins: ScaleOrigin[] } | null>(null);
  const unitGroupSelected = editable && !api.editing && selected.length > 1 && !selected.some((i) => i.locked) ? selectedGroup(selected, items) : null;
  function handleDown(e: React.PointerEvent, handle: string) {
    e.stopPropagation();
    const box = contentBounds(selected, byId);
    if (!box) return;
    api.svg.current?.setPointerCapture(e.pointerId);
    scaling.current = {
      handle,
      start: api.toWorld(e.clientX, e.clientY),
      box,
      origins: selected.map((i) => ({
        id: i.id,
        x: i.x,
        y: i.y,
        w: i.w,
        h: i.h,
        fontSize: i.fontSize,
        ...(i.type === "connector"
          ? { from: i.from && !i.from.id ? { x: i.from.x, y: i.from.y } : undefined, to: i.to && !i.to.id ? { x: i.to.x, y: i.to.y } : undefined }
          : {}),
      })),
    };
  }
  function onMove(e: React.PointerEvent): boolean {
    const s = scaling.current;
    if (!s) return false;
    const p = ref.current.toWorld(e.clientX, e.clientY);
    const next = resizeBox(s.box, s.handle, p.x - s.start.x, p.y - s.start.y, true);
    const props = scaleItems(s.origins, s.box, next);
    ref.current.change(() =>
      props.forEach(({ id, ...rest }) => {
        const item = ref.current.byId.get(id);
        if (item?.type === "connector") {
          const { from, to } = rest;
          ref.current.setProps(id, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
        } else ref.current.setProps(id, { x: rest.x, y: rest.y, w: rest.w, h: rest.h, ...(rest.fontSize ? { fontSize: rest.fontSize } : {}) });
      }),
    );
    return true;
  }
  function onUp(): boolean {
    if (!scaling.current) return false;
    scaling.current = null;
    return true;
  }

  // ---- search and tags ----
  const ctx = useMemo(
    () => ({
      page: (id: string) => api.pages.find((p) => p.id === id)?.title,
      record: (rowId: string) => {
        const card = api.rowCards.get(rowId);
        return card ? { title: card.title, props: card.props.map((p) => p.value) } : undefined;
      },
    }),
    [api.pages, api.rowCards],
  );
  const matches = useMemo(() => (searchOpen ? searchBoard(items, query, ctx) : []), [searchOpen, items, query, ctx]);
  const current = matches.length ? matches[Math.min(hit, matches.length - 1)] : undefined;
  const lastFlown = useRef("");
  useEffect(() => {
    if (!current || lastFlown.current === `${query}:${current.id}`) return;
    lastFlown.current = `${query}:${current.id}`;
    const item = ref.current.byId.get(current.id);
    if (item) flyTo(item);
  }, [current, query, flyTo]);
  const step = (delta: number) => {
    if (!matches.length) return;
    lastFlown.current = "";
    setHit((h) => (Math.min(h, matches.length - 1) + delta + matches.length) % matches.length);
  };
  const tags = useMemo(() => boardTags(items), [items]);
  const closeSearch = () => {
    setSearchOpen(false);
    setTag("");
    lastFlown.current = "";
    requestAnimationFrame(() => ref.current.container.current?.focus({ preventScroll: true }));
  };

  // ---- presentation ----
  const currentSlide = presenting !== null ? slides[presenting] : undefined;
  const stage = useMemo(
    () => (currentSlide ? frameMembers(currentSlide, items, (end) => connectorPoint(end, byId)) : null),
    [currentSlide, items, byId],
  );
  const openPresenter = useBoardPresenter({
    active: presenting !== null,
    index: presenting ?? 0,
    deck: () => boardDeck(ref.current.title, ref.current.slides, ref.current.items, ref.current.pages, ref.current.rowCards, t),
    onGo: (index) => ref.current.showSlide(Math.max(0, Math.min(ref.current.slides.length - 1, index))),
  });
  const present = (frameId?: string) => {
    const index = frameId ? slides.findIndex((s) => s.id === frameId) : 0;
    if (!slides.length) return;
    setFramesOpen(false);
    api.showSlide(Math.max(0, index));
    requestAnimationFrame(() => api.container.current?.focus({ preventScroll: true }));
  };

  function itemClass(item: WhiteboardItem) {
    let out = "";
    if (stage && !stage.has(item.id)) out += " wb-offstage";
    if (tag && !(item.type === "sticky" && hasTag(item, tag)) && item.type !== "frame") out += " wb-dim";
    if (tag && item.type === "sticky" && hasTag(item, tag)) out += " wb-tagged";
    return out;
  }

  // ---- texts: lists, marks, links while editing ----
  const editor = () =>
    api.container.current?.querySelector<HTMLTextAreaElement>("textarea.wb-editor:not(.wb-cell-editor)") || null;
  const applyEdit = (field: HTMLTextAreaElement, id: string, edit: Edit) => {
    field.value = edit.text.slice(0, 10000);
    field.setSelectionRange(edit.start, edit.end);
    ref.current.change(() => ref.current.setProps(id, { text: field.value }));
  };
  function onEditorKey(e: React.KeyboardEvent<HTMLTextAreaElement>, id: string): boolean {
    const field = e.currentTarget;
    const item = ref.current.byId.get(id);
    if (!item || !["sticky", "text", "shape"].includes(item.type)) return false;
    const mark = isMod(e) && !e.altKey ? ({ b: "**", i: "*", u: "__" } as const)[e.key.toLowerCase() as "b" | "i" | "u"] : undefined;
    if (mark) {
      e.preventDefault();
      applyEdit(field, id, toggleMark(field.value, field.selectionStart, field.selectionEnd, mark));
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey && !isMod(e) && !e.altKey && field.selectionStart === field.selectionEnd) {
      const edit = continueList(field.value, field.selectionStart);
      if (!edit) return false;
      e.preventDefault();
      applyEdit(field, id, edit);
      return true;
    }
    return false;
  }
  const onList = (kind: "ul" | "ol") => {
    const field = editor();
    if (field && api.editing) return applyEdit(field, api.editing, toggleList(field.value, field.selectionStart, field.selectionEnd, kind));
    api.change(() => {
      for (const item of selected)
        if (!item.locked && ["sticky", "text", "shape"].includes(item.type)) {
          const text = item.text || "";
          api.setProps(item.id, { text: toggleList(text, 0, text.length, kind).text });
        }
    });
  };
  const onTextLink = (href: string) => {
    const field = editor();
    if (!field || !api.editing) return false;
    const edit = insertLink(field.value, field.selectionStart, field.selectionEnd, href);
    if (!edit) return false;
    applyEdit(field, api.editing, edit);
    field.focus();
    return true;
  };
  const set = (props: Partial<WhiteboardItem>) => api.change(() => selected.forEach((i) => !i.locked && api.setProps(i.id, props)));

  // ---- keyboard ----
  function onKeyDown(e: React.KeyboardEvent): boolean {
    const key = e.key.toLowerCase();
    if (isMod(e) && !e.altKey && key === "f") {
      e.preventDefault();
      setSearchOpen(true);
      return true;
    }
    if (isMod(e) && !e.altKey && key === "g" && editable) {
      e.preventDefault();
      if (e.shiftKey) ungroup();
      else group();
      return true;
    }
    if (e.key === "Escape" && entered) {
      setEntered(null);
      return false;
    }
    // On phones the frames sheet covers the board: Escape closes it.
    if (e.key === "Escape" && framesOpen && api.dock) setFramesOpen(false);
    return false;
  }

  // ---- inserting ----
  const place = (item: NewItem) => {
    let id = "";
    api.change(() => {
      id = api.addItem(item);
    });
    api.setSelection(new Set([id]));
    return id;
  };
  // New embeds fit into the visible part of the board (phones).
  const fitted = (w: number, h: number) => {
    const rect = api.svg.current?.getBoundingClientRect();
    if (!rect?.width) return { w, h };
    const scale = Math.min(1, (rect.width * 0.85) / api.view.zoom / w, (rect.height * 0.75) / api.view.zoom / h);
    return { w: Math.round(w * scale), h: Math.round(h * scale) };
  };
  const addEmbed = (embed: BoardEmbed, url: string) => {
    const at = api.center();
    const { w, h } = fitted(480, 300);
    place({ type: "embed", src: embed.src, url, text: embed.provider, x: at.x - w / 2, y: at.y - h / 2, w, h });
    setEmbedOpen(false);
  };
  const addPdf = async (file: File, at = api.center()) => {
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      api.onError(t("Das ist keine PDF-Datei.", "This is not a PDF file."));
      return;
    }
    try {
      const { url } = await api.upload(file);
      const { w, h } = fitted(360, 524);
      place({ type: "embed", src: url, text: file.name.slice(0, 200), page: 1, x: at.x - w / 2, y: at.y - h / 2, w, h });
      setEmbedOpen(false);
    } catch (e) {
      api.onError((e as Error).message);
    }
  };
  const insertTemplate = (drafts: Draft[]) => {
    const placed = api.insertDrafts(remapGroups(drafts, () => crypto.randomUUID()));
    api.setTemplatesOpen(false);
    if (placed.length) requestAnimationFrame(() => api.fitToContent(placed));
  };
  const applyCrop = (crop: Crop | null) => {
    const item = cropId ? byId.get(cropId) : undefined;
    setCropId(null);
    if (!item) return;
    const old = cleanCrop(item.crop) || { x: 0, y: 0, w: 1, h: 1 };
    const fullW = item.w / old.w,
      fullH = item.h / old.h;
    const originX = item.x - old.x * fullW,
      originY = item.y - old.y * fullH;
    const next = crop || { x: 0, y: 0, w: 1, h: 1 };
    api.change(() =>
      api.setProps(item.id, {
        crop: crop || undefined,
        x: Math.round(originX + next.x * fullW),
        y: Math.round(originY + next.y * fullH),
        w: Math.max(4, Math.round(fullW * next.w)),
        h: Math.max(4, Math.round(fullH * next.h)),
      }),
    );
  };

  // ---- pieces for whiteboard.tsx ----
  const z = api.view.zoom;
  const enteredBox = entered ? contentBounds(items.filter((i) => groupPath(i).includes(entered)), byId) : null;
  const groupBox = unitGroupSelected ? contentBounds(selected, byId) : null;
  const worldLayer = (
    <>
      {enteredBox && (
        <rect
          data-ui
          className="wb-group-outline"
          x={enteredBox.x - 10 / z}
          y={enteredBox.y - 10 / z}
          width={enteredBox.w + 20 / z}
          height={enteredBox.h + 20 / z}
          strokeWidth={1.5 / z}
          strokeDasharray={`${6 / z} ${4 / z}`}
        />
      )}
      {searchOpen &&
        matches.map((m) => {
          const item = byId.get(m.id);
          const box = item ? contentBounds([item], byId) : null;
          if (!box) return null;
          const active = m.id === current?.id;
          return (
            <rect
              key={`hit-${m.id}`}
              data-ui
              className={`wb-search-hit${active ? " current" : ""}`}
              x={box.x - 6 / z}
              y={box.y - 6 / z}
              width={box.w + 12 / z}
              height={box.h + 12 / z}
              rx={6 / z}
              strokeWidth={(active ? 3 : 1.5) / z}
            />
          );
        })}
      {groupBox &&
        (["nw", "ne", "sw", "se"] as const).map((h) => (
          <rect
            key={`group-${h}`}
            data-ui
            className={`wb-handle wb-handle-${h} wb-group-handle`}
            x={(h.includes("w") ? groupBox.x : groupBox.x + groupBox.w) - 5 / z}
            y={(h.includes("n") ? groupBox.y : groupBox.y + groupBox.h) - 5 / z}
            width={10 / z}
            height={10 / z}
            rx={2 / z}
            onPointerDown={(e) => handleDown(e, h)}
          />
        ))}
    </>
  );

  const viewport = (() => {
    const rect = api.svg.current?.getBoundingClientRect();
    return { x: api.view.x, y: api.view.y, w: (rect?.width || 800) / z, h: (rect?.height || 600) / z };
  })();
  const sequence = frameSequence(items);
  const overlays = (
    <>
      {minimap && presenting === null && (
        <Minimap
          items={items}
          byId={byId}
          view={api.view}
          viewport={viewport}
          small={api.dock}
          onCenter={(p, animate) => {
            const next = { zoom: z, x: p.x - viewport.w / 2, y: p.y - viewport.h / 2 };
            if (animate) api.moveCamera(next);
            else api.setView(next);
          }}
        />
      )}
      {framesOpen && presenting === null && (
        <FramesPanel
          frames={sequence}
          items={items}
          byId={byId}
          pages={api.pages}
          cards={api.rowCards}
          editable={editable}
          current={currentSlide?.id ?? null}
          onFly={(frame) => {
            flyTo(frame);
            if (api.dock) setFramesOpen(false);
          }}
          onRename={(id, text) => api.change(() => api.setProps(id, { text: text.slice(0, 200) }))}
          onToggleHidden={(id) => api.change(() => api.setProps(id, { presentHidden: byId.get(id)?.presentHidden ? undefined : true }))}
          onMove={(from, to) => {
            const places = moveFrame(
              sequence.map((f) => f.id),
              from,
              to,
            );
            api.change(() => places.forEach((slide, id) => api.setProps(id, { slide })));
          }}
          onNotes={(id, notes) => api.change(() => api.setProps(id, { notes: notes.slice(0, 20000) || undefined }))}
          onCopyLink={copyLink}
          onExport={(id) => setExportScope({ kind: "frame", id })}
          onPresent={present}
          onClose={() => setFramesOpen(false)}
        />
      )}
      {searchOpen && (
        <BoardSearch
          query={query}
          matches={matches}
          index={Math.min(hit, Math.max(0, matches.length - 1))}
          tags={tags}
          tag={tag}
          onQuery={(q) => {
            setQuery(q);
            setHit(0);
            lastFlown.current = "";
          }}
          onStep={step}
          onTag={setTag}
          onClose={closeSearch}
        />
      )}
      {presenting !== null && notesShown && (
        <div className="wb-present-notes" role="note" aria-label={t("Sprechernotizen", "Speaker notes")} onPointerDown={(e) => e.stopPropagation()}>
          <strong>{currentSlide?.text || t("Rahmen", "Frame")}</strong>
          <p>{currentSlide?.notes || t("Keine Notizen für diesen Rahmen.", "No notes for this frame.")}</p>
        </div>
      )}
      {embedOpen && <EmbedDialog open onClose={() => setEmbedOpen(false)} onEmbed={addEmbed} onPdf={(file) => addPdf(file)} />}
      {cropId && byId.get(cropId)?.src && (
        <CropDialog open src={byId.get(cropId)!.src!} crop={cleanCrop(byId.get(cropId)!.crop)} onClose={() => setCropId(null)} onApply={applyCrop} />
      )}
      {exportScope && (
        <ExportDialog
          open
          initial={exportScope}
          items={items}
          selection={selection}
          title={api.title}
          svg={() => api.svg.current}
          onClose={() => setExportScope(null)}
          onError={api.onError}
        />
      )}
      {api.templatesOpen && (
        <TemplateGallery
          open
          tab={galleryTab}
          pageId={api.pageId}
          editable={editable}
          items={items}
          selection={selection}
          onClose={() => {
            api.setTemplatesOpen(false);
            setGalleryTab("gallery");
          }}
          onInsert={insertTemplate}
          onError={api.onError}
        />
      )}
    </>
  );
  const styleButtons = (
    <ItemTools
      selected={selected}
      items={items}
      canGroup={canGroup}
      canUngroup={canUngroup}
      editingText={!!api.editing}
      onGroup={group}
      onUngroup={ungroup}
      set={set}
      onList={onList}
      onTextLink={onTextLink}
      onTags={(id, list) => api.change(() => api.setProps(id, { tags: list.length ? list : undefined }))}
      onCopyLink={copyLink}
      onCrop={setCropId}
      onExport={() => setExportScope({ kind: "selection" })}
      onSaveTemplate={() => {
        setGalleryTab("save");
        api.setTemplatesOpen(true);
      }}
    />
  );
  const viewActions: ExtraAction[] = [
    {
      key: "frames",
      label: t("Rahmenübersicht", "Frames"),
      title: t("Rahmen: Übersicht, Reihenfolge der Präsentation, Notizen", "Frames: overview, presentation order, notes"),
      icon: <FrameCorners size={16} />,
      active: framesOpen,
      pressed: framesOpen,
      run: () => setFramesOpen((v) => !v),
    },
    {
      key: "minimap",
      label: t("Minikarte", "Minimap"),
      title: t("Minikarte", "Minimap"),
      icon: <MapTrifold size={16} />,
      active: minimap,
      pressed: minimap,
      keepOpen: true,
      run: () =>
        setMinimap((v) => {
          store("flowplan-board-minimap", !v);
          return !v;
        }),
    },
    {
      key: "search",
      label: t("Suchen", "Search"),
      title: t("Auf dem Board suchen (Strg/⌘+F)", "Search the board (Ctrl/⌘+F)"),
      icon: <MagnifyingGlass size={16} />,
      active: searchOpen,
      pressed: searchOpen,
      run: () => (searchOpen ? closeSearch() : setSearchOpen(true)),
    },
  ];
  const insertActions: ExtraAction[] = editable
    ? [
        {
          key: "embed",
          label: t("Einbetten", "Embed"),
          title: t("Video, Webseite oder PDF einbetten", "Embed a video, web page or PDF"),
          icon: <PlayCircle size={18} />,
          run: () => setEmbedOpen(true),
        },
      ]
    : [];
  const exportActions: ExtraAction[] = [
    {
      key: "export",
      label: t("Exportieren … (PNG, SVG, PDF)", "Export … (PNG, SVG, PDF)"),
      title: t("Board, Auswahl oder Rahmen als PNG (1×, 2×, 4×), SVG oder PDF", "Board, selection or frame as PNG (1×, 2×, 4×), SVG or PDF"),
      icon: <DownloadSimple size={16} />,
      run: () => setExportScope(selection.size ? { kind: "selection" } : { kind: "board" }),
    },
  ];
  const presentControls = (
    <>
      <button
        aria-label={t("Sprechernotizen", "Speaker notes")}
        title={t("Sprechernotizen", "Speaker notes")}
        aria-pressed={notesShown}
        className={notesShown ? "active" : undefined}
        onClick={() => setNotesShown((v) => !v)}
      >
        <Notepad size={18} />
      </button>
      <button aria-label={t("Referentenansicht", "Presenter view")} title={t("Referentenansicht in neuem Fenster", "Presenter view in a new window")} onClick={openPresenter}>
        <Monitor size={18} />
      </button>
    </>
  );
  return {
    onKeyDown,
    onEditorKey,
    onPointerDownCapture,
    onDoubleClickItem,
    onMove,
    onUp,
    unitFor: (item: WhiteboardItem) => selectionUnit(item, items, entered),
    expand: (ids: Iterable<string>) => expandSelection(ids, items, entered),
    resetGroup: () => setEntered(null),
    remapForCopy: <T extends WhiteboardItem>(list: T[]) => remapGroups(list, () => crypto.randomUUID()),
    itemClass,
    worldLayer,
    overlays,
    styleButtons,
    viewActions,
    insertActions,
    exportActions,
    presentControls,
    addPdf,
  };
}
