"use client";
// The toolbar of an ink editing session (components/ink/use-ink-editor.ts):
// tools, three favourite pens, colours, widths, eraser kind, undo/redo,
// paste and the pen settings (pen-only drawing, shape snapping, Apple Pencil
// double-tap). `children` go at the end (save, done, …).
import { useEffect, useRef, useState } from "react";
import {
  ArrowArcLeft,
  ArrowArcRight,
  ClipboardText,
  CursorClick,
  Eraser,
  GearSix,
  HighlighterCircle,
  Lasso,
  PencilSimple,
  TextT,
} from "@phosphor-icons/react";
import { useT } from "../i18n";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import type { InkTool, PencilSetting } from "@/lib/ink/presets";
import { INK_TOOL_KEYS, type InkEditor } from "./use-ink-editor";

export function InkToolbar({
  editor,
  children,
  toolKeys = false,
  label,
}: {
  editor: InkEditor;
  children?: React.ReactNode;
  toolKeys?: boolean;
  label?: string;
}) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const [settings, setSettings] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!settings) return;
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setSettings(false);
    };
    // Escape closes the menu, not what the toolbar is in.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setSettings(false);
    };
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [settings]);
  // Single-key tool shortcuts where they are on (useInkShortcuts `tools`).
  const toolKey = (tool: InkTool) => (toolKeys ? keyHints.suffix(Object.entries(INK_TOOL_KEYS).find(([, v]) => v === tool)?.[0].toUpperCase() || "") : "");
  const tools: [InkTool, string, React.ReactNode][] = [
    ["pen", t("Stift", "Pen"), <PencilSimple key="p" size={19} />],
    ["highlighter", t("Textmarker", "Highlighter"), <HighlighterCircle key="h" size={19} />],
    ["eraser", t("Radierer", "Eraser"), <Eraser key="e" size={19} />],
    ["lasso", t("Lasso", "Lasso"), <Lasso key="l" size={19} />],
    ["text", t("Text", "Text"), <TextT key="t" size={19} />],
    ["laser", t("Laserpointer", "Laser pointer"), <CursorClick key="z" size={19} />],
  ];
  const styled = editor.tool === "pen" || editor.tool === "highlighter" || editor.tool === "text";
  const widthLabel = (i: number) =>
    editor.tool === "text"
      ? [t("Kleine Schrift", "Small text"), t("Mittlere Schrift", "Medium text"), t("Große Schrift", "Large text")][i]
      : [t("Fein", "Fine||pen width"), t("Mittel", "Medium"), t("Breit", "Bold||pen width")][i];
  return (
    <div className="ink-toolbar" role="toolbar" aria-label={label || t("Werkzeuge zum Anmerken", "Annotation tools")}>
      <div role="radiogroup" aria-label={t("Werkzeug", "Tool")} className="ink-group">
        {tools.map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={editor.tool === id}
            aria-label={label}
            title={label + toolKey(id)}
            className={editor.tool === id ? "active" : ""}
            onClick={() => editor.setTool(id)}
          >
            {icon}
          </button>
        ))}
      </div>
      <div className="ink-group" role="group" aria-label={t("Lieblingsstifte", "Favourite pens")}>
        {editor.presets.map((p, i) => (
          <button
            key={i}
            type="button"
            aria-pressed={editor.preset === i && editor.tool === p.type}
            aria-label={t(`Lieblingsstift ${i + 1}`, `Favourite pen ${i + 1}`)}
            title={t(`Lieblingsstift ${i + 1} (Farbe und Breite ändern sich mit)`, `Favourite pen ${i + 1} (follows colour and width changes)`)}
            className={`ink-preset${editor.preset === i && editor.tool === p.type ? " active" : ""}`}
            onClick={() => editor.pickPreset(i)}
          >
            <span
              className={`ink-preset-mark ${p.type}`}
              style={{ "--swatch": p.color, "--mark": `${Math.max(2, Math.min(10, p.type === "highlighter" ? p.width / 2 : p.width * 1.6))}px` } as React.CSSProperties}
            />
          </button>
        ))}
      </div>
      {styled && (
        <div role="radiogroup" aria-label={t("Farbe", "Colour")} className="ink-group">
          {editor.palette.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={editor.style.color === c}
              aria-label={t(`Farbe ${c}`, `Colour ${c}`)}
              className={`ink-swatch${editor.style.color === c ? " active" : ""}`}
              style={{ "--swatch": c } as React.CSSProperties}
              onClick={() => editor.setStyle({ color: c })}
            />
          ))}
        </div>
      )}
      {styled && (
        <div role="radiogroup" aria-label={editor.tool === "text" ? t("Schriftgröße", "Text size") : t("Strichstärke", "Line width")} className="ink-group">
          {editor.widths.map((w, i) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={editor.style.width === w}
              aria-label={widthLabel(i)}
              title={widthLabel(i)}
              className={editor.style.width === w ? "active" : ""}
              onClick={() => editor.setStyle({ width: w })}
            >
              {editor.tool === "text" ? (
                <span className="ink-size" style={{ fontSize: 11 + i * 3 }}>
                  A
                </span>
              ) : (
                <span className="ink-width" style={{ height: 2 + i * 2.5 }} />
              )}
            </button>
          ))}
        </div>
      )}
      {editor.tool === "eraser" && (
        <div role="radiogroup" aria-label={t("Radierer", "Eraser")} className="ink-group ink-labels">
          <button type="button" role="radio" aria-checked={editor.eraserMode === "stroke"} className={editor.eraserMode === "stroke" ? "active" : ""} onClick={() => editor.setEraserMode("stroke")}>
            {t("Ganze Striche", "Whole strokes")}
          </button>
          <button type="button" role="radio" aria-checked={editor.eraserMode === "partial"} className={editor.eraserMode === "partial" ? "active" : ""} onClick={() => editor.setEraserMode("partial")}>
            {t("Teilweise", "Partial")}
          </button>
        </div>
      )}
      <div className="ink-group">
        <button type="button" aria-label={t("Rückgängig", "Undo")} title={t("Rückgängig", "Undo") + keyHints.suffix("Mod+Z")} disabled={!editor.canUndo} onClick={editor.undo}>
          <ArrowArcLeft size={19} />
        </button>
        <button type="button" aria-label={t("Wiederholen", "Redo")} title={t("Wiederholen", "Redo") + keyHints.suffix("Mod+Shift+Z")} disabled={!editor.canRedo} onClick={editor.redo}>
          <ArrowArcRight size={19} />
        </button>
        {editor.clipboard && (
          <button type="button" aria-label={t("Einfügen", "Paste")} title={t("Einfügen", "Paste") + keyHints.suffix("Mod+V")} onClick={() => editor.paste()}>
            <ClipboardText size={19} />
          </button>
        )}
        <div className="ink-menu-anchor" ref={menu}>
          <button
            type="button"
            aria-label={t("Stifteinstellungen", "Pen settings")}
            title={t("Stifteinstellungen", "Pen settings")}
            aria-expanded={settings}
            onClick={() => setSettings((s) => !s)}
          >
            <GearSix size={19} />
          </button>
          {settings && (
            <div className="ink-menu" role="group" aria-label={t("Stifteinstellungen", "Pen settings")}>
              <label>
                <input type="checkbox" checked={editor.penOnly} onChange={(e) => editor.setPenOnly(e.target.checked)} />
                {t("Nur mit dem Stift zeichnen", "Draw with the pen only")}
              </label>
              <span className="ink-menu-hint">{t("Finger blättern und zoomen dann.", "Fingers then scroll and zoom.")}</span>
              <label>
                <input type="checkbox" checked={editor.snap} onChange={(e) => editor.setSnap(e.target.checked)} />
                {t("Formen beim Halten begradigen", "Straighten shapes when holding")}
              </label>
              <span className="ink-menu-hint">{t("Am Ende eines Strichs kurz stillhalten: Linie, Rechteck, Ellipse …", "Hold still at the end of a stroke: line, rectangle, ellipse …")}</span>
              <label className="ink-menu-select">
                {t("Apple Pencil doppelt tippen", "Apple Pencil double-tap")}
                <select value={editor.pencil} onChange={(e) => editor.setPencil(e.target.value as PencilSetting)}>
                  <option value="system">{t("Wie in den iPad-Einstellungen", "As in the iPad settings")}</option>
                  <option value="eraser">{t("Radierer", "Eraser")}</option>
                  <option value="previous">{t("Letztes Werkzeug", "Last tool")}</option>
                  <option value="off">{t("Nichts", "Nothing")}</option>
                </select>
              </label>
            </div>
          )}
        </div>
      </div>
      {children && <div className="ink-group ink-end">{children}</div>}
    </div>
  );
}
