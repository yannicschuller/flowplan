"use client";
// The state of an ink editing session shared by the ink layers of all pages
// and the toolbar: the ink, undo/redo, tool, colours, favourites, selection
// and clipboard. See lib/ink/README.md.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { copyItems, itemBounds, recolorItems, unionBox } from "@/lib/ink/geometry";
import { emptyHistory, record, redo as redoStep, undo as undoStep, type History } from "@/lib/ink/history";
import { withPage, type InkDoc, type InkItem } from "@/lib/ink/model";
import { inkClipboard, setInkClipboard, subscribeInkClipboard } from "@/lib/ink/clipboard";
import { fitOnPage, reorderItems, setItemsWidth, transformSelected, translation, type Affine } from "@/lib/ink/selection";
import type { PageSize } from "@/lib/ink/coords";
import { writeSystemClipboard } from "./system-clipboard";
import {
  DEFAULT_PRESETS,
  HIGHLIGHTER_COLORS,
  HIGHLIGHTER_WIDTHS,
  PEN_COLORS,
  PEN_WIDTHS,
  TEXT_SIZES,
  WIDTH_RANGES,
  loadRecentColors,
  loadTextStyle,
  rememberColor,
  saveTextStyle,
  pencilResult,
  pencilSetting,
  setPencilSetting,
  setSnapSetting,
  snapSetting,
  type InkTool,
  type PencilSetting,
} from "@/lib/ink/presets";
import type { InkFont } from "@/lib/ink/fonts";
import { clampEraserSize, loadEraserSetting, saveEraserSetting, type EraserMode } from "@/lib/ink/eraser";
import {
  DEFAULT_FAVORITES,
  MAX_FAVORITES,
  addFavorite as addTo,
  favoriteIndex,
  loadFavorites,
  moveFavorite as moveIn,
  removeFavorite as removeFrom,
  saveFavorites,
  type InkFavorite,
} from "@/lib/ink/favorites";
import { forgetPen, onPencilAction, penOnlySetting, setPenOnly as storePenOnly } from "@/lib/stylus";

export type InkSelection = { page: string; ids: string[] };
// The picture or sticker in its frame (components/ink/ink-picture.tsx).
export type InkPicked = { page: string; id: string };
// Width: line width, or the font size of text; font: text only.
type Style = { color: string; width: number; font?: InkFont };

export type InkEditor = Awaited<ReturnType<typeof useInkEditor>>;

