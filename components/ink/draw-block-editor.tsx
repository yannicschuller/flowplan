"use client";
// A drawing block in a document: an ink canvas over the full width with
// blank, lined or grid paper and a height that can be dragged. The ink is
// stored per block in page_ink (lib/page-ink-store.ts) with its own
// versions; saves merge with what collaborators drew at the same time.
// An existing block is drawn on only after "Zeichnen" – with the pen, a
// finger or the mouse alike (#322): until then it is a picture in the text
// that the pen scrolls like a finger. A new block starts drawing at once.
// Entered with a pen or finger, a touch shield (touch-shield.tsx) keeps the
// resting hand from the rest of the app until Done (#311). Beside
// "Zeichnen", a "…" menu deletes, duplicates and moves the block – the
// block handle is out of reach on a tablet (#322). A new block comes into
// view with its toolbar (#440); while fingers draw, two of them scroll the
// page. The palm resting on the block while the pen draws neither draws nor
// scrolls (ink-layer.tsx, lib/stylus.ts, #441). Loaded with the first
// block.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NodeViewProps } from "@tiptap/react";
import { Selection } from "@tiptap/pm/state";
import { ArrowCounterClockwise, ArrowDown, ArrowUp, Check, CopySimple, DotsThree, PencilSimple, Trash } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { api } from "../ui";
import { BlockMenu, type BlockMenuClose, type BlockMenuItem } from "../block-menu";
import { layerHost } from "../layer-host";
import { applyBlockChange } from "@/lib/block-shortcuts";
import { drawBlockChange, drawBlockMoves, revealOffset, takeHeightTip, HEIGHT_TIP_MS, type DrawBlockAction } from "@/lib/draw-block-actions";
import { popoverArea } from "../slash-menu";
import { InkLayer } from "./ink-layer";
import { InkToolbar } from "./ink-toolbar";
import { useInkEditor, useInkShortcuts } from "./use-ink-editor";
import { useEditorEditable } from "../editor-editable";
import { surfaceUrl, useSurfaceSync } from "./use-surface-sync";
import { convertSelection } from "./convert";
import { InkTouchShield } from "./touch-shield";
import { PaperSvg } from "../notebook/paper";
import { STROKE_ERASER_RADIUS } from "@/lib/ink/eraser";
import { emptyInk, parseInk, type InkDoc } from "@/lib/ink/model";
import { recognitionAvailable } from "@/lib/ink/recognition";
import { isHovering, stylusTouch } from "@/lib/stylus";
import { penTapsWithoutScribble, trackPenHover } from "./pen-hover";
import { blockPaperLayout } from "@/lib/notebook-paper";
import { DRAW_BLOCK_HEIGHTS, DRAW_BLOCK_PAPERS, DRAW_BLOCK_WIDTH, drawBlockFrom, drawBlockHeight, drawBlockId, drawBlockPaper, type DrawBlockPaper } from "@/lib/draw-block-node";
import type { DrawBlockOptions } from "./draw-block";
import { takeDrawingStart } from "./drawing-start";

const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
// The document's text gives up the focus and its DOM selection (a caret
// left in a paragraph is where Scribble writes, even without the focus).
function releaseText(text: HTMLElement) {
  const active = document.activeElement as HTMLElement | null;
  if (active && (active === text || (text.contains(active) && active.isContentEditable))) active.blur();
  const selection = window.getSelection();
  if (selection?.rangeCount && text.contains(selection.anchorNode)) selection.removeAllRanges();
}
const onInkUi = (target: EventTarget | null) => !!(target as Element | null)?.closest?.(".ink-ui");
// What scrolls the block: the document's pane (.main-scroll), a dialog, or
// the document itself.
function scrollerOf(el: HTMLElement | null): HTMLElement {
  for (let at = el?.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === "auto" || overflowY === "scroll") && at.scrollHeight > at.clientHeight) return at;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}
