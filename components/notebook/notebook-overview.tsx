"use client";
// The page overview of a notebook ("Seitenübersicht", toolbar or ⌘⇧O): every
// sheet as a picture in a grid that only draws the rows in view (1000
// sheets stay smooth), with
//  - a bookmark per sheet (ribbon) and the filter "Nur Lesezeichen",
//  - search in the sheets' text – titles, typed text and the handwriting
//    recognised in the app – that marks the sheets found,
//  - reordering: drag with the mouse, hold and drag with a finger or the
//    Pencil, or Alt + arrow keys; several selected sheets move together,
//  - a selection mode (all, none, Shift for a range, ⌘/Ctrl to add one)
//    with actions for the selection: duplicate, move or copy into another
//    notebook, bookmark, paper, export as PDF, delete (undo from the notice),
//  - the menu of each sheet, and the tab "Inhalt" (notebook-outline.tsx).
// Pure helpers: lib/notebook-organize-model.ts.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsDownUp,
  BookmarkSimple,
  CaretDown,
  CaretUp,
  CheckSquare,
  CopySimple,
  DotsThreeVertical,
  FileArrowDown,
  FolderSimple,
  MagnifyingGlass,
  Rows,
  Square,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useT } from "../i18n";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { gridColumns, gridWindow, moveMany, rangeSelect, searchSheets, type OutlineEntry } from "@/lib/notebook-organize-model";
import type { InkDoc } from "@/lib/ink/model";
import type { PageSize } from "@/lib/ink/coords";
import type { Paper, PaperLayout } from "@/lib/notebook-paper";
import type { NotebookSheet } from "@/lib/notebook";
import { BookmarkRibbon, SheetPicture } from "./sheet-thumb";
import { NotebookOutline } from "./notebook-outline";

export type OverviewActions = {
  show: (sheetId: string, y?: number) => void;
  move: (order: string[]) => Promise<void> | void;
  duplicate: (ids: string[]) => Promise<void> | void;
  remove: (ids: string[]) => Promise<void> | void;
  bookmark: (ids: string[], on: boolean) => Promise<void> | void;
  paper: (ids: string[]) => void;
  exportPdf: (ids: string[]) => Promise<void> | void;
  transfer: (ids: string[]) => void;
  outline: (next: OutlineEntry[]) => Promise<void> | void;
  addChapter: (sheetId: string) => void;
};

const GAP = 14;
const CAPTION = 40;
// Hold this long before a finger or the Pencil picks a sheet up (ms).
const HOLD_MS = 420;

type Drag = { ids: string[]; x: number; y: number; to: number | null };
type Press = { pointer: number; sheet: string; x: number; y: number; type: string; timer: ReturnType<typeof setTimeout> | null };

