"use client";
// A drawing block in a document: an ink canvas over the full width with
// blank, lined or grid paper and a height that can be dragged. The ink is
// stored per block in page_ink (lib/page-ink-store.ts) with its own
// versions; saves merge with what collaborators drew at the same time.
// Pens draw at once; with a finger or mouse the block is first activated
// (so fingers keep scrolling the document). Entered with a pen or finger,
// a touch shield (touch-shield.tsx) keeps the resting hand from the rest of
// the app until Done (#311). Loaded with the first block.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeViewProps } from "@tiptap/react";
import { Selection } from "@tiptap/pm/state";
import { Check, PencilSimple } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { api } from "../ui";
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

  // Activation: "Zeichnen" or a pen on the surface (#322); leaving with a
  // click outside or Done.
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
  // A block just inserted from the slash menu starts in drawing mode.
  useEffect(() => {
    if (loaded && writable && id && takeDrawingStart(id)) activate(coarse());
  }, [loaded, writable, id, activate]);
  // Stylus touches on the canvas never start Scribble, the long-press
  // callout or a text selection – also before the block is active (the pen
  // is what activates it). Native and not passive: React's are. The
  // floating text box and bars on the canvas (.ink-ui) keep their taps.
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !writable) return;
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
  }, [writable, loaded]);
  // The hovering Pencil (#315): its controls light up under it, pen taps on
  // them feed no Scribble, and a dot shows where it would draw.
  useEffect(() => {
    const block = root.current;
    if (!block || !writable) return;
    const stops = [trackPenHover(block), penTapsWithoutScribble(block)];
    return () => stops.forEach((stop) => stop());
  }, [writable]);
  const inkRef = useRef(ink);
  inkRef.current = ink;
  const dotRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const surface = surfaceRef.current,
      dot = dotRef.current;
    if (!surface || !dot || !writable) return;
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
  }, [writable, loaded]);
  useEffect(() => {
    if (!active) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (root.current?.contains(target) || target?.closest?.(".ink-menu, .modal, .ink-shield")) return;
      finish();
    };
    // Escape ends drawing once nothing inside wants it (a selection, a menu).
    const escape = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (event.key !== "Escape" || event.defaultPrevented || target?.closest?.(".ink-menu, .modal")) return;
      if (document.querySelector(".modal")) return;
      event.preventDefault();
      finish(true);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape);
    };
  }, [active, finish]);

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
        if ((e.target as Element).closest(".ink-block-resize, .ink-block-start")) return;
        // Only a pen enters drawing by touching the surface (#322): a finger
        // swiping across an existing block keeps scrolling the document, and
        // a mouse click does nothing – both start drawing with "Zeichnen".
        // The event stops here so the layer below doesn't take it as a stroke;
        // its default (scrolling, text selection) stays.
        if (e.pointerType !== "pen") {
          e.stopPropagation();
          return;
        }
        // A pen switches to pen-only drawing at once (fingers keep scrolling).
        if (!ink.penOnly) ink.setPenOnly(true);
        activate(touch);
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
        <button type="button" className="ink-block-start" onClick={() => activate(coarse())}>
          <PencilSimple size={16} /> {t("Zeichnen", "Draw")}
        </button>
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
            editing={writable}
            fingersScroll={!active}
            onConvert={writable && canRecognize ? () => void convert() : undefined}
            aiPageId={writable ? pageId : undefined}
            label={t("Handschrift", "Handwriting")}
          />
        )}
        {writable && <div ref={dotRef} className="ink-pen-dot" aria-hidden="true" />}
      </div>
      {writable && (
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