export function useInkEditor(initial: InkDoc, { active = true }: { active?: boolean } = {}) {
  const [doc, setDocState] = useState(initial);
  const docRef = useRef(doc);
  // History lives in a ref (updates without side effects in state
  // updaters, which React may run twice); the state only re-renders.
  const historyRef = useRef<History<InkDoc>>(emptyHistory());
  const [history, setHistoryState] = useState<History<InkDoc>>(historyRef.current);
  const setHistory = (next: History<InkDoc>) => {
    historyRef.current = next;
    setHistoryState(next);
  };
  const [saved, setSaved] = useState(initial);
  const [tool, setToolState] = useState<InkTool>("pen");
  const previousTool = useRef<InkTool>("pen");
  const [pen, setPen] = useState<Style>({ color: DEFAULT_PRESETS[0].color, width: DEFAULT_PRESETS[0].width });
  const [highlighter, setHighlighter] = useState<Style>({ color: HIGHLIGHTER_COLORS[0], width: HIGHLIGHTER_WIDTHS[1] });
  const [text, setText] = useState<Style>({ color: PEN_COLORS[0], width: TEXT_SIZES[1] });
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [favorites, setFavoritesState] = useState<InkFavorite[]>(DEFAULT_FAVORITES);
  const [eraserMode, setEraserModeState] = useState<EraserMode>("stroke");
  const [eraserSize, setEraserSizeState] = useState<number>(10);
  const [penOnly, setPenOnlyState] = useState(false);
  const [snap, setSnapState] = useState(true);
  const [pencil, setPencilState] = useState<PencilSetting>("system");
  const [selection, setSelectionState] = useState<InkSelection | null>(null);
  const [picked, setPicked] = useState<InkPicked | null>(null);
  // A selection by the lasso and a picture in its frame are never both shown.
  const setSelection = useCallback((next: InkSelection | null) => {
    setSelectionState(next);
    if (next) setPicked(null);
  }, []);
  // Shared by the ink editors of this tab (lib/ink/clipboard.ts).
  const clipboard = useSyncExternalStore(subscribeInkClipboard, inkClipboard, () => null);
  const setClipboard = setInkClipboard;
  const lastPage = useRef<string>("1");
  // The size of each page shown (InkLayer fills it in): pastes stay on the page.
  const pageSizes = useRef(new Map<string, PageSize>());
  // Choices remembered on this device.
  useEffect(() => {
    const stored = loadFavorites();
    setFavoritesState(stored);
    const firstPen = stored.find((f) => f.type === "pen");
    if (firstPen) setPen({ color: firstPen.color, width: firstPen.width });
    const eraser = loadEraserSetting();
    setEraserModeState(eraser.mode);
    setEraserSizeState(eraser.size);
    const textStyle = loadTextStyle();
    if (textStyle) setText(textStyle);
    setRecentColors(loadRecentColors());
    setPenOnlyState(penOnlySetting() === "on");
    setSnapState(snapSetting());
    setPencilState(pencilSetting());
  }, []);

  // Replaces the ink, e.g. after loading; clears undo.
  const reset = useCallback((next: InkDoc) => {
    docRef.current = next;
    setDocState(next);
    setSaved(next);
    setHistory(emptyHistory());
    setSelection(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A change the person made: one undo step.
  const commit = useCallback((next: InkDoc) => {
    const before = docRef.current;
    if (next === before) return;
    docRef.current = next;
    setDocState(next);
    setHistory(record(historyRef.current, before));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const change = useCallback(
    (page: string, fn: (items: InkItem[]) => InkItem[]) => {
      const items = docRef.current.pages[page] || [];
      const next = fn(items);
      if (next !== items) commit(withPage(docRef.current, page, next));
    },
    [commit],
  );
  // Ink of others merged in (saves, changes followed from the server): no
  // undo step, the person's own steps stay.
  const applyRemote = useCallback((page: string, items: InkItem[]) => {
    const now = docRef.current;
    if ((now.pages[page] || []) === items) return;
    const next = withPage(now, page, items);
    docRef.current = next;
    setDocState(next);
  }, []);
  const step = (direction: "undo" | "redo") => {
    const result = (direction === "undo" ? undoStep : redoStep)(historyRef.current, docRef.current);
    if (!result) return;
    docRef.current = result.state;
    setDocState(result.state);
    setHistory(result.history);
    setSelection(null);
    setPicked(null);
  };
  const undo = () => step("undo");
  const redo = () => step("redo");

  const setTool = useCallback((next: InkTool) => {
    setToolState((now) => {
      if (now !== next) previousTool.current = now;
      return next;
    });
    if (next !== "lasso") {
      setSelection(null);
      setPicked(null);
    }
  }, []);
  // The style of the tool in hand (pen, highlighter or text).
  const style = tool === "highlighter" ? highlighter : tool === "text" ? text : pen;
  const palette = tool === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const widths = tool === "highlighter" ? HIGHLIGHTER_WIDTHS : tool === "text" ? TEXT_SIZES : PEN_WIDTHS;
  // The free width (or text size) slider of the tool in hand.
  const widthRange = WIDTH_RANGES[tool === "highlighter" ? "highlighter" : tool === "text" ? "text" : "pen"];
  const setStyle = (patch: Partial<Style>) => {
    if (tool === "highlighter") setHighlighter((s) => ({ ...s, ...patch }));
    else if (tool === "text") {
      const next = { ...text, ...patch };
      setText(next);
      saveTextStyle(next);
    } else setPen((s) => ({ ...s, ...patch }));
  };
  // An own colour (the colour picker) is kept among the recent ones.
  const rememberCustomColor = (color: string) => setRecentColors((list) => rememberColor(color, list));
  // ---- Favourite pens (lib/ink/favorites.ts) ----
  // The tool and style in hand as a favourite (null: a tool without style).
  const current: InkFavorite | null =
    tool === "pen" || tool === "highlighter" || tool === "text"
      ? { type: tool, color: style.color, width: style.width, ...(tool === "text" && style.font ? { font: style.font } : {}) }
      : null;
  const favorite = favoriteIndex(favorites, current);
  const setFavorites = (next: InkFavorite[]) => {
    setFavoritesState(next);
    saveFavorites(next);
  };
  const pickFavorite = (index: number) => {
    const f = favorites[index];
    if (!f) return;
    if (f.type === "highlighter") setHighlighter({ color: f.color, width: f.width });
    else if (f.type === "text") {
      const next = { color: f.color, width: f.width, ...(f.font ? { font: f.font } : {}) };
      setText(next);
      saveTextStyle(next);
    } else setPen({ color: f.color, width: f.width });
    setTool(f.type);
  };
  // Keeps the tool and style in hand as a favourite (at the end).
  const addFavorite = () => current && setFavorites(addTo(favorites, current));
  const removeFavorite = (index: number) => setFavorites(removeFrom(favorites, index));
  const moveFavorite = (from: number, to: number) => setFavorites(moveIn(favorites, from, to));

  // ---- Eraser (lib/ink/eraser.ts) ----
  const setEraserMode = (mode: EraserMode) => {
    setEraserModeState(mode);
    saveEraserSetting({ mode, size: eraserSize });
  };
  const setEraserSize = (value: number) => {
    const size = clampEraserSize(value);
    setEraserSizeState(size);
    saveEraserSetting({ mode: eraserMode, size });
  };
  // Everything on a page goes (one undo step).
  const clearPage = (page: string) => {
    if (!docRef.current.pages[page]?.length) return;
    change(page, () => []);
    if (selection?.page === page) setSelection(null);
  };

  const setPenOnly = (on: boolean) => {
    setPenOnlyState(on);
    storePenOnly(on);
    forgetPen();
  };
  const setSnap = (on: boolean) => {
    setSnapState(on);
    setSnapSetting(on);
  };
  const setPencil = (value: PencilSetting) => {
    setPencilState(value);
    setPencilSetting(value);
  };
  // Apple Pencil double-tap and squeeze (iPad app, lib/stylus.ts).
  const toolRef = useRef(tool);
  toolRef.current = tool;
  useEffect(() => {
    if (!active) return;
    return onPencilAction((action) => {
      const result = pencilResult(pencilSetting(), action);
      const now = toolRef.current;
      if (result === "eraser") setTool(now === "eraser" ? (previousTool.current === "eraser" ? "pen" : previousTool.current) : "eraser");
      else if (result === "previous") setTool(previousTool.current === now ? "pen" : previousTool.current);
      else if (result === "pen") setTool("pen");
    });
  }, [active, setTool]);

  // ---- Selection ----
  const selectedItems = useCallback(() => {
    if (!selection) return [];
    const ids = new Set(selection.ids);
    return (docRef.current.pages[selection.page] || []).filter((i) => ids.has(i.id));
  }, [selection]);
  const deleteSelection = () => {
    if (!selection) return;
    const ids = new Set(selection.ids);
    change(selection.page, (items) => items.filter((i) => !ids.has(i.id)));
    setSelection(null);
  };
  const recolorSelection = (color: string) => {
    if (!selection) return;
    change(selection.page, (items) => recolorItems(items, new Set(selection.ids), color));
  };
  // Copies into the tab's ink clipboard and – where the browser lets it –
  // the system clipboard as a picture (PNG, SVG) and the typed text.
  const copySelection = () => {
    const items = selectedItems();
    if (items.length) {
      setClipboard(items);
      writeSystemClipboard(items);
    }
    return items.length;
  };
  const cutSelection = () => {
    const count = copySelection();
    if (count) deleteSelection();
    return count;
  };
  // One undo step: a transform of the chosen items (move, scale, turn).
  const transformSelection = (m: Affine) => {
    if (!selection) return;
    change(selection.page, (items) => transformSelected(items, new Set(selection.ids), m));
  };
  const nudgeSelection = (dx: number, dy: number) => transformSelection(translation(dx, dy));
  const reorderSelection = (where: "front" | "back") => {
    if (!selection) return;
    change(selection.page, (items) => reorderItems(items, new Set(selection.ids), where));
  };
  // Fine, medium, bold (0–2): pen and highlighter widths, text sizes.
  const setSelectionWidth = (step: number) => {
    if (!selection) return;
    change(selection.page, (items) => setItemsWidth(items, new Set(selection.ids), step));
  };
  const selectAll = (page = selection?.page || lastPage.current) => {
    const ids = (docRef.current.pages[page] || []).map((i) => i.id);
    setSelection(ids.length ? { page, ids } : null);
    if (ids.length) setTool("lasso");
  };
  // Pastes onto a page (the last one drawn on), a little offset when it
  // lands on the page it was copied from.
  const paste = (page = selection?.page || lastPage.current, items = clipboard) => {
    if (!items?.length) return;
    const existing = new Set((docRef.current.pages[page] || []).map((i) => i.id));
    const offset = items.some((i) => existing.has(i.id)) ? 12 : 0;
    const size = pageSizes.current.get(page);
    const copies = size ? fitOnPage(copyItems(items, offset, offset), size) : copyItems(items, offset, offset);
    change(page, (list) => [...list, ...copies]);
    setSelection({ page, ids: copies.map((c) => c.id) });
    setTool("lasso");
  };
  const duplicateSelection = () => {
    const items = selectedItems();
    if (selection && items.length) paste(selection.page, items);
  };
  const selectionBox = useMemo(() => {
    if (!selection) return null;
    const ids = new Set(selection.ids);
    return unionBox((doc.pages[selection.page] || []).filter((i) => ids.has(i.id)).map(itemBounds));
  }, [doc, selection]);

  return {
    doc,
    docRef,
    reset,
    commit,
    change,
    applyRemote,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    dirty: doc !== saved,
    markSaved: setSaved,
    tool,
    setTool,
    style,
    setStyle,
    palette,
    widths,
    widthRange,
    recentColors,
    rememberCustomColor,
    favorites,
    favorite,
    pickFavorite,
    addFavorite,
    removeFavorite,
    moveFavorite,
    canAddFavorite: !!current && favorite < 0 && favorites.length < MAX_FAVORITES,
    eraserMode,
    setEraserMode,
    eraserSize,
    setEraserSize,
    clearPage,
    penOnly,
    setPenOnly,
    snap,
    setSnap,
    pencil,
    setPencil,
    selection,
    setSelection,
    selectionBox,
    selectedItems,
    deleteSelection,
    recolorSelection,
    copySelection,
    cutSelection,
    transformSelection,
    nudgeSelection,
    reorderSelection,
    setSelectionWidth,
    selectAll,
    duplicateSelection,
    textStyle: text,
    pageSizes,
    paste,
    clipboard,
    lastPage,
    picked,
    // Picks a picture (null: none); the lasso is the tool for it.
    pick: (next: InkPicked | null) => {
      setPicked(next);
      if (next) {
        setSelection(null);
        setToolState("lasso");
        lastPage.current = next.page;
      }
    },
    setClipboard,
  };
}

// Keyboard shortcuts while editing: undo/redo, delete, copy, cut, paste,
// duplicate, ⌘] / ⌘[ to the front or back, arrows nudge (Shift: 10 pt),
// Escape (clears the selection before anything else closes); with `tools`
// also ⌘A (everything on the sheet).
// With `tools`, single keys pick a tool (P pen, H highlighter, E eraser,
// L lasso, T text, K laser) – for surfaces that are the whole page
// (notebooks), not inside a document where keys type text.
// Keys for the picked picture: Delete, ⌘C, ⌘D, Escape, arrows (Shift:
// further). True when the key was used.
function pickedKey(ed: InkEditor, event: KeyboardEvent, mod: boolean) {
  const picked = ed.picked!;
  const items = ed.docRef.current.pages[picked.page] || [];
  const item = items.find((i) => i.id === picked.id);
  if (!item || item.type !== "image") return false;
  const k = event.key.toLowerCase();
  if (event.key === "Delete" || event.key === "Backspace") {
    ed.pick(null);
    ed.change(picked.page, (list) => list.filter((i) => i.id !== picked.id));
  } else if (mod && k === "c") ed.setClipboard([item]);
  else if (mod && k === "d") {
    const [copy] = copyItems([item], 16, 16);
    ed.change(picked.page, (list) => [...list, copy]);
    ed.pick({ page: picked.page, id: copy.id });
  } else if (event.key === "Escape") ed.pick(null);
  else if (event.key.startsWith("Arrow") && !mod) {
    const step = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    ed.change(picked.page, (list) => list.map((i) => (i.id === picked.id && i.type === "image" ? { ...i, x: i.x + dx, y: i.y + dy } : i)));
  } else return false;
  return true;
}
export const INK_TOOL_KEYS: Record<string, InkTool> = { p: "pen", h: "highlighter", e: "eraser", l: "lasso", t: "text", k: "laser" };
export function useInkShortcuts(editor: InkEditor | null, enabled: boolean, { tools = false }: { tools?: boolean } = {}) {
  const ref = useRef(editor);
  ref.current = editor;
  const toolsRef = useRef(tools);
  toolsRef.current = tools;
  useEffect(() => {
    if (!enabled) return;
    const key = (event: KeyboardEvent) => {
      const ed = ref.current;
      if (!ed) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, [contenteditable=true], [role=dialog]")) return;
      const mod = event.metaKey || event.ctrlKey;
      const k = event.key.toLowerCase();
      if (mod && k === "z") {
        event.preventDefault();
        if (event.shiftKey) ed.redo();
        else ed.undo();
      } else if (mod && k === "y") {
        event.preventDefault();
        ed.redo();
      } else if (ed.picked && !ed.selection && pickedKey(ed, event, mod)) {
        event.preventDefault();
      } else if (ed.selection && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        ed.deleteSelection();
      } else if (mod && k === "c" && ed.selection) {
        if (ed.copySelection()) event.preventDefault();
      } else if (mod && k === "x" && ed.selection) {
        if (ed.cutSelection()) event.preventDefault();
      } else if (mod && (event.key === "]" || event.key === "[") && ed.selection) {
        event.preventDefault();
        ed.reorderSelection(event.key === "]" ? "front" : "back");
      } else if (ed.selection && !mod && event.key.startsWith("Arrow")) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key] || [0, 0];
        ed.nudgeSelection(dx, dy);
      } else if (mod && k === "a" && toolsRef.current) {
        event.preventDefault();
        ed.selectAll();
      } else if (mod && k === "v" && ed.clipboard) {
        event.preventDefault();
        ed.paste();
      } else if (mod && k === "d" && ed.selection) {
        event.preventDefault();
        ed.duplicateSelection();
      } else if (event.key === "Escape" && ed.selection) {
        event.stopPropagation();
        ed.setSelection(null);
      } else if (toolsRef.current && !mod && !event.altKey && !event.shiftKey && INK_TOOL_KEYS[k] && event.key.length === 1) {
        event.preventDefault();
        ed.setTool(INK_TOOL_KEYS[k]);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [enabled]);
}
