"use client";
// The toolbar of an ink editing session (components/ink/use-ink-editor.ts):
// tools, favourite pens, colours (and an own one), widths, undo/redo, paste
// and the gear. Tapping the tool in hand again – or the gear – opens its
// panel (components/ink/ink-panel.tsx: free width, text face, colour
// picker, favourites, eraser kinds, shape kind and style, pen settings);
// the ruler has its button in the row. `page`: the page the
// person looks at (the eraser's "clear page"; else the last one drawn on).
// `children` go at the end (save, done, …).
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
  Shapes,
  TextT,
} from "@phosphor-icons/react";
import { useT } from "../i18n";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import type { InkTool } from "@/lib/ink/presets";
import { INK_TOOL_KEYS, type InkEditor } from "./use-ink-editor";
import { InkCustomColor } from "./ink-style-picker";
import { FavoriteChips, InkPanel } from "./ink-panel";
import { RulerToggle } from "./shape-panel";

// Tools with a panel of their own (tap the tool in hand again).
const PANEL_TOOLS: InkTool[] = ["pen", "highlighter", "text", "eraser", "shape"];

export function InkToolbar({
  editor,
  children,
  toolKeys = false,
  label,
  page,
}: {
  editor: InkEditor;
  children?: React.ReactNode;
  toolKeys?: boolean;
  label?: string;
  page?: string;
}) {
  const t = useT();
  const keyHints = useKeyboardHints();
  // The open panel: under the tool in hand, or under the gear.
  const [panel, setPanel] = useState<"tool" | "gear" | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!panel) return;
    const close = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setPanel(null);
    };
    // Escape closes the panel, not what the toolbar is in.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setPanel(null);
      opener.current?.focus();
    };
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [panel]);
  // The tool panel follows the tool in hand (a favourite, keys, Pencil
  // double-tap) and closes for a tool without one.
  useEffect(() => {
    if (!PANEL_TOOLS.includes(editor.tool)) setPanel((p) => (p === "tool" ? null : p));
  }, [editor.tool]);
  const panelFor = (align: "start" | "end") => (
    <InkPanel editor={editor} page={page || editor.lastPage.current} fromGear={panel === "gear"} align={align} onClose={() => (setPanel(null), opener.current?.focus())} />
  );
  // Single-key tool shortcuts where they are on (useInkShortcuts `tools`).
  const toolKey = (tool: InkTool) => (toolKeys ? keyHints.suffix(Object.entries(INK_TOOL_KEYS).find(([, v]) => v === tool)?.[0].toUpperCase() || "") : "");
  const tools: [InkTool, string, React.ReactNode][] = [
    ["pen", t("Stift", "Pen"), <PencilSimple key="p" size={19} />],
    ["highlighter", t("Textmarker", "Highlighter"), <HighlighterCircle key="h" size={19} />],
    ["eraser", t("Radierer", "Eraser"), <Eraser key="e" size={19} />],
    ["lasso", t("Lasso", "Lasso"), <Lasso key="l" size={19} />],
    ["shape", t("Formen", "Shapes"), <Shapes key="s" size={19} />],
    ["text", t("Text", "Text"), <TextT key="t" size={19} />],
    ["laser", t("Laserpointer", "Laser pointer"), <CursorClick key="z" size={19} />],
  ];
  const styled = editor.tool === "pen" || editor.tool === "highlighter" || editor.tool === "text" || editor.tool === "shape";
  const widthLabel = (i: number) =>
    editor.tool === "text"
      ? [t("Kleine Schrift", "Small text"), t("Mittlere Schrift", "Medium text"), t("Große Schrift", "Large text")][i]
      : [t("Fein", "Fine||pen width"), t("Mittel", "Medium"), t("Breit", "Bold||pen width")][i];
  return (
    <div className="ink-toolbar" role="toolbar" aria-label={label || t("Werkzeuge zum Anmerken", "Annotation tools")}>
      <div role="radiogroup" aria-label={t("Werkzeug", "Tool")} className="ink-group">
        {tools.map(([id, label, icon]) => {
          const on = editor.tool === id;
          const hasPanel = on && PANEL_TOOLS.includes(id);
          const button = (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={label}
              aria-haspopup={hasPanel ? "dialog" : undefined}
              aria-expanded={hasPanel ? panel === "tool" : undefined}
              title={label + toolKey(id) + (hasPanel ? ` – ${t("noch einmal tippen für Einstellungen", "tap again for settings")}` : "")}
              className={`${on ? "active" : ""}${hasPanel && panel === "tool" ? " is-open" : ""}`}
              onClick={(e) => {
                if (hasPanel) {
                  opener.current = e.currentTarget;
                  setPanel((p) => (p === "tool" ? null : "tool"));
                } else editor.setTool(id);
              }}
            >
              {icon}
            </button>
          );
          return hasPanel ? (
            <span
              key={id}
              className="ink-menu-anchor"
              ref={(el) => {
                if (panel === "tool") anchor.current = el;
              }}
            >
              {button}
              {panel === "tool" && panelFor("start")}
            </span>
          ) : (
            button
          );
        })}
      </div>
      {editor.favorites.length > 0 && (
        <div className="ink-group" role="group" aria-label={t("Lieblingsstifte", "Favourite pens")}>
          <FavoriteChips editor={editor} />
        </div>
      )}
      {styled && (
        <div className="ink-group">
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
          <InkCustomColor editor={editor} />
        </div>
      )}
      {styled && (
        <div className="ink-group">
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
        </div>
      )}
      <div className="ink-group">
        <RulerToggle editor={editor} />
      </div>
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
        <div
          className="ink-menu-anchor"
          ref={(el) => {
            if (panel === "gear") anchor.current = el;
          }}
        >
          <button
            type="button"
            aria-label={t("Stifteinstellungen", "Pen settings")}
            title={t("Stifteinstellungen", "Pen settings")}
            aria-haspopup="dialog"
            aria-expanded={panel === "gear"}
            onClick={(e) => {
              opener.current = e.currentTarget;
              setPanel((p) => (p === "gear" ? null : "gear"));
            }}
          >
            <GearSix size={19} />
          </button>
          {panel === "gear" && panelFor("end")}
        </div>
      </div>
      {children && <div className="ink-group ink-end">{children}</div>}
    </div>
  );
}
