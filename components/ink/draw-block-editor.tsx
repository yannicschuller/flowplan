"use client";
// A drawing block in a document: an ink canvas over the full width with
// blank, lined or grid paper and a height that can be dragged. The ink is
// stored per block in page_ink (lib/page-ink-store.ts) with its own
// versions; saves merge with what collaborators drew at the same time.
// Pens draw at once; with a finger or mouse the block is first activated
// (so fingers keep scrolling the document). Loaded with the first block.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeViewProps } from "@tiptap/react";
import { Check, PencilSimple } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { api } from "../ui";
import { InkLayer } from "./ink-layer";
import { InkToolbar } from "./ink-toolbar";
import { useInkEditor, useInkShortcuts } from "./use-ink-editor";
import { surfaceUrl, useSurfaceSync } from "./use-surface-sync";
import { convertSelection } from "./convert";
import { PaperSvg } from "../notebook/paper";
import { emptyInk, parseInk, type InkDoc } from "@/lib/ink/model";
import { recognitionAvailable } from "@/lib/ink/recognition";
import { blockPaperLayout } from "@/lib/notebook-paper";
import { DRAW_BLOCK_HEIGHTS, DRAW_BLOCK_PAPERS, DRAW_BLOCK_WIDTH, drawBlockFrom, drawBlockHeight, drawBlockId, drawBlockPaper, type DrawBlockPaper } from "@/lib/draw-block-node";
import type { DrawBlockOptions } from "./draw-block";

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
  const [notice, setNotice] = useState("");
  const editable = doc.isEditable && options.enabled;
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

  // Activation: a click or a pen inside; leaving with a click outside.
  const root = useRef<HTMLDivElement>(null);
  const activate = useCallback(() => {
    if (!writable) return;
    setActive(true);
    // Keys (undo, delete) go to the drawing, not the text around it.
    requestAnimationFrame(() => root.current?.focus({ preventScroll: true }));
  }, [writable]);
  useEffect(() => {
    if (!active) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (root.current?.contains(target) || target?.closest?.(".ink-menu, .modal")) return;
      setActive(false);
      ink.setSelection(null);
      void sync.flush();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [active, ink, sync]);

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
        if (active || !writable || (e.target as Element).closest(".ink-block-resize")) return;
        // A pen switches to pen-only drawing at once (fingers keep scrolling).
        if (e.pointerType === "pen" && !ink.penOnly) ink.setPenOnly(true);
        activate();
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
            onClick={() => {
              setActive(false);
              ink.setSelection(null);
              void sync.flush();
            }}
          >
            <Check size={17} />
            <span>{t("Fertig", "Done")}</span>
          </button>
        </InkToolbar>
      )}
      {!active && writable && loaded && (
        <button type="button" className="ink-block-start" onClick={activate}>
          <PencilSimple size={16} /> {t("Zeichnen", "Draw")}
        </button>
      )}
      {notice && (
        <p className="notebook-notice" role="status">
          {notice}
          <button type="button" className="icon-button" aria-label={t("Hinweis schließen", "Dismiss")} onClick={() => setNotice("")}>
            ×
          </button>
        </p>
      )}
      <div className="ink-block-surface" style={{ aspectRatio: `${DRAW_BLOCK_WIDTH} / ${height}` }}>
        <PaperSvg layout={layout} />
        {loaded && (
          <InkLayer
            page={id}
            size={size}
            editor={ink}
            editing={writable}
            fingersScroll={!active}
            onConvert={writable && canRecognize ? () => void convert() : undefined}
            label={t("Handschrift", "Handwriting")}
          />
        )}
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
