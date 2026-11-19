"use client";
// The drawing viewer (#384) for DXF and DWG files, opened by openModel()
// through ModelViewerHost (components/model-viewer.tsx) and loaded on first
// use: pan and zoom (mouse, touch, keys), fit, the layers with on/off,
// white or dark paper, the size of the drawing and measuring distances
// between ends and vertices in the drawing's unit. DWG files load the
// DWG reader (LibreDWG, WebAssembly) only now.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowsIn, Blueprint, DownloadSimple, MagnifyingGlassMinus, MagnifyingGlassPlus, Moon, Ruler, Stack, Sun, Trash, X } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { MODEL_FORMAT_LABELS } from "@/lib/model-formats";
import { formatLength, roundLength } from "@/lib/model-geometry";
import { drawingUnit, hexColor } from "@/lib/drawing-model";
import { INK, initialVisibility, layerCounts, setAllLayers, shownBounds, toggleLayer, type DrawingScene } from "@/lib/drawing-scene";
import { DrawingLoadError, loadDrawing, type DrawingProblem } from "./load";
import { DrawingCanvas, type Measurement, type Paper } from "./canvas";
import "@/app/viewer3d.css";
import "@/app/viewer2d.css";

// "120 × 80 mm"
const formatSize = (size: [number, number], unit: string) =>
  `${size.map((v) => roundLength(v).toLocaleString(LOCALE_TAG, { maximumFractionDigits: 6 })).join(" × ")}${unit ? ` ${unit}` : ""}`;
const prefersDark = () => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";

