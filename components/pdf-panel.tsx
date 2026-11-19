"use client";
// A PDF in the docked side panel (#392, components/side-panel.tsx), opened
// with "Im Seitenfenster öffnen" (pdf-viewer.tsx openPdfPanel): it keeps its
// page and zoom while the page or notebook beside it is written in. The
// annotations are those of the viewer's "Anmerken" (pdf-annotations.tsx):
// they belong to the PDF, everyone with access sees them, the pen is ready
// at once for who may edit them, and they save as they are written. With
// "Bereich" a lasso takes a region of a page: dragged into the notebook or
// document beside it, or put there with "Einfügen", it becomes a picture
// with a caption that links back to the page (lib/pdf-clip.ts). Loaded on
// first use, with pdf.js and the ink code.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowSquareOut,
  ArrowsOut,
  DownloadSimple,
  FilePdf,
  Lasso,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  PencilSimpleLine,
  Plus,
  X,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { SidePanel } from "./side-panel";
import { useInkShortcuts, setPanelInkFocus } from "./ink/use-ink-editor";
import { loadPdf, openPdf, type PdfDocument } from "./pdf-viewer";
import { AnnotateBar, currentPageOf, PdfNotice, scrollToPage, usePdfAnnotations, ViewerPage } from "./pdf-annotations";
import { usePinchZoom } from "./notebook/use-pinch-zoom";
import { clientToPage, type PageSize } from "@/lib/ink/coords";
import { stepZoom } from "@/lib/pinch-zoom";
import { CLIP_TYPE, clipScale, clipTarget, lassoRegion, onClipTargets, putClip, type LassoPoint, type PdfClip } from "@/lib/pdf-clip";

const ZOOMS = { min: 0.5, max: 3, step: 0.25 };
// Page and zoom per PDF while the app is open: back to a PDF, back where it was.
const places = new Map<string, { page: number; zoom: number }>();

type Mode = "pen" | "clip" | "read";
type Region = { page: number; box: { x: number; y: number; w: number; h: number }; points: LassoPoint[]; size: PageSize };

