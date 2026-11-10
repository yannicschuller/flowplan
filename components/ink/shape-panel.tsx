"use client";
// The shape tool's sections of the tool panel (components/ink/ink-panel.tsx):
// a preview, which shape it draws (or "recognise" a stroke at once), line
// style and fill of new shapes; the ruler, set square and compass – in the
// shape panel and the gear's panel – and the ruler's button in the toolbar
// row (components/ink/ink-toolbar.tsx).
import { useEffect, useId } from "react";
import {
  ArrowRight,
  ArrowsLeftRight,
  Circle,
  CompassTool,
  Diamond,
  Hexagon,
  LineSegment,
  Pentagon,
  Ruler,
  Scribble,
  Square,
  Star,
  Triangle,
  X,
} from "@phosphor-icons/react";
import { useT } from "../i18n";
import { PEN_COLORS } from "@/lib/ink/presets";
import type { RulerMode } from "@/lib/ink/ruler";
import { SHAPE_TOOL_KINDS, dragShape, type ShapeToolKind } from "@/lib/ink/shape-recognize";
import { SHAPE_FILL_OPACITY, dashArray, shapePaths } from "@/lib/ink/shapes";
import { setShapeSettings, showRuler, useRuler, useShapeSettings, type ShapeToolSettings } from "./ink-stores";
import { SectionHead, Segmented, SettingSwitch } from "./panel-parts";
import type { InkEditor } from "./use-ink-editor";

type T = ReturnType<typeof useT>;

const ICONS: Record<ShapeToolKind, React.ReactNode> = {
  auto: <Scribble size={20} />,
  line: <LineSegment size={20} />,
  arrow: <ArrowRight size={20} />,
  double: <ArrowsLeftRight size={20} />,
  rect: <Square size={20} />,
  ellipse: <Circle size={20} />,
  triangle: <Triangle size={20} />,
  diamond: <Diamond size={20} />,
  pentagon: <Pentagon size={20} />,
  hexagon: <Hexagon size={20} />,
  star: <Star size={20} />,
};
const kindNames = (t: T): Record<ShapeToolKind, string> => ({
  auto: t("Erkennen", "Recognise"),
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
});
const DASHES: ShapeToolSettings["dash"][] = ["solid", "dash", "dot"];

function DashIcon({ dash }: { dash: ShapeToolSettings["dash"] }) {
  return (
    <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
      <line x1="2" y1="6" x2="20" y2="6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={dash === "dash" ? "4 3" : dash === "dot" ? "0.1 3.5" : undefined} />
    </svg>
  );
}

