"use client";
// Toolbar parts of the shape tool and the ruler (components/ink/ink-toolbar.tsx):
// which shape the tool draws (or "recognise" a stroke at once), fill and
// dashes for new shapes; the ruler, set square and compass.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowsLeftRight,
  Circle,
  CompassTool,
  Diamond,
  Hexagon,
  LineSegment,
  PaintBucket,
  Pentagon,
  Ruler,
  Scribble,
  Square,
  Star,
  Triangle,
  X,
} from "@phosphor-icons/react";
import { useT } from "../i18n";
import type { RulerMode } from "@/lib/ink/ruler";
import { SHAPE_TOOL_KINDS, type ShapeToolKind } from "@/lib/ink/shape-recognize";
import { setShapeSettings, showRuler, useRuler, useShapeSettings } from "./ink-stores";
import { useMenuPlacement } from "./menu-placement";
import type { InkEditor } from "./use-ink-editor";

const ICONS: Record<ShapeToolKind, React.ReactNode> = {
  auto: <Scribble size={19} />,
  line: <LineSegment size={19} />,
  arrow: <ArrowRight size={19} />,
  double: <ArrowsLeftRight size={19} />,
  rect: <Square size={19} />,
  ellipse: <Circle size={19} />,
  triangle: <Triangle size={19} />,
  diamond: <Diamond size={19} />,
  pentagon: <Pentagon size={19} />,
  hexagon: <Hexagon size={19} />,
  star: <Star size={19} />,
};

// Closes a menu on a press outside it or Escape.
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", press, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open, close, ref]);
}

export function ShapeToolOptions() {
  const t = useT();
  const settings = useShapeSettings();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const placeMenu = useMenuPlacement();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, anchor);
  const names: Record<ShapeToolKind, string> = {
    auto: t("Freihand erkennen", "Recognise freehand"),
    line: t("Linie", "Line"),
    arrow: t("Pfeil", "Arrow"),
    double: t("Doppelpfeil", "Double arrow"),
    rect: t("Rechteck", "Rectangle"),
    ellipse: t("Ellipse", "Ellipse"),
    triangle: t("Dreieck", "Triangle"),
    diamond: t("Raute", "Diamond"),
    pentagon: t("Fünfeck", "Pentagon"),
    hexagon: t("Sechseck", "Hexagon"),
    star: t("Stern", "Star"),
  };
  const dashes = { solid: t("Durchgezogen", "Solid"), dash: t("Gestrichelt", "Dashed"), dot: t("Gepunktet", "Dotted") };
  const nextDash = settings.dash === "solid" ? "dash" : settings.dash === "dash" ? "dot" : "solid";
  return (
    <div className="ink-group" role="group" aria-label={t("Formen", "Shapes")}>
      <div className="ink-menu-anchor" ref={anchor}>
        <button
          type="button"
          aria-label={`${t("Form", "Shape")}: ${names[settings.kind]}`}
          title={names[settings.kind]}
          aria-expanded={open}
          className="ink-shape-kind"
          onClick={() => setOpen((o) => !o)}
        >
          {ICONS[settings.kind]}
        </button>
        {open && (
          <div ref={placeMenu} className="ink-menu ink-shape-menu" role="radiogroup" aria-label={t("Form", "Shape")}>
            {SHAPE_TOOL_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={settings.kind === kind}
                className={settings.kind === kind ? "active" : ""}
                onClick={() => {
                  setShapeSettings({ kind });
                  setOpen(false);
                }}
              >
                {ICONS[kind]}
                <span>{names[kind]}</span>
              </button>
            ))}
            <span className="ink-menu-hint">
              {t(
                "„Freihand erkennen“: zeichnen, beim Absetzen wird die Form begradigt. Sonst ziehen: von Ecke zu Ecke.",
                "“Recognise freehand”: draw, the shape is straightened when you lift. Otherwise drag from corner to corner.",
              )}
            </span>
          </div>
        )}
      </div>
      <button
        type="button"
        aria-pressed={settings.fill}
        className={settings.fill ? "active" : ""}
        aria-label={t("Füllen", "Fill")}
        title={t("Neue Formen halbtransparent füllen", "Fill new shapes, semi-transparent")}
        onClick={() => setShapeSettings({ fill: !settings.fill })}
      >
        <PaintBucket size={19} weight={settings.fill ? "fill" : "regular"} />
      </button>
      <button
        type="button"
        aria-label={`${t("Linie", "Line")}: ${dashes[settings.dash]}`}
        title={dashes[settings.dash]}
        onClick={() => setShapeSettings({ dash: nextDash })}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <line
            x1="3"
            y1="10"
            x2="17"
            y2="10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={settings.dash === "dash" ? "4 3" : settings.dash === "dot" ? "0.1 3.5" : undefined}
          />
        </svg>
      </button>
    </div>
  );
}

// The page mostly in view: where the ruler goes.
function pageInView(fallback: string) {
  let best: { page: string; area: number } | null = null;
  for (const el of document.querySelectorAll<HTMLElement>(".ink-layer[data-editing][data-page]")) {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    const area = Math.max(0, w) * Math.max(0, h);
    if (area > 0 && (!best || area > best.area)) best = { page: el.dataset.page!, area };
  }
  return best?.page ?? fallback;
}

// The ruler: on/off, and which instrument while it is on.
export function RulerControls({ editor }: { editor: InkEditor }) {
  const t = useT();
  const ruler = useRuler();
  useEffect(() => () => showRuler(null), []);
  const modes: [RulerMode, string, React.ReactNode][] = [
    ["ruler", t("Lineal", "Ruler"), <Ruler key="r" size={19} />],
    ["protractor", t("Geodreieck", "Set square"), <Triangle key="p" size={19} />],
    ["compass", t("Zirkel", "Compass"), <CompassTool key="c" size={19} />],
  ];
  return (
    <div className="ink-group" role="group" aria-label={t("Lineal", "Ruler")}>
      {!ruler ? (
        <button
          type="button"
          aria-pressed={false}
          aria-label={t("Lineal einblenden", "Show ruler")}
          title={t("Lineal: mit einem Finger schieben, mit zwei drehen; mit dem Stift an der Kante zeichnen", "Ruler: move with one finger, turn with two; draw along the edge with the pen")}
          onClick={() => showRuler(pageInView(editor.lastPage.current))}
        >
          <Ruler size={19} />
        </button>
      ) : (
        <>
          <div role="radiogroup" aria-label={t("Messwerkzeug", "Measuring tool")} className="ink-group">
            {modes.map(([mode, label, icon]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={ruler.mode === mode}
                aria-label={label}
                title={label}
                className={ruler.mode === mode ? "active" : ""}
                onClick={() => showRuler(ruler.page, mode)}
              >
                {icon}
              </button>
            ))}
          </div>
          <button type="button" aria-label={t("Lineal ausblenden", "Hide ruler")} title={t("Lineal ausblenden", "Hide ruler")} onClick={() => showRuler(null)}>
            <X size={17} />
          </button>
        </>
      )}
    </div>
  );
}
