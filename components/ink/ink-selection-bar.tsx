"use client";
// The bar over a lasso selection (components/ink/ink-layer.tsx): colour
// (palette, own colours lately used, colour picker) and width, cut, copy,
// duplicate, to the front or back, "In Text umwandeln" and delete. Every
// button is one undo step. Kept inside the page surface's width.
import { useLayoutEffect, useRef, useState } from "react";
import {
  Copy,
  CopySimple,
  Scissors,
  SelectionBackground,
  SelectionForeground,
  TextAa,
  Trash,
} from "@phosphor-icons/react";
import { useT } from "../i18n";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import type { PageSize } from "@/lib/ink/coords";
import type { Box } from "@/lib/ink/geometry";
import type { InkItem } from "@/lib/ink/model";
import { PEN_COLORS } from "@/lib/ink/presets";
import { sharedWidthStep, WIDTH_STEPS } from "@/lib/ink/selection";
import { useAiAvailability, useAiBlockedHint } from "../ai-context";
import { ColorPicker } from "./color-picker";
import { InkPopover } from "./ink-style-picker";
import { AiConvertDialog } from "./ai-convert";
import type { InkEditor } from "./use-ink-editor";

export function InkSelectionBar({
  editor,
  page,
  size,
  box,
  items,
  onConvert,
  aiPageId,
}: {
  editor: InkEditor;
  page: string;
  size: PageSize;
  box: Box;
  items: InkItem[];
  // The device's recognition (lib/ink/recognition.ts), used when the
  // instance's AI is not available here.
  onConvert?: () => void;
  aiPageId?: string;
}) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const bar = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [converting, setConverting] = useState(false);
  const ai = useAiAvailability("handwriting", aiPageId || null);
  const blockedHint = useAiBlockedHint();
  const aiShown = !!aiPageId && ai !== "hidden";
  const pens = items.some((i) => i.type === "pen");
  const colored = items.filter((i) => i.type !== "highlighter");
  const colors = new Set(colored.map((i) => i.color));
  const color = colors.size === 1 ? [...colors][0] : null;
  const [draft, setDraft] = useState<string | null>(null);
  const step = sharedWidthStep(items);

  // Above the box and its rotation handle, else below it; inside the page.
  useLayoutEffect(() => {
    const el = bar.current;
    const layer = el?.parentElement;
    if (!el || !layer) return;
    const k = layer.clientWidth / (size.width || 1);
    const width = el.offsetWidth,
      height = el.offsetHeight;
    const left = Math.max(4, Math.min(box.x * k, layer.clientWidth - width - 4));
    const above = box.y * k - 44 - height;
    const top = above >= 4 ? above : (box.y + box.h) * k + 14;
    setPlace((now) => (now && Math.abs(now.left - left) < 0.5 && Math.abs(now.top - top) < 0.5 ? now : { left, top }));
  }, [box.x, box.y, box.h, size.width, items.length]);

  const button = (label: string, icon: React.ReactNode, onClick: () => void, shortcut = "", extra: Partial<React.ButtonHTMLAttributes<HTMLButtonElement>> = {}) => (
    <button type="button" aria-label={label} title={label + (shortcut ? keyHints.suffix(shortcut) : "")} onClick={onClick} {...extra}>
      {icon}
    </button>
  );
  const widthLabels = [t("Fein", "Fine||pen width"), t("Mittel", "Medium"), t("Breit", "Bold||pen width")];
  return (
    <div
      ref={bar}
      className="ink-ui ink-selection-bar"
      role="toolbar"
      aria-label={t("Auswahl", "Selection")}
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: "hidden" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <InkPopover
        label={t("Farbe und Stärke", "Colour and width")}
        className="ink-selection-style"
        button={<span className="ink-selection-dot" style={{ "--swatch": draft || color || "#868e96" } as React.CSSProperties} />}
      >
        <div className="ink-selection-colors" role="group" aria-label={t("Farbe", "Colour")}>
          {[...PEN_COLORS, ...editor.recentColors.filter((c) => !PEN_COLORS.includes(c))].map((c) => (
            <button
              key={c}
              type="button"
              className={`ink-swatch${color === c ? " active" : ""}`}
              style={{ "--swatch": c } as React.CSSProperties}
              aria-label={t(`Farbe ${c}`, `Colour ${c}`)}
              aria-pressed={color === c}
              onClick={() => editor.recolorSelection(c)}
            />
          ))}
        </div>
        <ColorPicker
          value={draft || color || PEN_COLORS[0]}
          onChange={setDraft}
          onCommit={(c) => {
            setDraft(null);
            editor.recolorSelection(c);
            editor.rememberCustomColor(c);
          }}
          recent={[]}
        />
        <div className="ink-selection-widths" role="group" aria-label={t("Strichstärke", "Line width")}>
          {Array.from({ length: WIDTH_STEPS }, (_, i) => (
            <button key={i} type="button" aria-label={widthLabels[i]} title={widthLabels[i]} aria-pressed={step === i} className={step === i ? "active" : ""} onClick={() => editor.setSelectionWidth(i)}>
              <span className="ink-width" style={{ height: 2 + i * 2.5 }} />
            </button>
          ))}
        </div>
      </InkPopover>
      {button(t("Ausschneiden", "Cut"), <Scissors size={17} />, () => editor.cutSelection(), "Mod+X")}
      {button(t("Kopieren", "Copy"), <Copy size={17} />, () => editor.copySelection(), "Mod+C")}
      {button(t("Duplizieren", "Duplicate"), <CopySimple size={17} />, () => editor.duplicateSelection(), "Mod+D")}
      {button(t("Nach vorne", "Bring to front"), <SelectionForeground size={17} />, () => editor.reorderSelection("front"), "Mod+]")}
      {button(t("Nach hinten", "Send to back"), <SelectionBackground size={17} />, () => editor.reorderSelection("back"), "Mod+[")}
      {pens &&
        (aiShown
          ? button(
              t("In Text umwandeln", "Convert to text"),
              <TextAa size={17} />,
              () => setConverting(true),
              "",
              ai === "blocked" ? { disabled: true, title: blockedHint, className: "ink-convert" } : { className: "ink-convert" },
            )
          : onConvert && button(t("In Text umwandeln", "Convert to text"), <TextAa size={17} />, onConvert, "", { className: "ink-convert" }))}
      {button(t("Auswahl löschen", "Delete selection"), <Trash size={17} />, () => editor.deleteSelection(), "Delete")}
      {converting && aiPageId && (
        <AiConvertDialog editor={editor} page={page} size={size} pageId={aiPageId} items={items} onClose={() => setConverting(false)} />
      )}
    </div>
  );
}