// The shape in hand as it will be drawn: kind, line colour and width, dashes, fill.
export function ShapePreview({ editor }: { editor: InkEditor }) {
  const settings = useShapeSettings();
  const { color, width } = editor.style;
  const w = Math.min(10, Math.max(1, width * 1.33));
  let d = "",
    heads = "",
    closed = false;
  if (settings.kind === "auto") d = "M118 44 C 104 20, 150 6, 186 12 S 222 40, 198 50 S 130 58, 121 38";
  else {
    const line = settings.kind === "line" || settings.kind === "arrow" || settings.kind === "double";
    const shape = line ? dragShape(settings.kind, { x: 84, y: 40 }, { x: 242, y: 22 }) : dragShape(settings.kind, { x: 128, y: 9 }, { x: 198, y: 53 });
    ({ body: d, heads, closed } = shapePaths(shape, width));
  }
  const fill = closed && settings.fill ? settings.fillColor || color : "none";
  return (
    <div className="ink-panel-preview" aria-hidden="true">
      <svg viewBox="0 0 326 62" preserveAspectRatio="xMidYMid meet">
        <path
          d={d}
          fill={fill}
          fillOpacity={fill === "none" ? undefined : SHAPE_FILL_OPACITY}
          stroke={color}
          strokeWidth={w}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={dashArray(settings.dash === "solid" ? undefined : settings.dash, w)?.join(" ")}
        />
        {heads && <path d={heads} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
    </div>
  );
}

// Which shape the tool draws.
export function ShapeKindSection() {
  const t = useT();
  const id = useId();
  const settings = useShapeSettings();
  const names = kindNames(t);
  return (
    <section className="ink-panel-sec" aria-labelledby={id}>
      <SectionHead id={id} label={t("Form", "Shape")} />
      <Segmented
        label={t("Form", "Shape")}
        className="ink-panel-kinds"
        value={settings.kind}
        onChange={(kind) => setShapeSettings({ kind })}
        options={SHAPE_TOOL_KINDS.map((kind) => ({ value: kind, label: names[kind], icon: ICONS[kind] }))}
      />
      <p className="ink-panel-note">
        {settings.kind === "auto"
          ? t("Zeichnen wie mit dem Stift – beim Absetzen wird die Form begradigt.", "Draw as with the pen – the shape is straightened when you lift.")
          : t("Von Ecke zu Ecke ziehen; mit Umschalt gleichmäßig. Antippen wählt eine Form zum Bearbeiten.", "Drag from corner to corner; with Shift evenly. Tap a shape to edit it.")}
      </p>
    </section>
  );
}

// Line style of new shapes.
export function ShapeLineSection() {
  const t = useT();
  const id = useId();
  const settings = useShapeSettings();
  const names = { solid: t("Durchgezogen", "Solid"), dash: t("Gestrichelt", "Dashed"), dot: t("Gepunktet", "Dotted") };
  return (
    <section className="ink-panel-sec" aria-labelledby={id}>
      <SectionHead id={id} label={t("Linienart", "Line style")} />
      <Segmented
        label={t("Linienart", "Line style")}
        className="ink-panel-dashes"
        value={settings.dash}
        onChange={(dash) => setShapeSettings({ dash })}
        options={DASHES.map((dash) => ({ value: dash, label: names[dash], icon: <DashIcon dash={dash} /> }))}
      />
    </section>
  );
}

// Fill of new closed shapes: on/off, the line's colour or one of the palette.
export function ShapeFillSection({ editor }: { editor: InkEditor }) {
  const t = useT();
  const id = useId();
  const settings = useShapeSettings();
  const swatch = (value: string | null, color: string, label: string) => {
    const on = settings.fillColor === value;
    return (
      <button
        key={value || "line"}
        type="button"
        role="radio"
        aria-checked={on}
        aria-label={label}
        title={label}
        className={`ink-swatch${value ? "" : " ink-swatch-same"}${on ? " active" : ""}`}
        style={{ "--swatch": color } as React.CSSProperties}
        onClick={() => setShapeSettings({ fillColor: value })}
      />
    );
  };
  return (
    <section className="ink-panel-sec ink-panel-settings" aria-labelledby={id}>
      <SectionHead id={id} label={t("Füllung", "Fill")} />
      <SettingSwitch
        title={t("Füllen", "Fill")}
        description={t("Neue Formen halbtransparent füllen", "Fill new shapes, semi-transparent")}
        checked={settings.fill}
        onChange={(fill) => setShapeSettings({ fill })}
      />
      {settings.fill && (
        <div className="ink-panel-swatches ink-panel-fills" role="radiogroup" aria-label={t("Füllfarbe", "Fill colour")}>
          {swatch(null, editor.style.color, t("Wie die Linie", "Same as the line"))}
          <span className="ink-panel-swatch-sep" aria-hidden="true" />
          {PEN_COLORS.map((c) => swatch(c, c, t(`Füllung ${c}`, `Fill ${c}`)))}
        </div>
      )}
    </section>
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
const rulerIcon = (mode: RulerMode, size = 19) =>
  mode === "protractor" ? <Triangle size={size} /> : mode === "compass" ? <CompassTool size={size} /> : <Ruler size={size} />;

// Ruler, set square or compass on the page, or none.
export function RulerSection({ editor }: { editor: InkEditor }) {
  const t = useT();
  const id = useId();
  const ruler = useRuler();
  const modes: { value: RulerMode | "off"; label: string; icon: React.ReactNode }[] = [
    { value: "off", label: t("Aus", "Off"), icon: <X size={16} /> },
    { value: "ruler", label: t("Lineal", "Ruler"), icon: rulerIcon("ruler", 17) },
    { value: "protractor", label: t("Geodreieck", "Set square"), icon: rulerIcon("protractor", 17) },
    { value: "compass", label: t("Zirkel", "Compass"), icon: rulerIcon("compass", 17) },
  ];
  return (
    <section className="ink-panel-sec" aria-labelledby={id}>
      <SectionHead id={id} label={t("Messwerkzeug", "Measuring tool")} />
      <Segmented
        label={t("Messwerkzeug", "Measuring tool")}
        className="ink-panel-rulers"
        value={ruler ? ruler.mode : "off"}
        onChange={(mode) => (mode === "off" ? showRuler(null) : showRuler(ruler?.page ?? pageInView(editor.lastPage.current), mode))}
        options={modes}
      />
      <p className="ink-panel-note">
        {t("Mit einem Finger schieben, mit zwei drehen; mit dem Stift an der Kante entlang zeichnen.", "Move with one finger, turn with two; draw along the edge with the pen.")}
      </p>
    </section>
  );
}

// The ruler's button in the toolbar row: shows the last instrument on the
// page in view, or hides it. Which one: in the shape or gear panel.
export function RulerToggle({ editor }: { editor: InkEditor }) {
  const t = useT();
  const ruler = useRuler();
  useEffect(() => () => showRuler(null), []);
  return (
    <button
      type="button"
      aria-pressed={!!ruler}
      className={ruler ? "active" : ""}
      aria-label={ruler ? t("Lineal ausblenden", "Hide ruler") : t("Lineal einblenden", "Show ruler")}
      title={ruler ? t("Lineal ausblenden", "Hide ruler") : t("Lineal: mit einem Finger schieben, mit zwei drehen; mit dem Stift an der Kante zeichnen", "Ruler: move with one finger, turn with two; draw along the edge with the pen")}
      onClick={() => showRuler(ruler ? null : pageInView(editor.lastPage.current))}
    >
      {rulerIcon(ruler?.mode ?? "ruler")}
    </button>
  );
}