// The region drawn from the page itself, sharp enough to print: only the
// box around it, a free shape cut out (transparent around it).
async function renderRegion(doc: PdfDocument, region: Region): Promise<{ blob: Blob; width: number; height: number }> {
  const page = await doc.getPage(region.page);
  const scale = clipScale(region.box);
  const { box } = region;
  const viewport = page.getViewport({ scale, offsetX: -box.x * scale, offsetY: -box.y * scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(box.w * scale));
  canvas.height = Math.max(1, Math.ceil(box.h * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport }).promise;
  if (region.points.length > 2) {
    context.globalCompositeOperation = "destination-in";
    context.beginPath();
    region.points.forEach((p, i) => (i ? context.lineTo : context.moveTo).call(context, (p.x - box.x) * scale, (p.y - box.y) * scale));
    context.closePath();
    context.fill();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  const size = { width: canvas.width, height: canvas.height };
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error("render");
  return { blob, ...size };
}

// The lasso over a page in "Bereich" mode.
function LassoLayer({ page, size, onRegion }: { page: number; size: PageSize; onRegion: (region: Region) => void }) {
  const t = useT();
  const [points, setPoints] = useState<LassoPoint[] | null>(null);
  const drawing = useRef<{ pointer: number; points: LassoPoint[] } | null>(null);
  const at = (event: React.PointerEvent) => clientToPage(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), size);
  return (
    <div
      className="pdf-lasso-layer"
      aria-label={t(`Bereich auf Seite ${page} auswählen`, `Select a region on page ${page}`)}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drawing.current = { pointer: event.pointerId, points: [at(event)] };
        setPoints(drawing.current.points);
      }}
      onPointerMove={(event) => {
        const d = drawing.current;
        if (!d || d.pointer !== event.pointerId) return;
        d.points = [...d.points, at(event)];
        setPoints(d.points);
      }}
      onPointerUp={(event) => {
        const d = drawing.current;
        if (!d || d.pointer !== event.pointerId) return;
        drawing.current = null;
        setPoints(null);
        const region = lassoRegion(d.points, size);
        if (region) onRegion({ page, box: region.box, points: region.points, size });
      }}
      onPointerCancel={() => {
        drawing.current = null;
        setPoints(null);
      }}
    >
      {points && (
        <svg viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true">
          <polyline points={points.map((p) => `${p.x},${p.y}`).join(" ")} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </div>
  );
}

// The region taken: dashed, draggable once its picture is ready, with
// "Einfügen" below it.
function RegionFrame({
  region,
  clip,
  canInsert,
  onInsert,
  onCancel,
}: {
  region: Region;
  clip: PdfClip | null;
  canInsert: boolean;
  onInsert: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const { box, size } = region;
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <>
      <div
        className={`pdf-region${clip ? " is-ready" : ""}`}
        style={{ left: pct(box.x, size.width), top: pct(box.y, size.height), width: pct(box.w, size.width), height: pct(box.h, size.height) }}
        draggable={!!clip}
        role="img"
        aria-label={t("Ausgewählter Bereich – zum Einfügen in die Seite daneben ziehen", "Selected region – drag it into the page beside")}
        title={t("In die Seite oder das Notizbuch daneben ziehen", "Drag into the page or notebook beside")}
        onDragStart={(event) => {
          if (!clip) return event.preventDefault();
          event.dataTransfer.setData(CLIP_TYPE, clip.id);
          event.dataTransfer.effectAllowed = "copy";
        }}
      />
      <div className="pdf-region-bar" style={{ left: pct(box.x, size.width), top: pct(Math.min(size.height, box.y + box.h), size.height) }}>
        <button type="button" className="button compact primary" disabled={!clip || !canInsert} onClick={onInsert} title={canInsert ? undefined : t("Öffne daneben eine Seite oder ein Notizbuch, das du bearbeiten darfst.", "Open a page or notebook beside it that you can edit.")}>
          <Plus size={15} />
          {clip ? t("Einfügen", "Insert") : t("Wird vorbereitet …", "Preparing …")}
        </button>
        <button type="button" className="icon-button" aria-label={t("Auswahl aufheben", "Clear selection")} onClick={onCancel}>
          <X size={15} />
        </button>
      </div>
    </>
  );
}

function useClipTargetPresent() {
  return useSyncExternalStore(onClipTargets, () => !!clipTarget(), () => false);
}

function PdfPanelDocument({ src, title, page, request }: { src: string; title: string; page?: number; request: number }) {
  const t = useT();
  const remembered = places.get(src);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(remembered?.zoom ?? 1);
  const [fitWidth, setFitWidth] = useState(400);
  const [current, setCurrent] = useState(remembered?.page ?? 1);
  const [mode, setMode] = useState<Mode>("read");
  const scroller = useRef<HTMLDivElement>(null);
  const pagesBox = useRef<HTMLDivElement>(null);
  const annotating = mode === "pen";
  const ann = usePdfAnnotations(src, title, annotating);
  const { editor, ink, save, notice, setNotice } = ann;
  // Ink shortcuts act here only while the panel was touched last.
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    const root = scroller.current?.closest<HTMLElement>(".side-panel");
    const update = (event: Event) => {
      const inside = !!root?.contains(event.target as Node);
      setPanelInkFocus(inside);
      setFocused(inside);
    };
    setPanelInkFocus(true);
    document.addEventListener("pointerdown", update, true);
    document.addEventListener("focusin", update);
    return () => {
      setPanelInkFocus(false);
      document.removeEventListener("pointerdown", update, true);
      document.removeEventListener("focusin", update);
    };
  }, []);
  useInkShortcuts(editor, annotating && focused, { panel: true });
  // The pen is ready for who may edit the annotations.
  const started = useRef(false);
  useEffect(() => {
    if (!ink || started.current) return;
    started.current = true;
    if (ink.canEdit) setMode("pen");
  }, [ink]);
  // Saved as it is written: a moment after the last change, and when the
  // panel closes or shows another PDF.
  const saveRef = useRef(save);
  saveRef.current = save;
  const dirty = !!ink?.canEdit && editor.dirty;
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => void saveRef.current(), 1500);
    return () => window.clearTimeout(timer);
  }, [dirty, editor.doc]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => () => void (dirtyRef.current && saveRef.current()), []);

  useEffect(() => {
    let alive = true;
    loadPdf(src)
      .then((d) => alive && setDoc(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [src]);
  // The page asked for (a link to it), else where it was.
  useEffect(() => {
    if (!doc) return;
    const target = Math.min(doc.numPages, page || places.get(src)?.page || 1);
    if (target < 2 && !page) return;
    let tries = 0;
    const go = () => {
      if (!scrollToPage(scroller.current, target) && ++tries < 20) frame = requestAnimationFrame(go);
    };
    let frame = requestAnimationFrame(go);
    return () => cancelAnimationFrame(frame);
  }, [doc, page, request, src]);
  useEffect(() => void places.set(src, { page: current, zoom }), [src, current, zoom]);
  // Pages fit the panel's width (it changes when the panel is dragged).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setFitWidth(Math.max(200, Math.min(1400, el.clientWidth - 24)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const onScroll = useCallback(() => setCurrent(currentPageOf(scroller.current)), []);
  usePinchZoom({ scroller, content: pagesBox, sheetSelector: ".pdf-page-wrap", zoom, setZoom, limits: ZOOMS });
  const width = Math.round(fitWidth * zoom);

  // The lasso's region and its picture.
  const [region, setRegion] = useState<Region | null>(null);
  const [clip, setClip] = useState<PdfClip | null>(null);
  const canInsert = useClipTargetPresent();
  useEffect(() => {
    setClip(null);
    if (!region || !doc) return;
    let alive = true;
    renderRegion(doc, region)
      .then((picture) => {
        if (!alive) return;
        setClip(putClip({ ...picture, points: { width: region.box.w, height: region.box.h }, src, title, page: region.page }));
      })
      .catch(() => alive && setNotice({ text: t("Der Bereich konnte nicht übernommen werden.", "The region could not be taken."), error: true }));
    return () => {
      alive = false;
    };
  }, [region, doc, src, title, setNotice, t]);
  useEffect(() => {
    if (mode !== "clip") setRegion(null);
  }, [mode]);
  const [inserting, setInserting] = useState(false);
  async function insert() {
    const target = clipTarget();
    if (!clip || !target) return;
    setInserting(true);
    try {
      if (await target.insert(clip)) {
        setRegion(null);
        setNotice({ text: t("Eingefügt – die Bildunterschrift führt zurück zu dieser Seite.", "Inserted – its caption leads back to this page.") });
      }
    } catch (e) {
      setNotice({ text: (e as Error).message || t("Der Bereich konnte nicht eingefügt werden.", "The region could not be inserted."), error: true });
    } finally {
      setInserting(false);
    }
  }
  // Escape drops the region first (the panel stays).
  useEffect(() => {
    if (!region) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setRegion(null);
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [region]);

  const modes = (
    <div className="pdf-panel-modes" role="group" aria-label={t("Modus des Seitenfensters", "Side panel mode")}>
      {ink?.canEdit && (
        <button type="button" className={`chip${mode === "pen" ? " active" : ""}`} aria-pressed={mode === "pen"} onClick={() => setMode(mode === "pen" ? "read" : "pen")} title={t("Mit Stift, Textmarker und Text anmerken – alle mit Zugriff sehen es", "Mark up with pen, highlighter and text – everyone with access sees it")}>
          <PencilSimpleLine size={15} />
          {t("Anmerken", "Annotate")}
        </button>
      )}
      <button type="button" className={`chip${mode === "clip" ? " active" : ""}`} aria-pressed={mode === "clip"} onClick={() => setMode(mode === "clip" ? (ink?.canEdit ? "pen" : "read") : "clip")} title={t("Einen Bereich umfahren und in die Seite daneben übernehmen", "Draw around a region and take it into the page beside")}>
        <Lasso size={15} />
        {t("Bereich", "Region")}
      </button>
      {doc && <span className="pdf-panel-page">{t(`S. ${current}/${doc.numPages}`, `p. ${current}/${doc.numPages}`)}</span>}
      <span className="pdf-panel-zoom">
        <button type="button" className="icon-button" aria-label={t("Verkleinern", "Zoom out")} title={t("Verkleinern", "Zoom out")} onClick={() => setZoom((z) => stepZoom(z, -1, ZOOMS.step, ZOOMS))}>
          <MagnifyingGlassMinus size={17} />
        </button>
        <span>{Math.round(zoom * 100)} %</span>
        <button type="button" className="icon-button" aria-label={t("Vergrößern", "Zoom in")} title={t("Vergrößern", "Zoom in")} onClick={() => setZoom((z) => stepZoom(z, 1, ZOOMS.step, ZOOMS))}>
          <MagnifyingGlassPlus size={17} />
        </button>
        <button type="button" className="icon-button" aria-label={t("An Breite anpassen", "Fit to width")} title={t("An Breite anpassen", "Fit to width")} onClick={() => setZoom(1)}>
          <ArrowsOut size={17} />
        </button>
      </span>
    </div>
  );
  return (
    <div className={`pdf-panel${annotating ? " is-annotating" : ""}${mode === "clip" ? " is-clipping" : ""}`} data-pdf-panel={src}>
      {modes}
      {annotating && <AnnotateBar ann={ann} />}
      {mode === "clip" && !region && (
        <p className="pdf-panel-hint" role="status">
          {t("Umfahre einen Bereich einer Seite – oder ziehe schräg darüber für ein Rechteck.", "Draw around a region of a page – or drag across it for a rectangle.")}
        </p>
      )}
      <PdfNotice notice={notice} onDismiss={() => setNotice(null)} />
      <div className="pdf-panel-pages" ref={scroller} onScroll={onScroll} aria-busy={inserting || undefined}>
        {error ? (
          <p className="pdf-viewer-message" role="alert">
            {t("Das PDF ließ sich nicht anzeigen. Du kannst es herunterladen.", "The PDF could not be shown. You can download it.")}
          </p>
        ) : !doc ? (
          <p className="pdf-viewer-message" role="status">
            {t("PDF wird geladen …", "Loading PDF …")}
          </p>
        ) : (
          <div className="pdf-viewer-sheets" ref={pagesBox}>
            {Array.from({ length: doc.numPages }, (_, i) => (
              <ViewerPage
                key={i}
                doc={doc}
                number={i + 1}
                width={width}
                ink={ann.pageInk}
                overlay={(size) => (
                  <>
                    {mode === "clip" && <LassoLayer page={i + 1} size={size} onRegion={setRegion} />}
                    {region?.page === i + 1 && (
                      <RegionFrame region={region} clip={clip} canInsert={canInsert && !inserting} onInsert={() => void insert()} onCancel={() => setRegion(null)} />
                    )}
                  </>
                )}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PdfPanel({ src, title, page, request, onClose }: { src: string; title: string; page?: number; request: number; onClose: () => void }) {
  const t = useT();
  return (
    <SidePanel
      kind="pdf"
      owner="pdf-panel"
      label={t(`PDF „${title}“ im Seitenfenster`, `PDF “${title}” in the side panel`)}
      icon={<FilePdf size={18} className="side-panel-icon" aria-hidden="true" />}
      title={<span title={title}>{title}</span>}
      actions={
        <>
          <button type="button" className="icon-button" aria-label={t("Im PDF-Viewer öffnen", "Open in the PDF viewer")} title={t("Im PDF-Viewer öffnen", "Open in the PDF viewer")} onClick={() => openPdf(src, title, places.get(src)?.page)}>
            <ArrowSquareOut size={17} />
          </button>
          <a className="icon-button" href={src} download={title || "document.pdf"} aria-label={t("Herunterladen", "Download")} title={t("Original herunterladen", "Download the original")}>
            <DownloadSimple size={17} />
          </a>
        </>
      }
      onClose={onClose}
    >
      <PdfPanelDocument key={src} src={src} title={title} page={page} request={request} />
    </SidePanel>
  );
}
