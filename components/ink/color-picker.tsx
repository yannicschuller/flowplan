"use client";
// A colour picker without a library: saturation/brightness area, hue
// slider, hex field and a row of recent colours. Pointer events throughout
// (mouse, finger, Apple Pencil); the area moves with the arrow keys
// (Shift: in larger steps), the hue is a native range input. Colours are
// "#rrggbb". `onChange` follows every move; `onCommit` comes at the end of a
// drag, a key press, a valid hex or a recent colour (to remember it).
// Where the browser has the EyeDropper API (Chrome, Edge – not Safari), a
// button picks a colour from the screen; elsewhere it is not shown.
import { useEffect, useRef, useState } from "react";
import { Eyedropper } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from "@/lib/ink/color";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
type EyeDropperApi = new () => { open: () => Promise<{ sRGBHex: string }> };
const eyeDropper = () => (typeof window !== "undefined" ? (window as unknown as { EyeDropper?: EyeDropperApi }).EyeDropper : undefined);

export function ColorPicker({
  value,
  onChange,
  onCommit,
  recent = [],
}: {
  value: string;
  onChange: (color: string) => void;
  onCommit?: (color: string) => void;
  recent?: string[];
}) {
  const t = useT();
  // The hue is kept apart: grey and black have none of their own, and the
  // area should not jump back to red when the colour passes through them.
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const current = useRef(value);
  useEffect(() => {
    if (value === current.current) return;
    current.current = value;
    setHsv((now) => {
      const next = hexToHsv(value);
      return next.s === 0 || next.v === 0 ? { ...next, h: now.h } : next;
    });
  }, [value]);
  const [hex, setHex] = useState(value);
  useEffect(() => setHex(value), [value]);
  const area = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // After mounting (the server has no window).
  const [canPick, setCanPick] = useState(false);
  useEffect(() => setCanPick(!!eyeDropper()), []);
  const pickFromScreen = async () => {
    const Api = eyeDropper();
    if (!Api) return;
    try {
      const color = normalizeHex((await new Api().open()).sRGBHex);
      if (!color) return;
      current.current = color;
      setHsv(hexToHsv(color));
      onChange(color);
      onCommit?.(color);
    } catch {
      // Cancelled (Escape).
    }
  };

  const apply = (next: Hsv, commit = false) => {
    setHsv(next);
    const color = hsvToHex(next);
    current.current = color;
    onChange(color);
    if (commit) onCommit?.(color);
  };
  const fromPointer = (event: React.PointerEvent) => {
    const box = area.current!.getBoundingClientRect();
    return { ...hsv, s: clamp01((event.clientX - box.left) / box.width), v: clamp01(1 - (event.clientY - box.top) / box.height) };
  };
  const onKey = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step], Home: [-1, 0], End: [1, 0], PageUp: [0, 1], PageDown: [0, -1] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    apply({ ...hsv, s: clamp01(hsv.s + move[0]), v: clamp01(hsv.v + move[1]) }, true);
  };
  const percent = (n: number) => Math.round(n * 100);
  const hue = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  return (
    <div className="color-picker">
      <div
        ref={area}
        className="color-picker-area"
        role="slider"
        tabIndex={0}
        aria-label={t("Sättigung und Helligkeit", "Saturation and brightness")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent(hsv.s)}
        aria-valuetext={t(`Sättigung ${percent(hsv.s)} %, Helligkeit ${percent(hsv.v)} %`, `Saturation ${percent(hsv.s)}%, brightness ${percent(hsv.v)}%`)}
        style={{ "--hue": hue } as React.CSSProperties}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          if (e.button > 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus({ preventScroll: true });
          dragging.current = true;
          apply(fromPointer(e));
        }}
        onPointerMove={(e) => dragging.current && apply(fromPointer(e))}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          apply(fromPointer(e), true);
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        <span className="color-picker-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }} />
      </div>
      <input
        type="range"
        className="color-picker-hue"
        min={0}
        max={359}
        step={1}
        value={Math.round(hsv.h)}
        aria-label={t("Farbton", "Hue")}
        aria-valuetext={`${Math.round(hsv.h)}°`}
        onChange={(e) => apply({ ...hsv, h: Number(e.target.value), s: hsv.s || 1, v: hsv.v || 1 })}
        onPointerUp={() => onCommit?.(current.current)}
        onKeyUp={(e) => e.key.startsWith("Arrow") && onCommit?.(current.current)}
      />
      <div className="color-picker-row">
        <span className="color-picker-preview" style={{ background: value }} aria-hidden="true" />
        <label className="color-picker-hex">
          <span className="sr-only">{t("Hex", "Hex")}</span>
          <input
            type="text"
            inputMode="text"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={7}
            value={hex}
            aria-invalid={!normalizeHex(hex)}
            onChange={(e) => {
              setHex(e.target.value);
              const color = normalizeHex(e.target.value);
              if (color && e.target.value.replace("#", "").length === 6) {
                current.current = color;
                setHsv(hexToHsv(color));
                onChange(color);
              }
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              const color = normalizeHex(hex);
              if (!color) return;
              current.current = color;
              setHsv(hexToHsv(color));
              onChange(color);
              onCommit?.(color);
            }}
            onBlur={() => {
              const color = normalizeHex(hex);
              if (color && color !== value) {
                current.current = color;
                setHsv(hexToHsv(color));
                onChange(color);
              }
              if (color) onCommit?.(color);
              else setHex(value);
            }}
          />
        </label>
        {canPick && (
          <button type="button" className="color-picker-eyedropper" aria-label={t("Farbe vom Bildschirm aufnehmen", "Pick a colour from the screen")} title={t("Pipette", "Eyedropper")} onClick={() => void pickFromScreen()}>
            <Eyedropper size={17} />
          </button>
        )}
      </div>
      {recent.length > 0 && <span className="color-picker-recent-label">{t("Zuletzt verwendet", "Recently used")}</span>}
      {recent.length > 0 && (
        <div className="color-picker-recent" role="group" aria-label={t("Zuletzt verwendet", "Recently used")}>
          {recent.map((c) => (
            <button
              key={c}
              type="button"
              className={`ink-swatch${c === value ? " active" : ""}`}
              aria-pressed={c === value}
              aria-label={t(`Farbe ${c}`, `Colour ${c}`)}
              title={c}
              style={{ "--swatch": c } as React.CSSProperties}
              onClick={() => {
                current.current = c;
                setHsv(hexToHsv(c));
                onChange(c);
                onCommit?.(c);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
