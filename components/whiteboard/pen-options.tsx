"use client";
// The pen's options on the board (#455): pen or highlighter, the colour
// (palette and colour wheel), three widths and the opacity. Each kind keeps
// its own colour, width and opacity; the last used setting is remembered on
// this device (lib/whiteboard-pen.ts).
import { Highlighter, PencilSimple } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { strokeColors } from "@/lib/whiteboard-model";
import { HIGHLIGHTER_COLORS, HIGHLIGHTER_OPACITY, HIGHLIGHTER_WIDTHS, MIN_OPACITY, OPACITY_STEP, PEN_WIDTHS, cleanOpacity, strokeLook, type PenSettings, type PenStyle } from "@/lib/whiteboard-pen";
import type { WhiteboardItem } from "@/lib/whiteboard-model";
import { Select } from "../select";
import { BoardColorPicker } from "./board-color-picker";

export function PenOptions({ settings, onChange }: { settings: PenSettings; onChange: (next: PenSettings) => void }) {
  const t = useT();
  const mode = settings.mode;
  const style = settings[mode];
  const highlighter = mode === "highlighter";
  const palette = highlighter ? HIGHLIGHTER_COLORS : strokeColors;
  const widths: readonly number[] = highlighter ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS;
  const set = (patch: Partial<PenStyle>) => onChange({ ...settings, [mode]: { ...style, ...patch } });
  const percent = Math.round(style.opacity * 100);
  return (
    <>
      <div className="wb-pen-modes" role="group" aria-label={t("Stiftart", "Pen type")}>
        <button type="button" className={!highlighter ? "active" : ""} aria-pressed={!highlighter} aria-label={t("Normaler Stift", "Regular pen")} onClick={() => onChange({ ...settings, mode: "pen" })}>
          <PencilSimple size={16} aria-hidden="true" /> {t("Stift", "Pen")}
        </button>
        <button type="button" className={highlighter ? "active" : ""} aria-pressed={highlighter} onClick={() => onChange({ ...settings, mode: "highlighter" })}>
          <Highlighter size={16} aria-hidden="true" /> {t("Textmarker", "Highlighter")}
        </button>
      </div>
      {/* Colours as a compact grid, then the width, then the opacity. */}
      <div className="wb-pen-colors" role="group" aria-label={highlighter ? t("Textmarkerfarbe", "Highlighter colour") : t("Stiftfarbe", "Pen colour")}>
        {palette.map((c) => (
          <button
            key={c}
            className={`wb-swatch line${style.color === c ? " active" : ""}`}
            style={{ borderColor: c }}
            aria-label={highlighter ? t(`Textmarkerfarbe ${c}`, `Highlighter colour ${c}`) : t(`Stiftfarbe ${c}`, `Pen colour ${c}`)}
            aria-pressed={style.color === c}
            onClick={() => set({ color: c })}
          />
        ))}
        <BoardColorPicker inline label={t("Eigene Farbe", "Custom colour")} value={style.color} presets={palette} onPick={(color) => set({ color })} />
      </div>
      <div className="wb-pen-widths" role="group" aria-label={t("Strichstärke", "Line width")}>
        {widths.map((w, i) => {
          const name = i === 0 ? t("Fein", "Fine||pen width") : i === 1 ? t("Mittel", "Medium") : t("Breit", "Bold||pen width");
          return (
            <button key={w} className={style.width === w ? "active" : ""} aria-pressed={style.width === w} aria-label={name} title={name} onClick={() => set({ width: w })}>
              <span className={`wb-pen-width-line ${highlighter ? `wh${i}` : `w${w}`}`} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <label className="wb-pen-opacity">
        <span>{t("Deckkraft", "Opacity")}</span>
        <input
          type="range"
          min={MIN_OPACITY * 100}
          max={100}
          step={OPACITY_STEP * 100}
          value={percent}
          aria-valuetext={`${percent} %`}
          onChange={(e) => set({ opacity: cleanOpacity(Number(e.target.value) / 100) })}
        />
        <output>{percent} %</output>
      </label>
    </>
  );
}

// Selected strokes in the style bar: their opacity and whether they are
// highlighter strokes.
const OPACITY_CHOICES = [100, 75, 50, Math.round(HIGHLIGHTER_OPACITY * 100), 25];
export function PenLookControls({ selected, onSet }: { selected: WhiteboardItem[]; onSet: (props: Partial<WhiteboardItem>) => void }) {
  const t = useT();
  const first = selected.find((i) => i.type === "pen");
  if (!first) return null;
  const look = strokeLook(first);
  const percent = Math.round((look.opacity ?? 1) * 100);
  const choices = [...new Set([...OPACITY_CHOICES, percent])].sort((a, b) => b - a);
  return (
    <>
      <Select aria-label={t("Deckkraft", "Opacity")} value={percent} onChange={(e) => onSet({ opacity: Number(e.target.value) >= 100 ? undefined : cleanOpacity(Number(e.target.value) / 100) })}>
        {choices.map((p) => (
          <option key={p} value={p}>
            {p} %
          </option>
        ))}
      </Select>
      <button
        className={look.highlight ? "active" : ""}
        aria-pressed={look.highlight}
        aria-label={t("Textmarker", "Highlighter")}
        title={t("Als Textmarker über Bildern (multipliziert)", "As a highlighter over pictures (multiplied)")}
        onClick={() => onSet({ highlight: look.highlight ? undefined : true })}
      >
        <Highlighter size={16} />
      </button>
    </>
  );
}
