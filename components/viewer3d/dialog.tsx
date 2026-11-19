"use client";
// The 3D viewer (#384), opened by openModel() through ModelViewerHost
// (components/model-viewer.tsx) and loaded on first use with three.js:
// turn, pan and zoom (mouse, touch, keys), the standard views, fit and
// home, wireframe, the size of the bounding box and measuring distances on
// the surface. STEP and IGES load the CAD reader (WebAssembly) only now.
import { useEffect, useRef, useState } from "react";
import {
  ArrowsIn,
  Cube,
  CubeTransparent,
  DownloadSimple,
  HouseSimple,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Ruler,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useT } from "../i18n";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { MODEL_FORMAT_LABELS, isCadFormat, type LengthUnit, type ModelFormat } from "@/lib/model-formats";
import { formatBox, formatLength, type StandardView, type Vec3 } from "@/lib/model-geometry";
import { ModelLoadError, loadModel, type LoadProblem } from "./load";
import { ModelScene, type Measurement } from "./scene";
import "@/app/viewer3d.css";

type Info = { size: Vec3; unit: LengthUnit; assumedUnit: boolean; triangles: number };

export default function ModelViewerDialog({ src, title, format, onClose }: { src: string; title: string; format: ModelFormat; onClose: () => void }) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ModelScene | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [problem, setProblem] = useState<LoadProblem | null>(null);
  const [view, setView] = useState<StandardView | "custom">("iso");
  const [measuring, setMeasuring] = useState(false);
  const [pending, setPending] = useState(false);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [wireframe, setWireframe] = useState(false);
  const unitRef = useRef<LengthUnit>("mm");
  const cad = isCadFormat(format);
  const name = title || MODEL_FORMAT_LABELS[format];

  useEffect(() => {
    const controller = new AbortController();
    let scene: ModelScene | null = null;
    let observer: ResizeObserver | null = null;
    loadModel(src, format, controller.signal)
      .then((model) => {
        if (controller.signal.aborted || !canvas.current || !stage.current) return;
        unitRef.current = model.unit;
        try {
          scene = new ModelScene(canvas.current, model.root, model.up, {
            onMeasurements: setMeasurements,
            onPending: setPending,
            onView: setView,
            label: (distance) => formatLength(distance, unitRef.current, LOCALE_TAG),
          });
        } catch {
          // No WebGL (switched off, or an old device).
          setProblem({ kind: "parse" });
          setInfo(null);
          return;
        }
        sceneRef.current = scene;
        const box = stage.current;
        const measure = () => scene?.resize(box.clientWidth, box.clientHeight);
        measure();
        observer = new ResizeObserver(measure);
        observer.observe(box);
        scene.home();
        setInfo({ size: scene.size, unit: model.unit, assumedUnit: model.assumedUnit, triangles: model.triangles });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setProblem(error instanceof ModelLoadError ? error.problem : { kind: "parse" });
      });
    return () => {
      controller.abort();
      observer?.disconnect();
      scene?.dispose();
      sceneRef.current = null;
    };
  }, [src, format]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") return closeRef.current();
      const scene = sceneRef.current;
      if (!scene || (event.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable=true]")) return;
      if (event.key === "+" || event.key === "=") scene.zoom(1);
      else if (event.key === "-") scene.zoom(-1);
      else if (event.key === "0" || event.key === "Home") scene.home();
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

  const scene = () => sceneRef.current;
  const toggleMeasuring = () => {
    const next = !measuring;
    setMeasuring(next);
    scene()?.setMeasuring(next);
  };
  const toggleWireframe = () => {
    const next = !wireframe;
    setWireframe(next);
    scene()?.setWireframe(next);
  };
  const axes = (view: StandardView) => {
    // Which axis each view looks along, for the buttons' descriptions.
    const zUp = format !== "gltf" && format !== "glb" && format !== "obj";
    if (view === "front") return zUp ? "Y" : "Z";
    if (view === "top") return zUp ? "Z" : "Y";
    return "X";
  };
  // i18n-table: 2 4 – [view, German, English, German description, English description]
  const views: [StandardView, string, string, string, string][] = [
    ["front", "Vorne", "Front||3D view", `Vorderansicht (Blick entlang ${axes("front")})`, `Front view (looking along ${axes("front")})`],
    ["top", "Oben", "Top||3D view", `Draufsicht (Blick entlang ${axes("top")})`, `Top view (looking along ${axes("top")})`],
    ["right", "Seite", "Side||3D view", "Seitenansicht von rechts (Blick entlang X)", "Side view from the right (looking along X)"],
    ["iso", "Iso", "Iso||3D view", "Isometrische Ansicht", "Isometric view"],
  ];
  const ready = !!info && !problem;
  const unit = info?.unit || "mm";
  return (
    <div className="viewer3d" role="dialog" aria-modal="true" aria-label={name}>
      <header className="viewer3d-bar">
        <Cube size={20} aria-hidden />
        <strong title={name}>{name}</strong>
        <span className="viewer3d-format">{MODEL_FORMAT_LABELS[format]}</span>
        <span className="viewer3d-actions">
          <a className="icon-button" href={src} download={name} aria-label={t("Herunterladen", "Download")} title={t("Original herunterladen", "Download the original")}>
            <DownloadSimple size={18} />
          </a>
          <button type="button" className="icon-button" aria-label={t("Schließen", "Close")} title={t("Schließen", "Close")} onClick={onClose}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className="viewer3d-tools" role="toolbar" aria-label={t("3D-Ansicht", "3D view")}>
        <button type="button" className="viewer3d-tool" disabled={!ready} onClick={() => scene()?.home()} aria-label={t("Startansicht", "Home view")} title={t("Startansicht (0)", "Home view (0)")}>
          <HouseSimple size={18} />
        </button>
        <button type="button" className="viewer3d-tool" disabled={!ready} onClick={() => scene()?.fit()} aria-label={t("Einpassen", "Fit to view")} title={t("Ganzes Modell zeigen", "Show the whole model")}>
          <ArrowsIn size={18} />
        </button>
        <button type="button" className="viewer3d-tool" disabled={!ready} onClick={() => scene()?.zoom(1)} aria-label={t("Vergrößern", "Zoom in")} title={t("Vergrößern (+)", "Zoom in (+)")}>
          <MagnifyingGlassPlus size={18} />
        </button>
        <button type="button" className="viewer3d-tool" disabled={!ready} onClick={() => scene()?.zoom(-1)} aria-label={t("Verkleinern", "Zoom out")} title={t("Verkleinern (−)", "Zoom out (−)")}>
          <MagnifyingGlassMinus size={18} />
        </button>
        <span className="viewer3d-divider" aria-hidden />
        <span className="viewer3d-views" role="group" aria-label={t("Standardansichten", "Standard views")}>
          {views.map(([id, de, en, deTitle, enTitle]) => (
            <button
              key={id}
              type="button"
              className="viewer3d-view"
              disabled={!ready}
              aria-pressed={ready && view === id}
              aria-label={t(deTitle, enTitle)}
              title={t(deTitle, enTitle)}
              onClick={() => scene()?.setView(id)}
            >
              {t(de, en)}
            </button>
          ))}
        </span>
        <span className="viewer3d-divider" aria-hidden />
        <button type="button" className="viewer3d-tool is-labelled" disabled={!ready} aria-pressed={measuring} onClick={toggleMeasuring} aria-label={t("Messen", "Measure||3D tool")} title={t("Zwei Punkte auf der Oberfläche anklicken", "Click two points on the surface")}>
          <Ruler size={18} />
          <span>{t("Messen", "Measure||3D tool")}</span>
        </button>
        {measurements.length > 0 && (
          <button type="button" className="viewer3d-tool" onClick={() => scene()?.clearMeasurements()} aria-label={t("Messungen löschen", "Clear measurements")} title={t("Messungen löschen", "Clear measurements")}>
            <Trash size={18} />
          </button>
        )}
        <button type="button" className="viewer3d-tool" disabled={!ready} aria-pressed={wireframe} onClick={toggleWireframe} aria-label={t("Drahtgitter", "Wireframe")} title={t("Drahtgitter", "Wireframe")}>
          <CubeTransparent size={18} />
        </button>
      </div>
      <div className="viewer3d-stage" ref={stage}>
        <canvas
          ref={canvas}
          className={`viewer3d-canvas${ready ? " is-ready" : ""}`}
          tabIndex={0}
          role="img"
          aria-label={t(
            `3D-Ansicht von ${name}. Ziehen dreht, mit zwei Fingern oder rechter Maustaste verschieben, Mausrad oder zwei Finger zoomen; Pfeiltasten verschieben.`,
            `3D view of ${name}. Drag to turn, two fingers or the right mouse button to pan, the wheel or a pinch to zoom; arrow keys pan.`,
          )}
          data-view={view}
        />
        {!info && !problem && (
          <p className="viewer3d-message" role="status">
            {cad
              ? t("CAD-Datei wird gelesen … Beim ersten Mal lädt Flowplan dafür den CAD-Leser (etwa 7 MB).", "Reading the CAD file … The first time, Flowplan loads the CAD reader for it (about 7 MB).")
              : t("3D-Modell wird geladen …", "Loading 3D model …")}
          </p>
        )}
        {problem && (
          <p className="viewer3d-message is-error" role="alert">
            {problemText(problem, t, format)}
          </p>
        )}
        {ready && measuring && (
          <p className="viewer3d-hint" role="status">
            {pending ? t("Jetzt den zweiten Punkt anklicken.", "Now click the second point.") : t("Klicke einen Punkt auf der Oberfläche an.", "Click a point on the surface.")}
          </p>
        )}
      </div>
      {info && (
        <footer className="viewer3d-info" aria-label={t("Modellangaben", "Model details")}>
          <span>
            {t("Abmessungen:", "Dimensions:")} <strong className="viewer3d-size">{formatBox(info.size, unit, LOCALE_TAG)}</strong>
          </span>
          <span className="muted">{t(`${info.triangles.toLocaleString(LOCALE_TAG)} Dreiecke`, `${info.triangles.toLocaleString(LOCALE_TAG)} triangles`)}</span>
          {info.assumedUnit && (
            <span className="muted">{t(`${MODEL_FORMAT_LABELS[format]} speichert keine Einheit – angenommen: Millimeter.`, `${MODEL_FORMAT_LABELS[format]} stores no unit – millimetres assumed.`)}</span>
          )}
          {measurements.length > 0 && (
            <ol className="viewer3d-measurements" aria-label={t("Messungen", "Measurements")} aria-live="polite">
              {measurements.map((m, i) => (
                <li key={m.id}>
                  <span>{t(`Messung ${i + 1}:`, `Measurement ${i + 1}:`)}</span> <strong className="viewer3d-distance">{formatLength(m.distance, unit, LOCALE_TAG)}</strong>
                  <button type="button" className="icon-button" aria-label={t(`Messung ${i + 1} entfernen`, `Remove measurement ${i + 1}`)} onClick={() => scene()?.removeMeasurement(m.id)}>
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

function problemText(problem: LoadProblem, t: (de: string, en: string) => string, format: ModelFormat) {
  const label = MODEL_FORMAT_LABELS[format];
  switch (problem.kind) {
    case "too-large":
      return t(
        `Diese Datei ist zu groß für die 3D-Ansicht (höchstens ${problem.limitMb} MB für ${label}). Du kannst sie herunterladen und in einem CAD-Programm öffnen.`,
        `This file is too large for the 3D view (at most ${problem.limitMb} MB for ${label}). You can download it and open it in a CAD program.`,
      );
    case "download":
      return t("Die Datei konnte nicht geladen werden.", "The file could not be loaded.");
    case "empty":
      return t("Die Datei enthält keine Flächen, die sich anzeigen lassen.", "The file contains no surfaces that can be shown.");
    case "compressed":
      return t(
        "Dieses glTF-Modell ist mit Draco oder KTX2 komprimiert; das kann die 3D-Ansicht nicht lesen. Du kannst es herunterladen.",
        "This glTF model is compressed with Draco or KTX2, which the 3D view cannot read. You can download it.",
      );
    case "external":
      return t(
        "Diese glTF-Datei verweist auf weitere Dateien (.bin, Texturen). Lade das Modell als GLB hoch, dann ist alles in einer Datei.",
        "This glTF file refers to other files (.bin, textures). Upload the model as GLB to have everything in one file.",
      );
    case "reader":
      return problem.offline
        ? t(
            "STEP- und IGES-Dateien brauchen beim ersten Öffnen eine Verbindung: Der CAD-Leser (etwa 7 MB) ist nicht in der Offline-Kopie.",
            "STEP and IGES files need a connection the first time: the CAD reader (about 7 MB) is not part of the offline copy.",
          )
        : t("Der CAD-Leser konnte nicht geladen werden. Versuche es noch einmal.", "The CAD reader could not be loaded. Please try again.");
    default:
      return t(`Die Datei ließ sich nicht als ${label} lesen. Du kannst sie herunterladen.`, `The file could not be read as ${label}. You can download it.`);
  }
}