export default function DrawingViewerDialog({ src, title, format, onClose }: { src: string; title: string; format: "dxf" | "dwg"; onClose: () => void }) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const viewRef = useRef<DrawingCanvas | null>(null);
  const [scene, setScene] = useState<DrawingScene | null>(null);
  const [release, setRelease] = useState<string | null>(null);
  const [problem, setProblem] = useState<DrawingProblem | null>(null);
  const [visible, setVisible] = useState<boolean[]>([]);
  const [layersOpen, setLayersOpen] = useState(false);
  const [paper, setPaper] = useState<Paper>(prefersDark() ? "dark" : "light");
  const [measuring, setMeasuring] = useState(false);
  const [pending, setPending] = useState(false);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const name = title || MODEL_FORMAT_LABELS[format];
  const unit = drawingUnit(scene?.units);
  const symbol = unit?.symbol || "";
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const paperRef = useRef(paper);
  paperRef.current = paper;

  useEffect(() => {
    const controller = new AbortController();
    let view: DrawingCanvas | null = null;
    let observer: ResizeObserver | null = null;
    loadDrawing(src, format, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted || !canvas.current || !stage.current) return;
        view = new DrawingCanvas(canvas.current, loaded.scene, {
          onMeasurements: setMeasurements,
          onPending: setPending,
          label: (distance) => formatLength(distance, symbolRef.current, LOCALE_TAG),
        });
        view.setPaper(paperRef.current);
        viewRef.current = view;
        const box = stage.current;
        const measure = () => view?.resize(box.clientWidth, box.clientHeight);
        measure();
        observer = new ResizeObserver(measure);
        observer.observe(box);
        setScene(loaded.scene);
        setRelease(loaded.release);
        setVisible(initialVisibility(loaded.scene.layers));
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setProblem(error instanceof DrawingLoadError ? error.problem : { kind: "parse" });
      });
    return () => {
      controller.abort();
      observer?.disconnect();
      view?.dispose();
      viewRef.current = null;
    };
  }, [src, format]);

  useEffect(() => viewRef.current?.setVisible(visible), [visible]);
  useEffect(() => viewRef.current?.setPaper(paper), [paper]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") return closeRef.current();
      const view = viewRef.current;
      if (!view || (event.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable=true]")) return;
      if (event.key === "+" || event.key === "=") view.zoom(1);
      else if (event.key === "-") view.zoom(-1);
      else if (event.key === "0" || event.key === "Home") view.fit();
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", key);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = previous;
    };
  }, []);

  const view = () => viewRef.current;
  const toggleMeasuring = () => {
    const next = !measuring;
    setMeasuring(next);
    view()?.setMeasuring(next);
  };
  const counts = useMemo(() => (scene ? layerCounts(scene) : []), [scene]);
  const size = useMemo(() => {
    const box = scene ? shownBounds(scene, visible) : null;
    return box ? ([box[2] - box[0], box[3] - box[1]] as [number, number]) : null;
  }, [scene, visible]);
  const skipped = scene ? Object.values(scene.skipped).reduce((a, b) => a + b, 0) : 0;
  const ready = !!scene && !problem;
  const shown = visible.filter(Boolean).length;
  return (
    <div className="viewer3d viewer2d" role="dialog" aria-modal="true" aria-label={name}>
      <header className="viewer3d-bar">
        <Blueprint size={20} aria-hidden />
        <strong title={name}>{name}</strong>
        <span className="viewer3d-format">{release ? `${MODEL_FORMAT_LABELS[format]} ${release}` : MODEL_FORMAT_LABELS[format]}</span>
        <span className="viewer3d-actions">
          <a className="icon-button" href={src} download={name} aria-label={t("Herunterladen", "Download")} title={t("Original herunterladen", "Download the original")}>
            <DownloadSimple size={18} />
          </a>
          <button type="button" className="icon-button" aria-label={t("Schließen", "Close")} title={t("Schließen", "Close")} onClick={onClose}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className="viewer3d-tools" role="toolbar" aria-label={t("Zeichnungsansicht", "Drawing view")}>
        <button type="button" className="viewer3d-tool" disabled={!ready} onClick={() => view()?.fit()} aria-label={t("Einpassen", "Fit to view")} title={t("Ganze Zeichnung zeigen (0)", "Show the whole drawing (0)")}>
          <ArrowsIn size={18} />
        </button>
        <button type="button" className="viewer3d-tool" disabled={!ready} onClick={() => view()?.zoom(1)} aria-label={t("Vergrößern", "Zoom in")} title={t("Vergrößern (+)", "Zoom in (+)")}>
          <MagnifyingGlassPlus size={18} />
        </button>
        <button type="button" className="viewer3d-tool" disabled={!ready} onClick={() => view()?.zoom(-1)} aria-label={t("Verkleinern", "Zoom out")} title={t("Verkleinern (−)", "Zoom out (−)")}>
          <MagnifyingGlassMinus size={18} />
        </button>
        <span className="viewer3d-divider" aria-hidden />
        <button
          type="button"
          className="viewer3d-tool is-labelled"
          disabled={!ready}
          aria-pressed={layersOpen}
          aria-expanded={layersOpen}
          aria-controls="viewer2d-layers"
          onClick={() => setLayersOpen(!layersOpen)}
          aria-label={t("Layer", "Layers")}
          title={t("Layer ein- und ausblenden", "Show and hide layers")}
        >
          <Stack size={18} />
          <span>{t("Layer", "Layers")}</span>
          {ready && <span className="viewer2d-count">{`${shown}/${visible.length}`}</span>}
        </button>
        <button type="button" className="viewer3d-tool is-labelled" disabled={!ready} aria-pressed={measuring} onClick={toggleMeasuring} aria-label={t("Messen", "Measure||3D tool")} title={t("Zwei Punkte anklicken – sie rasten an Endpunkten und Ecken ein", "Click two points – they snap to ends and corners")}>
          <Ruler size={18} />
          <span>{t("Messen", "Measure||3D tool")}</span>
        </button>
        {measurements.length > 0 && (
          <button type="button" className="viewer3d-tool" onClick={() => view()?.clearMeasurements()} aria-label={t("Messungen löschen", "Clear measurements")} title={t("Messungen löschen", "Clear measurements")}>
            <Trash size={18} />
          </button>
        )}
        <button
          type="button"
          className="viewer3d-tool"
          disabled={!ready}
          aria-pressed={paper === "dark"}
          onClick={() => setPaper(paper === "dark" ? "light" : "dark")}
          aria-label={t("Dunkles Papier", "Dark paper")}
          title={paper === "dark" ? t("Auf weißes Papier wechseln", "Switch to white paper") : t("Auf dunkles Papier wechseln", "Switch to dark paper")}
        >
          {paper === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
      <div className="viewer3d-stage viewer2d-stage" ref={stage} data-paper={paper}>
        <canvas
          ref={canvas}
          className={`viewer2d-canvas${ready ? " is-ready" : ""}`}
          tabIndex={0}
          role="img"
          aria-label={t(
            `Zeichnung ${name}. Ziehen verschiebt, Mausrad oder zwei Finger zoomen; Pfeiltasten verschieben.`,
            `Drawing ${name}. Drag to pan, the wheel or a pinch to zoom; arrow keys pan.`,
          )}
        />
        {!scene && !problem && (
          <p className="viewer3d-message" role="status">
            {format === "dwg"
              ? t("DWG-Datei wird gelesen … Beim ersten Mal lädt Flowplan dafür den DWG-Leser (etwa 11 MB).", "Reading the DWG file … The first time, Flowplan loads the DWG reader for it (about 11 MB).")
              : t("Zeichnung wird geladen …", "Loading drawing …")}
          </p>
        )}
        {problem && (
          <p className="viewer3d-message is-error" role="alert">
            {problemText(problem, t, format)}
          </p>
        )}
        {ready && measuring && (
          <p className="viewer3d-hint" role="status">
            {pending ? t("Jetzt den zweiten Punkt anklicken.", "Now click the second point.") : t("Klicke einen Punkt an – er rastet am nächsten Endpunkt ein.", "Click a point – it snaps to the nearest end.")}
          </p>
        )}
        {ready && layersOpen && scene && (
          <section className="viewer2d-layers" id="viewer2d-layers" aria-label={t("Layer", "Layers")}>
            <header>
              <strong>{t("Layer", "Layers")}</strong>
              <span className="viewer2d-layer-all">
                <button type="button" className="viewer2d-link" onClick={() => setVisible(setAllLayers(visible, true))}>
                  {t("Alle ein", "All on")}
                </button>
                <button type="button" className="viewer2d-link" onClick={() => setVisible(setAllLayers(visible, false))}>
                  {t("Alle aus", "All off")}
                </button>
              </span>
              <button type="button" className="icon-button" aria-label={t("Layer schließen", "Close layers")} onClick={() => setLayersOpen(false)}>
                <X size={15} />
              </button>
            </header>
            <ul>
              {scene.layers.map((layer, i) => (
                <li key={`${i}-${layer.name}`}>
                  <label>
                    <input type="checkbox" checked={!!visible[i]} onChange={() => setVisible(toggleLayer(visible, i))} />
                    <svg className="viewer2d-swatch" viewBox="0 0 12 12" aria-hidden>
                      <rect x="0.5" y="0.5" width="11" height="11" rx="2.5" fill={layer.color === INK ? (paper === "dark" ? "#e8eaee" : "#1d2330") : hexColor(layer.color)} />
                    </svg>
                    <span className="viewer2d-layer-name">{layer.name}</span>
                    <small>{counts[i] || ""}</small>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {scene && (
        <footer className="viewer3d-info" aria-label={t("Zeichnungsangaben", "Drawing details")}>
          {size && (
            <span>
              {t("Größe:", "Size:")} <strong className="viewer2d-size">{formatSize(size, symbol)}</strong>
            </span>
          )}
          <span className="muted">
            {unit
              ? t(`Einheit: ${unit.symbol}`, `Unit: ${unit.symbol}`)
              : t("Die Zeichnung nennt keine Einheit – Maße in Zeichnungseinheiten.", "The drawing names no unit – lengths in drawing units.")}
          </span>
          {skipped > 0 && <span className="muted">{t(`${skipped} Objekte nicht dargestellt (3D, Bilder, Tabellen)`, `${skipped} objects not shown (3D, images, tables)`)}</span>}
          {scene.truncated && <span className="muted">{t("Sehr große Zeichnung – nur ein Teil wird gezeigt.", "Very large drawing – only part of it is shown.")}</span>}
          {measurements.length > 0 && (
            <ol className="viewer3d-measurements" aria-label={t("Messungen", "Measurements")} aria-live="polite">
              {measurements.map((m, i) => (
                <li key={m.id}>
                  <span>{t(`Messung ${i + 1}:`, `Measurement ${i + 1}:`)}</span> <strong className="viewer3d-distance">{formatLength(m.distance, symbol, LOCALE_TAG)}</strong>
                  <small className="muted">
                    {`Δx ${formatLength(m.dx, symbol, LOCALE_TAG)} · Δy ${formatLength(m.dy, symbol, LOCALE_TAG)}`}
                  </small>
                  <button type="button" className="icon-button" aria-label={t(`Messung ${i + 1} entfernen`, `Remove measurement ${i + 1}`)} onClick={() => view()?.removeMeasurement(m.id)}>
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </footer>
      )}
    </div>
  );
}

function problemText(problem: DrawingProblem, t: (de: string, en: string) => string, format: "dxf" | "dwg") {
  const label = MODEL_FORMAT_LABELS[format];
  const exportHint = t("Exportiere die Zeichnung in deinem CAD-Programm als DXF und lade diese Datei hoch.", "Export the drawing as DXF from your CAD program and upload that file.");
  switch (problem.kind) {
    case "too-large":
      return t(
        `Diese Datei ist zu groß für die Zeichnungsansicht (höchstens ${problem.limitMb} MB für ${label}). Du kannst sie herunterladen und in einem CAD-Programm öffnen.`,
        `This file is too large for the drawing view (at most ${problem.limitMb} MB for ${label}). You can download it and open it in a CAD program.`,
      );
    case "download":
      return t("Die Datei konnte nicht geladen werden.", "The file could not be loaded.");
    case "empty":
      return t("Die Zeichnung enthält nichts, was sich in 2D zeigen lässt.", "The drawing contains nothing that can be shown in 2D.");
    case "binary":
      return t("Binäre DXF-Dateien kann die Zeichnungsansicht nicht lesen. Speichere die Zeichnung als DXF im Textformat (ASCII).", "The drawing view cannot read binary DXF files. Save the drawing as DXF in text format (ASCII).");
    case "memory":
      return t(`Für diese Zeichnung reicht der Speicher des Browsers nicht. ${exportHint}`, `The browser does not have enough memory for this drawing. ${exportHint}`);
    case "dwg":
      return problem.release
        ? t(`Diese DWG-Datei (AutoCAD ${problem.release}) ließ sich nicht lesen. ${exportHint}`, `This DWG file (AutoCAD ${problem.release}) could not be read. ${exportHint}`)
        : t(`Diese DWG-Version ließ sich nicht lesen. ${exportHint}`, `This DWG version could not be read. ${exportHint}`);
    case "reader":
      return problem.offline
        ? t(
            "DWG-Dateien brauchen beim ersten Öffnen eine Verbindung: Der DWG-Leser (etwa 11 MB) ist nicht in der Offline-Kopie.",
            "DWG files need a connection the first time: the DWG reader (about 11 MB) is not part of the offline copy.",
          )
        : t("Der DWG-Leser konnte nicht geladen werden. Versuche es noch einmal.", "The DWG reader could not be loaded. Please try again.");
    default:
      return t(`Die Datei ließ sich nicht als ${label} lesen. Du kannst sie herunterladen.`, `The file could not be read as ${label}. You can download it.`);
  }
}