export function NotebookOverview({
  sheets,
  sizes,
  layouts,
  doc,
  recognized,
  outline,
  current,
  canEdit,
  tab,
  onTab,
  actions,
  sheetMenu,
  onClose,
}: {
  sheets: NotebookSheet[];
  sizes: Map<string, PageSize>;
  layouts: Map<string, { paper: Paper; layout: PaperLayout | null }>;
  doc: InkDoc;
  recognized: Record<string, string>;
  outline: OutlineEntry[];
  current: string;
  canEdit: boolean;
  tab: "pages" | "outline";
  onTab: (tab: "pages" | "outline") => void;
  actions: OverviewActions;
  // The menu of one sheet (the same as in the side strip).
  sheetMenu: (sheet: NotebookSheet, index: number, close: () => void) => React.ReactNode;
  onClose: () => void;
}) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const order = useMemo(() => sheets.map((s) => s.id), [sheets]);
  const indexOf = useMemo(() => new Map(order.map((sid, i) => [sid, i])), [order]);

  // ---- Filter and search ----
  const [onlyBookmarks, setOnlyBookmarks] = useState(false);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => (onlyBookmarks ? sheets.filter((s) => s.bookmark) : sheets), [sheets, onlyBookmarks]);
  const texts = useMemo(
    () =>
      sheets.map((s) => ({
        id: s.id,
        text: [
          s.title || "",
          ...(doc.pages[s.id] || []).flatMap((item) => (item.type === "text" ? [item.text] : [])),
          recognized[s.id] || "",
          ...(s.links || []).map((l) => l.label || ""),
        ].join("\n"),
      })),
    [sheets, doc, recognized],
  );
  const matches = useMemo(() => new Set(searchSheets(texts, query)), [texts, query]);
  const matchList = useMemo(() => shown.filter((s) => matches.has(s.id)).map((s) => s.id), [shown, matches]);
  const [matchAt, setMatchAt] = useState(0);
  useEffect(() => setMatchAt(0), [query]);

  // ---- Selection ----
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  useEffect(() => {
    // Sheets that went (deleted, moved away) leave the selection.
    setSelected((s) => {
      const next = new Set([...s].filter((sid) => indexOf.has(sid)));
      return next.size === s.size ? s : next;
    });
  }, [indexOf]);
  const toggle = (sid: string, range = false) => {
    setSelected((s) => {
      if (range) return rangeSelect(shown.map((x) => x.id), anchor.current, sid, s);
      const next = new Set(s);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
    if (!range) anchor.current = sid;
  };
  const chosen = useMemo(() => order.filter((sid) => selected.has(sid)), [order, selected]);
  const endSelection = () => {
    setSelecting(false);
    setSelected(new Set());
    anchor.current = null;
  };

  // ---- Grid ----
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLOListElement>(null);
  const [box, setBox] = useState({ width: 800, height: 600, top: 0 });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setBox((b) => ({ ...b, width: el.clientWidth - 24, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab]);
  const min = box.width < 420 ? 104 : 148;
  const columns = gridColumns(box.width, min, GAP);
  const cellWidth = Math.floor((box.width - GAP * (columns - 1)) / columns);
  const pictureHeight = Math.round((cellWidth - 12) * 1.42);
  const rowHeight = pictureHeight + CAPTION + GAP;
  const view = gridWindow({ count: shown.length, columns, rowHeight, scrollTop: box.top, height: box.height, overscan: 2 });
  const cellAt = (i: number) => ({ left: (i % columns) * (cellWidth + GAP), top: Math.floor(i / columns) * rowHeight });
  const scrollToIndex = useCallback(
    (i: number, center = false) => {
      const el = scroller.current;
      if (!el || i < 0) return;
      const top = Math.floor(i / columns) * rowHeight;
      if (center) el.scrollTop = Math.max(0, top - el.clientHeight / 2 + rowHeight / 2);
      else if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
    },
    [columns, rowHeight],
  );
  // Opening: the current sheet in view.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || tab !== "pages" || !scroller.current) return;
    opened.current = true;
    scrollToIndex(shown.findIndex((s) => s.id === current), true);
  }, [current, scrollToIndex, shown, tab]);
  const goToMatch = (step: number) => {
    if (!matchList.length) return;
    const next = (matchAt + step + matchList.length) % matchList.length;
    setMatchAt(next);
    const i = shown.findIndex((s) => s.id === matchList[next]);
    scrollToIndex(i, true);
    setFocus(i);
  };

  // ---- Keyboard focus (roving: one cell in the tab order) ----
  const [focus, setFocus] = useState(() => Math.max(0, shown.findIndex((s) => s.id === current)));
  const wantFocus = useRef(false);
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    inner.current?.querySelector<HTMLElement>(`[data-index="${focus}"] .notebook-cell-open`)?.focus({ preventScroll: true });
  });
  const focusAt = (i: number) => {
    const next = Math.max(0, Math.min(shown.length - 1, i));
    setFocus(next);
    scrollToIndex(next);
    wantFocus.current = true;
  };
  const canReorder = canEdit && !onlyBookmarks;
  const nudge = async (sid: string, delta: number) => {
    // The selection moves together when the sheet is part of it.
    const ids = selected.has(sid) ? chosen : [sid];
    const first = indexOf.get(ids[0]) ?? 0;
    const last = indexOf.get(ids[ids.length - 1]) ?? 0;
    const to = delta < 0 ? Math.max(0, first + delta) : Math.min(order.length, last + 1 + delta);
    const next = moveMany(order, ids, to);
    if (next.join() === order.join()) return;
    await actions.move(next);
    focusAt(next.indexOf(sid));
  };
  const onCellKey = (event: React.KeyboardEvent, sheet: NotebookSheet, i: number) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns } as Record<string, number>;
    if (event.key in step) {
      event.preventDefault();
      event.stopPropagation();
      if (event.altKey && canReorder) void nudge(sheet.id, step[event.key]);
      else {
        focusAt(i + step[event.key]);
        if (event.shiftKey && selecting) toggle(shown[Math.max(0, Math.min(shown.length - 1, i + step[event.key]))].id, true);
      }
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusAt(event.key === "Home" ? 0 : shown.length - 1);
    } else if (event.key === " " && selecting) {
      event.preventDefault();
      toggle(sheet.id, event.shiftKey);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && canEdit) {
      event.preventDefault();
      setSelecting(true);
      setSelected(new Set(shown.map((s) => s.id)));
    }
  };

  // ---- Drag and drop (pointer: mouse at once, finger and Pencil after holding) ----
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);
  const scrollFrame = useRef(0);
  const setDragState = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };
  const dropIndex = (x: number, y: number) => {
    const rect = inner.current?.getBoundingClientRect();
    if (!rect) return null;
    const lx = x - rect.left,
      ly = y - rect.top;
    const col = Math.max(0, Math.min(columns - 1, Math.floor(lx / (cellWidth + GAP))));
    const row = Math.max(0, Math.floor(ly / rowHeight));
    let i = row * columns + col;
    if (lx - col * (cellWidth + GAP) > cellWidth / 2) i++;
    return Math.max(0, Math.min(shown.length, i));
  };
  const autoScroll = () => {
    cancelAnimationFrame(scrollFrame.current);
    const d = dragRef.current;
    const el = scroller.current;
    if (!d || !el) return;
    const rect = el.getBoundingClientRect();
    const edge = 56;
    const speed = d.y < rect.top + edge ? -(rect.top + edge - d.y) / 3 : d.y > rect.bottom - edge ? (d.y - rect.bottom + edge) / 3 : 0;
    if (speed) {
      el.scrollTop += speed;
      setDragState({ ...d, to: dropIndex(d.x, d.y) });
    }
    scrollFrame.current = requestAnimationFrame(autoScroll);
  };
  const begin = (sid: string, x: number, y: number) => {
    const ids = selected.has(sid) ? chosen : [sid];
    setDragState({ ids, x, y, to: dropIndex(x, y) });
    navigator.vibrate?.(10);
    scrollFrame.current = requestAnimationFrame(autoScroll);
  };
  const endPress = () => {
    if (press.current?.timer) clearTimeout(press.current.timer);
    press.current = null;
  };
  const onPointerDown = (event: React.PointerEvent, sheet: NotebookSheet) => {
    if (!canReorder || (event.pointerType === "mouse" && event.button !== 0)) return;
    if ((event.target as Element).closest(".notebook-cell-tools")) return;
    endPress();
    const p: Press = { pointer: event.pointerId, sheet: sheet.id, x: event.clientX, y: event.clientY, type: event.pointerType, timer: null };
    if (event.pointerType !== "mouse")
      p.timer = setTimeout(() => {
        if (press.current !== p) return;
        p.timer = null;
        begin(p.sheet, p.x, p.y);
      }, HOLD_MS);
    press.current = p;
  };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const p = press.current;
      const d = dragRef.current;
      if (d) {
        if (p && event.pointerId !== p.pointer) return;
        setDragState({ ...d, x: event.clientX, y: event.clientY, to: dropIndex(event.clientX, event.clientY) });
        return;
      }
      if (!p || event.pointerId !== p.pointer) return;
      const moved = Math.hypot(event.clientX - p.x, event.clientY - p.y);
      if (p.type === "mouse" && moved > 6) begin(p.sheet, event.clientX, event.clientY);
      // A finger that moves before the hold is up scrolls.
      else if (p.type !== "mouse" && moved > 10 && p.timer) endPress();
    };
    const up = (event: PointerEvent) => {
      const p = press.current;
      if (p && event.pointerId !== p.pointer) return;
      endPress();
      const d = dragRef.current;
      if (!d) return;
      cancelAnimationFrame(scrollFrame.current);
      setDragState(null);
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (event.type === "pointercancel" || d.to === null) return;
      // The drop place in the shown list, as a place in the full order.
      const before = shown[d.to]?.id;
      const to = before ? order.indexOf(before) : order.length;
      const next = moveMany(order, d.ids, to);
      if (next.join() !== order.join()) void actions.move(next);
    };
    // While a sheet is held, a finger does not scroll the grid.
    const touch = (event: TouchEvent) => {
      if (dragRef.current && event.cancelable) event.preventDefault();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current) {
        event.stopPropagation();
        cancelAnimationFrame(scrollFrame.current);
        setDragState(null);
        endPress();
      }
    };
    const el = scroller.current;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
    el?.addEventListener("touchmove", touch, { passive: false });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
      el?.removeEventListener("touchmove", touch);
    };
  });
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

  // ---- Menus ----
  const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.(".notebook-menu-anchor")) setMenu(null);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [menu]);
  // Escape: the menu, then the selection, then the overview.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if ((event.target as HTMLElement | null)?.closest?.("[role=dialog]:not(.notebook-overview)")) return;
      event.stopPropagation();
      if (menu) setMenu(null);
      else if (selecting) endSelection();
      else onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });

  const [moveTo, setMoveTo] = useState<string | null>(null);
  const allBookmarked = chosen.length > 0 && chosen.every((sid) => sheets[indexOf.get(sid)!]?.bookmark);
  const count = chosen.length;
  const bulk = (fn: (ids: string[]) => unknown) => () => {
    if (count) void fn(chosen);
  };

  const cells = [];
  for (let i = view.first; i <= view.last; i++) {
    const sheet = shown[i];
    if (!sheet) continue;
    const index = indexOf.get(sheet.id)!;
    const size = sizes.get(sheet.id)!;
    const look = layouts.get(sheet.id)!;
    const at = cellAt(i);
    const isSelected = selected.has(sheet.id);
    const name = sheet.title || t(`Blatt ${index + 1}`, `Sheet ${index + 1}`);
    const portraitWidth = Math.min(cellWidth - 12, (pictureHeight * size.width) / size.height);
    cells.push(
      <li
        key={sheet.id}
        data-index={i}
        data-sheet={sheet.id}
        className={`notebook-cell${sheet.id === current ? " is-current" : ""}${isSelected ? " is-selected" : ""}${matches.has(sheet.id) ? " is-match" : ""}${
          drag?.ids.includes(sheet.id) ? " is-dragging" : ""
        }`}
        style={{ left: at.left, top: at.top, width: cellWidth, height: rowHeight - GAP }}
        onPointerDown={(e) => onPointerDown(e, sheet)}
      >
        <button
          type="button"
          className="notebook-cell-open"
          tabIndex={i === focus ? 0 : -1}
          aria-current={sheet.id === current ? "page" : undefined}
          aria-pressed={selecting ? isSelected : undefined}
          aria-label={`${t(`Blatt ${index + 1}`, `Sheet ${index + 1}`)}${sheet.title ? `: ${sheet.title}` : ""}${sheet.bookmark ? `, ${t("Lesezeichen", "Bookmark")}` : ""}${
            matches.has(sheet.id) ? `, ${t("Treffer", "Match")}` : ""
          }`}
          title={
            canReorder
              ? t("Öffnen; zum Verschieben ziehen (Finger: halten und ziehen)", "Open; drag to move (finger: hold and drag)") +
                (keyHints.visible ? ` · ${keyHints.keys("Alt+ArrowLeft")} / ${keyHints.keys("Alt+ArrowRight")}` : "")
              : undefined
          }
          onFocus={() => setFocus(i)}
          onKeyDown={(e) => onCellKey(e, sheet, i)}
          onContextMenu={(e) => e.preventDefault()}
          onClick={(e) => {
            if (suppressClick.current) return;
            if (selecting || ((e.metaKey || e.ctrlKey || e.shiftKey) && canEdit)) {
              setSelecting(true);
              toggle(sheet.id, e.shiftKey);
              return;
            }
            actions.show(sheet.id);
            onClose();
          }}
        >
          <span className="notebook-cell-picture" style={{ height: pictureHeight }}>
            <span style={{ width: portraitWidth, maxWidth: "100%" }} className="notebook-cell-frame">
              <SheetPicture
                sheet={sheet}
                size={size}
                layout={look.layout}
                dark={!sheet.background && look.paper.color === "dark"}
                doc={doc}
                width={Math.round(portraitWidth)}
                label={t(`Vorschau von Blatt ${index + 1}`, `Preview of sheet ${index + 1}`)}
              />
              {sheet.bookmark && <BookmarkRibbon label={t("Lesezeichen", "Bookmark")} />}
              {selecting && <span className="notebook-cell-check" aria-hidden="true">{isSelected ? <CheckSquare size={22} weight="fill" /> : <Square size={22} />}</span>}
            </span>
          </span>
          <span className="notebook-cell-caption">
            <span className="notebook-cell-number">{index + 1}</span>
            {sheet.title && <span className="notebook-cell-title">{sheet.title}</span>}
          </span>
        </button>
        {!selecting && (
          <div className="notebook-cell-tools">
            {canEdit && (
              <button
                type="button"
                className={`icon-button notebook-cell-mark${sheet.bookmark ? " active" : ""}`}
                tabIndex={-1}
                aria-pressed={!!sheet.bookmark}
                aria-label={sheet.bookmark ? t(`Lesezeichen von ${name} entfernen`, `Remove bookmark of ${name}`) : t(`${name} als Lesezeichen`, `Bookmark ${name}`)}
                title={sheet.bookmark ? t("Lesezeichen entfernen", "Remove bookmark") : t("Als Lesezeichen", "Bookmark")}
                onClick={() => void actions.bookmark([sheet.id], !sheet.bookmark)}
              >
                <BookmarkSimple size={16} weight={sheet.bookmark ? "fill" : "regular"} />
              </button>
            )}
            {canEdit && (
              <div className="notebook-menu-anchor">
                <button
                  type="button"
                  className="icon-button"
                  tabIndex={-1}
                  aria-label={t(`Aktionen für Blatt ${index + 1}`, `Actions for sheet ${index + 1}`)}
                  aria-haspopup="menu"
                  aria-expanded={menu === sheet.id}
                  onClick={() => setMenu(menu === sheet.id ? null : sheet.id)}
                >
                  <DotsThreeVertical size={16} weight="bold" />
                </button>
                {menu === sheet.id && sheetMenu(sheet, index, () => setMenu(null))}
              </div>
            )}
          </div>
        )}
      </li>,
    );
  }
  // Where a dragged sheet would land.
  const marker =
    drag && drag.to !== null
      ? (() => {
          const i = Math.min(drag.to, shown.length);
          const at = i < shown.length ? cellAt(i) : cellAt(Math.max(0, shown.length - 1));
          const left = i < shown.length ? at.left - GAP / 2 - 2 : at.left + cellWidth + GAP / 2 - 2;
          return <span className="notebook-drop-marker" style={{ left, top: at.top, height: rowHeight - GAP }} aria-hidden="true" />;
        })()
      : null;

  return (
    <section className="notebook-overview" role="dialog" aria-modal="false" aria-label={t("Seitenübersicht", "Page overview")}>
      <header className="notebook-overview-head">
        <div className="notebook-tabs" role="tablist" aria-label={t("Ansicht", "View")}>
          <button type="button" role="tab" aria-selected={tab === "pages"} className={tab === "pages" ? "active" : ""} onClick={() => onTab("pages")}>
            {t("Seiten", "Pages")}
          </button>
          <button type="button" role="tab" aria-selected={tab === "outline"} className={tab === "outline" ? "active" : ""} onClick={() => onTab("outline")}>
            {t("Inhalt", "Contents")}
          </button>
        </div>
        {tab === "pages" && (
          <>
            <div className="notebook-search" role="search">
              <MagnifyingGlass size={16} aria-hidden="true" />
              <input
                type="search"
                value={query}
                placeholder={t("Im Notizbuch suchen", "Search the notebook")}
                aria-label={t("Im Notizbuch suchen", "Search the notebook")}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    goToMatch(e.shiftKey ? -1 : 1);
                  }
                }}
              />
            </div>
            {query.trim() && (
              <span className="notebook-search-count" role="status">
                {matchList.length ? t(`${matchAt + 1} von ${matchList.length}`, `${matchAt + 1} of ${matchList.length}`) : t("Keine Treffer", "No matches")}
                <button type="button" className="icon-button" aria-label={t("Vorheriger Treffer", "Previous match")} disabled={!matchList.length} onClick={() => goToMatch(-1)}>
                  <CaretUp size={14} />
                </button>
                <button type="button" className="icon-button" aria-label={t("Nächster Treffer", "Next match")} disabled={!matchList.length} onClick={() => goToMatch(1)}>
                  <CaretDown size={14} />
                </button>
              </span>
            )}
            <button
              type="button"
              className={`notebook-chip${onlyBookmarks ? " active" : ""}`}
              aria-pressed={onlyBookmarks}
              onClick={() => {
                setOnlyBookmarks((on) => !on);
                setFocus(0);
              }}
            >
              <BookmarkSimple size={15} weight={onlyBookmarks ? "fill" : "regular"} /> {t("Nur Lesezeichen", "Bookmarks only")}
            </button>
            {canEdit && (
              <button type="button" className={`notebook-chip${selecting ? " active" : ""}`} aria-pressed={selecting} onClick={() => (selecting ? endSelection() : setSelecting(true))}>
                <CheckSquare size={15} /> {selecting ? t("Fertig", "Done") : t("Auswählen", "Select")}
              </button>
            )}
          </>
        )}
        <button type="button" className="icon-button notebook-overview-close" aria-label={t("Übersicht schließen", "Close overview")} title={t("Übersicht schließen", "Close overview") + keyHints.suffix("Escape")} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      {tab === "pages" && selecting && (
        <div className="notebook-selection-bar" role="toolbar" aria-label={t("Auswahl", "Selection")}>
          <span className="notebook-selection-count" role="status">
            {t(`${count} ausgewählt`, `${count} selected`)}
          </span>
          <button type="button" className="text-button" onClick={() => setSelected(new Set(shown.map((s) => s.id)))}>
            {t("Alle", "All")}
          </button>
          <button type="button" className="text-button" disabled={!count} onClick={() => setSelected(new Set())}>
            {t("Keine", "None")}
          </button>
          <span className="notebook-selection-actions">
            <button type="button" disabled={!count} onClick={bulk(actions.duplicate)}>
              <CopySimple size={16} /> {t("Duplizieren", "Duplicate")}
            </button>
            <button type="button" disabled={!count} onClick={bulk((ids) => actions.bookmark(ids, !allBookmarked))}>
              <BookmarkSimple size={16} weight={allBookmarked ? "fill" : "regular"} /> {allBookmarked ? t("Lesezeichen entfernen", "Remove bookmark") : t("Als Lesezeichen", "Bookmark")}
            </button>
            <button type="button" disabled={!count || onlyBookmarks} onClick={() => count && setMoveTo(String((indexOf.get(chosen[0]) ?? 0) + 1))}>
              <ArrowsDownUp size={16} /> {t("An Stelle …", "To position …")}
            </button>
            <button type="button" disabled={!count} onClick={bulk(actions.transfer)}>
              <FolderSimple size={16} /> {t("In anderes Notizbuch …", "To another notebook …")}
            </button>
            <button type="button" disabled={!count || chosen.every((sid) => sheets[indexOf.get(sid)!]?.background)} onClick={bulk(actions.paper)}>
              <Rows size={16} /> {t("Papier …", "Paper …")}
            </button>
            <button type="button" disabled={!count} onClick={bulk(actions.exportPdf)}>
              <FileArrowDown size={16} /> {t("Als PDF", "As PDF")}
            </button>
            <button type="button" className="danger" disabled={!count || count >= sheets.length} onClick={bulk(actions.remove)}>
              <Trash size={16} /> {t("Löschen", "Delete")}
            </button>
          </span>
        </div>
      )}
      {tab === "pages" ? (
        <div className="notebook-overview-grid" ref={scroller} onScroll={(e) => {
            const top = e.currentTarget.scrollTop;
            setBox((b) => ({ ...b, top }));
          }}>
          {shown.length ? (
            <ol ref={inner} style={{ height: view.total }} aria-label={t("Blätter", "Sheets")}>
              {cells}
              {marker}
            </ol>
          ) : (
            <p className="notebook-overview-empty">
              {onlyBookmarks
                ? t("Noch keine Lesezeichen. Tippe auf das Lesezeichen an einem Blatt.", "No bookmarks yet. Tap the bookmark on a sheet.")
                : t("Keine Blätter.", "No sheets.")}
            </p>
          )}
          {drag && (
            <span className="notebook-drag-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
              {drag.ids.length > 1 ? t(`${drag.ids.length} Blätter`, `${drag.ids.length} sheets`) : t(`Blatt ${(indexOf.get(drag.ids[0]) ?? 0) + 1}`, `Sheet ${(indexOf.get(drag.ids[0]) ?? 0) + 1}`)}
            </span>
          )}
        </div>
      ) : (
        <NotebookOutline
          sheets={sheets}
          outline={outline}
          current={current}
          canEdit={canEdit}
          onShow={(sid, y) => {
            actions.show(sid, y);
            onClose();
          }}
          onChange={actions.outline}
          onAddChapter={actions.addChapter}
        />
      )}
      {moveTo !== null && (
        <form
          className="notebook-moveto"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Math.round(Number(moveTo));
            setMoveTo(null);
            if (!Number.isFinite(n) || !count) return;
            // "To position n": the first selected sheet becomes sheet n.
            const rest = order.filter((sid) => !selected.has(sid));
            const at = Math.max(0, Math.min(rest.length, n - 1));
            const next = [...rest.slice(0, at), ...chosen, ...rest.slice(at)];
            if (next.join() !== order.join()) void actions.move(next);
            scrollToIndex(at, true);
          }}
        >
          <label>
            {count === 1 ? t("Das Blatt an Stelle", "Move the sheet to position") : t(`Die ${count} Blätter an Stelle`, `Move the ${count} sheets to position`)}
            <input type="number" min={1} max={sheets.length} value={moveTo} autoFocus onChange={(e) => setMoveTo(e.target.value)} />
          </label>
          <button type="button" className="button" onClick={() => setMoveTo(null)}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="submit" className="button primary">
            {t("Verschieben", "Move")}
          </button>
        </form>
      )}
    </section>
  );
}