// The block and its toolbar (above it while drawing) into view (#440): the
// part of the screen the person sees, inside the scrolling pane, without
// the bars, the on-screen keyboard and the safe areas (popoverArea).
function revealBlock(block: HTMLElement) {
  const box = { top: Infinity, bottom: -Infinity };
  for (const el of [block, ...block.querySelectorAll<HTMLElement>(".ink-toolbar")]) {
    const r = el.getBoundingClientRect();
    if (!r.height) continue;
    box.top = Math.min(box.top, r.top);
    box.bottom = Math.max(box.bottom, r.bottom);
  }
  if (box.top === Infinity) return;
  const scroller = scrollerOf(block);
  const area = popoverArea();
  if (scroller !== document.scrollingElement && scroller !== document.documentElement) {
    const pane = scroller.getBoundingClientRect();
    area.top = Math.max(area.top, pane.top);
    area.bottom = Math.min(area.bottom, pane.bottom);
  }
  const by = revealOffset(box, area);
  if (by) scroller.scrollBy({ top: by, behavior: "instant" });
}
// How long a new block keeps coming into view: the on-screen keyboard goes
// with the text's focus and the window grows a moment later (the Android
// app resizes its web view on keyboardDidHide).
const REVEAL_MS = 1500;

export default function DrawBlockEditor({ node, editor: doc, extension, updateAttributes, getPos }: NodeViewProps) {
  const t = useT();
  const options = extension.options as DrawBlockOptions;
  const pageId = options.pageId;
  const id = drawBlockId(node.attrs.id);
  const paper = drawBlockPaper(node.attrs.paper);
  const from = drawBlockFrom(node.attrs.from);
  const [height, setHeight] = useState(drawBlockHeight(node.attrs.height));
  const resizing = useRef(false);
  useEffect(() => {
    if (!resizing.current) setHeight(drawBlockHeight(node.attrs.height));
  }, [node.attrs.height]);
  const size = useMemo(() => ({ width: DRAW_BLOCK_WIDTH, height }), [height]);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [loaded, setLoaded] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [active, setActive] = useState(false);
  // Entered by pen or touch (or, without a pointer, on a touch device):
  // the shield covers the rest of the app. Mouse users click outside to leave.
  const [shielded, setShielded] = useState(false);
  const [notice, setNotice] = useState("");
  // Live: reading mode switches the document without drawing this again.
  const editable = useEditorEditable(doc) && options.enabled;
  const ink = useInkEditor(emptyInk(), { active: active && canEdit });
  useInkShortcuts(ink, active && canEdit);
  const writable = editable && canEdit && !!id;
  const sync = useSurfaceSync({
    pageId,
    editor: ink,
    canEdit: writable,
    sizeOf: () => sizeRef.current,
    surfaces: id ? [id] : [],
    poll: 8000,
    onConflict: () => setNotice(t("Jemand hat gleichzeitig gezeichnet; beides ist erhalten.", "Someone drew at the same time; both are kept.")),
  });
  const copied = useRef(false);
  const { reset } = ink;
  const { prime } = sync;

  useEffect(() => {
    if (!id || !pageId) return;
    let alive = true;
    api<{ doc: InkDoc; version: number; canEdit: boolean; copied?: boolean }>(surfaceUrl(pageId, id) + (from ? `&from=${encodeURIComponent(from)}` : ""))
      .then((state) => {
        if (!alive) return;
        const items = parseInk(state.doc).pages[id] || [];
        const start = emptyInk();
        if (items.length) start.pages[id] = items;
        reset(start);
        // A copy saves the ink it starts with as its own.
        copied.current = !!state.copied;
        prime(id, state.version, state.copied ? [] : start.pages[id]);
        setCanEdit(state.canEdit);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
    // Loaded once per block.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, pageId]);

  // The block belongs to this page once its ink is here.
  const settled = useRef(false);
  useEffect(() => {
    if (!loaded || !writable || settled.current) return;
    if (copied.current && sync.status !== "saved") return;
    if (copied.current && sync.known(id) === 0) return;
    if (node.attrs.page === pageId && !node.attrs.from) {
      settled.current = true;
      return;
    }
    settled.current = true;
    updateAttributes({ page: pageId, from: "" });
  }, [loaded, writable, sync.status, sync, id, node.attrs.page, node.attrs.from, pageId, updateAttributes]);

  // Activation: only "Zeichnen" (#322) – editing is intentional; leaving
  // with a click outside or Done.
  const root = useRef<HTMLDivElement>(null);
  const activate = useCallback(
    (shield: boolean) => {
      if (!writable) return;
      setActive(true);
      setShielded(shield);
      // No caret in the text while the pen draws: iPadOS Scribble would turn
      // the handwriting into text there (#311).
      releaseText(doc.view.dom);
      // Keys (undo, delete) go to the drawing, not the text around it.
      requestAnimationFrame(() => {
        if (!root.current?.isConnected) return;
        releaseText(doc.view.dom);
        root.current.focus({ preventScroll: true });
      });
    },
    [writable, doc],
  );
  // Leaving: the caret goes below the block (where the text goes on); the
  // text gets the focus back only from the keyboard (Escape) – a tap on the
  // text focuses it as usual, with the on-screen keyboard.
  const finish = useCallback(
    (focusText = false) => {
      setActive(false);
      setShielded(false);
      ink.setSelection(null);
      void sync.flush();
      const block = root.current;
      if (block?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      if (doc.isDestroyed || !doc.isEditable) return;
      const at = typeof getPos === "function" ? getPos() : undefined;
      if (typeof at !== "number") return;
      try {
        const $after = doc.state.doc.resolve(Math.min(at + node.nodeSize, doc.state.doc.content.size));
        const selection = Selection.findFrom($after, 1, true) ?? Selection.findFrom($after, -1, true);
        if (!selection) return;
        if (focusText) doc.chain().setTextSelection(selection.from).focus(undefined, { scrollIntoView: false }).run();
        else doc.view.dispatch(doc.state.tr.setSelection(selection).setMeta("addToHistory", false));
      } catch {}
    },
    [ink, sync, doc, getPos, node.nodeSize],
  );
  // A block just inserted from the slash menu starts in drawing mode. The
  // first one on this device shows for a few seconds, at its top (the hand
  // covers the bottom), where its height is changed after Done (#324).
  const [tip, setTip] = useState(false);
  const revealUntil = useRef(0);
  useEffect(() => {
    if (!loaded || !writable || !id || !takeDrawingStart(id)) return;
    revealUntil.current = Date.now() + REVEAL_MS;
    activate(coarse());
    if (takeHeightTip(() => window.localStorage)) setTip(true);
  }, [loaded, writable, id, activate]);
  useEffect(() => {
    if (!tip) return;
    const timer = window.setTimeout(() => setTip(false), HEIGHT_TIP_MS);
    return () => window.clearTimeout(timer);
  }, [tip]);
  useEffect(() => {
    if (!active) setTip(false);
  }, [active]);
  // The new block comes into view with its toolbar (#440) – again while the
  // keyboard goes and the window grows, until the person touches, scrolls
  // or types.
  useEffect(() => {
    const block = root.current;
    if (!active || !block || revealUntil.current < Date.now()) return;
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (Date.now() > revealUntil.current || !block.isConnected) return stop();
        revealBlock(block);
      });
    };
    const resized = new ResizeObserver(reveal);
    const stop = () => {
      revealUntil.current = 0;
      detach();
    };
    const detach = () => {
      window.clearTimeout(timer);
      resized.disconnect();
      window.removeEventListener("resize", reveal);
      window.visualViewport?.removeEventListener("resize", reveal);
      for (const type of ["pointerdown", "wheel", "keydown"]) window.removeEventListener(type, stop, true);
    };
    const timer = window.setTimeout(stop, Math.max(0, revealUntil.current - Date.now()));
    resized.observe(block);
    window.addEventListener("resize", reveal);
    window.visualViewport?.addEventListener("resize", reveal);
    for (const type of ["pointerdown", "wheel", "keydown"]) window.addEventListener(type, stop, true);
    reveal();
    return () => {
      cancelAnimationFrame(frame);
      detach();
    };
  }, [active]);
  // Stylus touches on the canvas of the block being drawn on never start
  // Scribble, the long-press callout or a text selection. Native and not
  // passive: React's are. The floating text box and bars on the canvas
  // (.ink-ui) keep their taps. Not drawing, the pen scrolls (#322).
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !writable || !active) return;
    const touch = (event: TouchEvent) => {
      if (event.cancelable && stylusTouch(event) && !onInkUi(event.target)) event.preventDefault();
    };
    const pointer = (event: PointerEvent) => {
      if (event.pointerType === "pen" && !onInkUi(event.target)) event.preventDefault();
    };
    surface.addEventListener("touchstart", touch, { passive: false });
    surface.addEventListener("pointerdown", pointer);
    return () => {
      surface.removeEventListener("touchstart", touch);
      surface.removeEventListener("pointerdown", pointer);
    };
  }, [writable, loaded, active]);
  // The hovering Pencil (#315): its controls light up under it, pen taps on
  // them feed no Scribble, and a dot shows where it would draw.
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const block = root.current;
    if (!block || !writable) return;
    const stops = [trackPenHover(block), penTapsWithoutScribble(block, (target) => !activeRef.current && !!target.closest(".ink-block-surface"))];
    return () => stops.forEach((stop) => stop());
  }, [writable]);
  const inkRef = useRef(ink);
  inkRef.current = ink;
  const dotRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const surface = surfaceRef.current,
      dot = dotRef.current;
    if (!surface || !dot || !writable || !active) return;
    const hide = () => dot.classList.remove("is-shown");
    const move = (event: PointerEvent) => {
      if (!isHovering(event) || (event.target as Element | null)?.closest?.(".ink-ui")) return hide();
      const box = surface.getBoundingClientRect();
      const { tool, style, eraserMode, eraserSize } = inkRef.current;
      // The eraser's ring is as wide as what it takes (#315): the partial
      // eraser's size, the whole-stroke kinds' fixed radius (screen pixels,
      // as in ink-layer.tsx).
      const radius = eraserMode === "partial" ? eraserSize : STROKE_ERASER_RADIUS;
      dot.style.setProperty("--dot-size", `${radius * 2}px`);
      dot.style.setProperty("--dot-x", `${event.clientX - box.left}px`);
      dot.style.setProperty("--dot-y", `${event.clientY - box.top}px`);
      dot.style.setProperty("--dot-color", tool === "pen" || tool === "highlighter" || tool === "shape" || tool === "text" ? style.color : "var(--secondary)");
      dot.dataset.tool = tool;
      dot.classList.add("is-shown");
    };
    surface.addEventListener("pointerover", move);
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerdown", hide, true);
    surface.addEventListener("pointerleave", hide);
    return () => {
      hide();
      surface.removeEventListener("pointerover", move);
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerdown", hide, true);
      surface.removeEventListener("pointerleave", hide);
    };
  }, [writable, loaded, active]);
  // The listeners stay registered while drawing, with the latest `finish`
  // from a ref: `finish` changes with every save of the ink, and a listener
  // replaced while the browser is dispatching the event (another listener's
  // state update re-renders the block in between) neither hears it nor does
  // the new one – an Escape right after a stroke was lost.
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    if (!active) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (root.current?.contains(target) || target?.closest?.(".ink-menu, .modal, .ink-shield")) return;
      // The block flung out of sight: the shield lets touches through to
      // scroll back to it (#322), and drawing goes on until Done.
      if (event.pointerType !== "mouse" && document.querySelector(".ink-shield.is-away")) return;
      finishRef.current();
    };
    // Escape ends drawing once nothing inside wants it (a selection, a menu).
    const escape = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (event.key !== "Escape" || event.defaultPrevented || target?.closest?.(".ink-menu, .modal")) return;
      if (document.querySelector(".modal")) return;
      event.preventDefault();
      finishRef.current(true);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape);
    };
  }, [active]);

  // Height: drag the handle (or arrow keys on it).
  const scale = useRef(1);
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!writable) return;
    event.preventDefault();
    const surface = root.current?.querySelector<HTMLElement>(".ink-block-surface");
    scale.current = (surface?.clientWidth || DRAW_BLOCK_WIDTH) / DRAW_BLOCK_WIDTH;
    const startY = event.clientY,
      startHeight = height;
    resizing.current = true;
    const move = (e: PointerEvent) => setHeight(drawBlockHeight(startHeight + (e.clientY - startY) / (scale.current || 1)));
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      resizing.current = false;
      updateAttributes({ height: drawBlockHeight(startHeight + (e.clientY - startY) / (scale.current || 1)) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const resizeKey = (event: React.KeyboardEvent) => {
    if (!writable || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const next = drawBlockHeight(height + (event.key === "ArrowDown" ? 40 : -40));
    setHeight(next);
    updateAttributes({ height: next });
  };

  // The "…" menu beside "Zeichnen" (#322): the block's own way to be
  // deleted, duplicated and moved where its handle is out of reach.
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const position = () => {
    const at = typeof getPos === "function" ? getPos() : undefined;
    return typeof at === "number" ? at : null;
  };
  const blockAction = (action: DrawBlockAction) => {
    const at = position();
    if (at === null || !doc.isEditable) return;
    const tr = drawBlockChange(doc.state, at, action);
    if (!tr) return;
    applyBlockChange(doc, tr);
    // Moved, the block is drawn anew: its "…" keeps the focus for the next
    // step from the keyboard.
    if (action === "up" || action === "down")
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-ink-block="${CSS.escape(id)}"] .ink-block-more`)?.focus({ preventScroll: true }));
  };
  const menuItems = (): BlockMenuItem[] => {
    const at = position();
    const moves = at === null ? { up: false, down: false } : drawBlockMoves(doc.state, at);
    return [
      { icon: <ArrowUp />, label: t("Nach oben", "Move up"), disabled: !moves.up, run: () => blockAction("up") },
      { icon: <ArrowDown />, label: t("Nach unten", "Move down"), disabled: !moves.down, run: () => blockAction("down") },
      { icon: <CopySimple />, label: t("Duplizieren", "Duplicate"), run: () => blockAction("duplicate") },
      {
        icon: <ArrowCounterClockwise />,
        label: t("Höhe zurücksetzen", "Reset height"),
        disabled: height === DRAW_BLOCK_HEIGHTS.default,
        run: () => {
          setHeight(DRAW_BLOCK_HEIGHTS.default);
          updateAttributes({ height: DRAW_BLOCK_HEIGHTS.default });
        },
      },
      "separator",
      { icon: <Trash />, label: t("Löschen", "Delete"), danger: true, run: () => blockAction("delete") },
    ];
  };
  const closeMenu = (reason?: BlockMenuClose) => {
    setMenu(null);
    if (reason === "escape") moreRef.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (active || !writable) setMenu(null);
  }, [active, writable]);

  // Convert to text: a paragraph below the block.
  const [canRecognize, setCanRecognize] = useState(false);
  useEffect(() => setCanRecognize(recognitionAvailable()), []);
  const convert = async () => {
    const result = await convertSelection(ink, sizeRef.current, (text) => {
      const at = typeof getPos === "function" ? getPos() : undefined;
      if (typeof at !== "number") return;
      const paragraphs = text
        .split(/\n+/)
        .filter((line) => line.trim())
        .map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] }));
      doc.chain().insertContentAt(at + node.nodeSize, paragraphs).run();
    });
    if (result === "empty") setNotice(t("In der Auswahl wurde kein Text erkannt.", "No text was recognised in the selection."));
    if (result === "failed") setNotice(t("Die Handschrift konnte nicht erkannt werden.", "The handwriting could not be recognised."));
  };

  const layout = useMemo(() => blockPaperLayout(paper, size), [paper, size]);
  const paperName = (value: DrawBlockPaper) => ({ blank: t("Leer", "Blank"), lined: t("Liniert", "Lined"), grid: t("Kariert", "Grid||paper") })[value];
  const status =
    sync.status === "saving" ? t("Wird gespeichert …", "Saving …") : sync.status === "dirty" ? t("Nicht gespeichert", "Not saved") : sync.status === "error" ? t("Nicht gespeichert – neuer Versuch folgt", "Not saved – trying again") : t("Gespeichert", "Saved");
  return (
    <div
      ref={root}
      tabIndex={-1}
      className={`ink-block${active ? " is-active" : ""}`}
      role="group"
      aria-label={t("Handschrift", "Handwriting")}
      onDragStart={(e) => e.preventDefault()}
      onPointerDownCapture={(e) => {
        if (!writable) return;
        const touch = e.pointerType === "pen" || e.pointerType === "touch";
        // A pen or finger on a block entered with the mouse: the hand rests now.
        if (active) {
          if (touch && !shielded) setShielded(true);
          return;
        }
        if ((e.target as Element).closest(".ink-block-resize, .ink-block-actions")) return;
        // Nothing on the surface enters drawing (#322): a pen, a finger or a
        // mouse on an existing block scrolls the document or does nothing;
        // "Zeichnen" starts drawing. The event stops here; its default
        // (scrolling, text selection) stays.
        e.stopPropagation();
      }}
    >
      {active && writable && (
        <InkToolbar editor={ink} label={t("Zeichenwerkzeuge", "Drawing tools")}>
          <label className="ink-block-paper">
            <select value={paper} aria-label={t("Papier", "Paper")} onChange={(e) => updateAttributes({ paper: drawBlockPaper(e.target.value) })}>
              {DRAW_BLOCK_PAPERS.map((value) => (
                <option key={value} value={value}>
                  {paperName(value)}
                </option>
              ))}
            </select>
          </label>
          <span className="ink-status" role="status">
            {status}
          </span>
          <button
            type="button"
            className="ink-done"
            onClick={() => finish()}
          >
            <Check size={17} />
            <span>{t("Fertig", "Done")}</span>
          </button>
        </InkToolbar>
      )}
      {!active && writable && loaded && (
        <div className="ink-block-actions">
          <button type="button" className="ink-block-start" onClick={() => activate(coarse())}>
            <PencilSimple size={16} /> {t("Zeichnen", "Draw")}
          </button>
          <button
            ref={moreRef}
            type="button"
            className="ink-block-more"
            aria-label={t("Weitere Aktionen für den Zeichenblock", "More actions for the drawing block")}
            title={t("Weitere Aktionen", "More actions")}
            aria-haspopup="menu"
            aria-expanded={!!menu}
            onClick={(e) => {
              const anchor = e.currentTarget.getBoundingClientRect();
              setMenu((open) => (open ? null : anchor));
            }}
          >
            <DotsThree size={18} weight="bold" />
          </button>
        </div>
      )}
      {menu &&
        !active &&
        writable &&
        createPortal(
          <BlockMenu
            anchor={menu}
            owner={moreRef.current}
            placement="below"
            label={t("Zeichenblock", "Drawing block")}
            className="ink-block-menu"
            views={{ main: { title: t("Zeichenblock", "Drawing block"), items: menuItems() } }}
            onClose={closeMenu}
          />,
          layerHost(moreRef.current),
        )}
      {tip && active && (
        // Any press on it dismisses it (a pen's too: its taps give no click
        // outside buttons, pen-hover.ts).
        <div className="ink-block-tip" role="status" aria-live="polite" onPointerDown={() => setTip(false)}>
          <span>{t("Tipp: Nach „Fertig“ änderst du die Höhe am unteren Rand.", "Tip: After “Done”, change the height at the bottom edge.")}</span>
          <button type="button" className="ink-block-tip-close" aria-label={t("Hinweis schließen", "Dismiss")} onClick={() => setTip(false)}>
            ×
          </button>
        </div>
      )}
      {active && writable && shielded && <InkTouchShield block={root} onDone={finish} />}
      {notice && (
        <p className="notebook-notice" role="status">
          {notice}
          <button type="button" className="icon-button" aria-label={t("Hinweis schließen", "Dismiss")} onClick={() => setNotice("")}>
            ×
          </button>
        </p>
      )}
      <div ref={surfaceRef} className="ink-block-surface" style={{ aspectRatio: `${DRAW_BLOCK_WIDTH} / ${height}` }}>
        <PaperSvg layout={layout} />
        {loaded && (
          <InkLayer
            page={id}
            size={size}
            editor={ink}
            editing={writable && active}
            fingersScroll={!active}
            // Fingers drawing (no pen yet): two of them scroll the page,
            // also while the shield holds the rest of it (#440).
            onPan={active ? (_dx, dy) => scrollerOf(root.current).scrollBy({ top: dy, behavior: "instant" }) : undefined}
            onConvert={writable && canRecognize ? () => void convert() : undefined}
            aiPageId={writable ? pageId : undefined}
            label={t("Handschrift", "Handwriting")}
          />
        )}
        {writable && active && <div ref={dotRef} className="ink-pen-dot" aria-hidden="true" />}
      </div>
      {/* Only while not drawing (#324): a palm resting on the block's edge
          must not change its height mid-stroke. */}
      {writable && !active && (
        <div
          className="ink-block-resize"
          role="separator"
          aria-orientation="horizontal"
          tabIndex={0}
          aria-label={t("Höhe der Zeichnung", "Height of the drawing")}
          aria-valuemin={DRAW_BLOCK_HEIGHTS.min}
          aria-valuemax={DRAW_BLOCK_HEIGHTS.max}
          aria-valuenow={height}
          title={t("Ziehen, um die Höhe zu ändern", "Drag to change the height")}
          onPointerDown={startResize}
          onKeyDown={resizeKey}
        />
      )}
    </div>
  );
}
