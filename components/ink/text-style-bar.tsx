"use client";
// The text style bar: the look of whole text boxes (lib/ink/text-style.ts)
// – face (each shown in itself), size (presets, slider, number), bold,
// italic, underline, alignment and line height, and the colour (palette,
// own colours lately used, colour picker). Shown as the second row of the
// lasso's selection bar when the selection holds text (ink-selection-bar.tsx,
// the colour is then in the bar's first row) and floating over a text box
// while it is typed or edited with the text tool (ink-layer.tsx).
// Where boxes differ, a control shows "—" (mixed) and applies to all of
// them. Every control is one undo step; a slider or number run is one too
// (the `merge` key of `onChange`).
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, Minus, Plus, TextAlignCenter, TextAlignLeft, TextAlignRight, TextB, TextItalic, TextUnderline } from "@phosphor-icons/react";
import { useLocale, useT } from "../i18n";
import { INK_FONTS, INK_FONT_NAMES, inkFontFamily, type InkFont } from "@/lib/ink/fonts";
import { PEN_COLORS, TEXT_SIZES, WIDTH_RANGES, clampWidth } from "@/lib/ink/presets";
import { LINE_HEIGHTS, TEXT_ALIGNS, type SharedTextLook, type TextAlign, type TextLookPatch } from "@/lib/ink/text-style";
import { InkPopover } from "./ink-style-picker";
import { MenuAvoid } from "./menu-placement";
import { ColorPicker } from "./color-picker";
import { InkSlider, SectionHead, Segmented } from "./panel-parts";

export const MIXED = "—";
type T = ReturnType<typeof useT>;

export const alignNames = (t: T): Record<TextAlign, string> => ({
  left: t("Links ausrichten", "Align left"),
  center: t("Mitte", "Centre||alignment"),
  right: t("Rechts ausrichten", "Align right"),
});
export const ALIGN_ICONS: Record<TextAlign, typeof TextAlignLeft> = {
  left: TextAlignLeft,
  center: TextAlignCenter,
  right: TextAlignRight,
};
export const fontKinds = (t: T): Record<InkFont, string> => ({
  sans: t("Serifenlos", "Sans serif"),
  serif: t("Serif", "Serif"),
  mono: t("Monospace", "Monospace"),
  caveat: t("Handschrift", "Handwriting"),
  patrick: t("Handschrift", "Handwriting"),
});

// The six faces, each in itself (radio buttons; none chosen when mixed).
export function FontList({ value, onChange, labelledBy }: { value: InkFont | undefined | null; onChange: (font: InkFont | undefined) => void; labelledBy?: string }) {
  const t = useT();
  const kinds = fontKinds(t);
  return (
    <div className="ink-panel-fonts" role="radiogroup" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : t("Schrift", "Font")}>
      {([undefined, ...INK_FONTS] as (InkFont | undefined)[]).map((font) => {
        const on = value !== null && (value || undefined) === font;
        return (
          <button key={font || "default"} type="button" role="radio" aria-checked={on} className={on ? "active" : ""} onClick={() => onChange(font)}>
            <span className={`ink-panel-font-name font-${font || "default"}`} style={{ fontFamily: inkFontFamily(font) }}>
              {font ? INK_FONT_NAMES[font] : t("Standard", "Default||font")}
            </span>
            <span className="ink-panel-font-meta">{on ? <Check size={16} weight="bold" aria-hidden="true" /> : font ? kinds[font] : "Helvetica"}</span>
          </button>
        );
      })}
    </div>
  );
}

// Bold, italic, underline as toggles; "mixed" when the boxes differ.
export function LookToggles({ look, onChange }: { look: Pick<SharedTextLook, "bold" | "italic" | "underline">; onChange: (patch: TextLookPatch) => void }) {
  const t = useT();
  const toggles = [
    { key: "bold" as const, label: t("Fett", "Bold"), Icon: TextB },
    { key: "italic" as const, label: t("Kursiv", "Italic"), Icon: TextItalic },
    {
      key: "underline" as const,
      label: t("Unterstrichen", "Underline"),
      Icon: TextUnderline,
    },
  ];
  return (
    <>
      {toggles.map(({ key, label, Icon }) => {
        const value = look[key];
        return (
          <button
            key={key}
            type="button"
            className={`ink-text-toggle${value ? " active" : ""}${value === null ? " is-mixed" : ""}`}
            aria-label={label}
            title={value === null ? `${label} (${t("gemischt", "mixed")})` : label}
            aria-pressed={value === null ? "mixed" : value}
            // Mixed: the first tap makes all of them so.
            onClick={() => onChange({ [key]: !value })}
          >
            <Icon size={17} weight={value ? "bold" : "regular"} />
          </button>
        );
      })}
    </>
  );
}

// The size: presets, slider (8–96 pt) and a number field with − and +.
export function SizeControls({ value, onChange }: { value: number | null; onChange: (size: number, merge?: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const { min, max } = WIDTH_RANGES.text;
  const shown = value === null ? MIXED : `${value.toLocaleString(locale, { maximumFractionDigits: 1 })} pt`;
  const [draft, setDraft] = useState<string | null>(null);
  const names = [t("Klein", "Small||text"), t("Mittel", "Medium"), t("Groß", "Large||text")];
  const label = t("Schriftgröße", "Text size");
  const set = (v: number, merge?: string) => onChange(clampWidth("text", v), merge);
  const step = (d: number) => set(Math.round((value ?? TEXT_SIZES[1]) + d));
  return (
    <>
      <Segmented
        label={label}
        value={TEXT_SIZES.find((s) => value !== null && Math.abs(s - value) < 0.05) ?? null}
        onChange={(s) => set(s)}
        options={TEXT_SIZES.map((s, i) => ({
          value: s,
          label: names[i],
          icon: (
            <span className="ink-size" style={{ fontSize: 11 + i * 3 }} aria-hidden="true">
              A
            </span>
          ),
        }))}
      />
      <InkSlider
        label={label}
        value={value ?? TEXT_SIZES[1]}
        min={min}
        max={max}
        ticks={TEXT_SIZES}
        valueText={shown}
        onChange={(v) => set(v, "size")}
        lo={<span className="ink-slider-a small">A</span>}
        hi={<span className="ink-slider-a">A</span>}
      />
      <div className="ink-text-size-field">
        <button type="button" aria-label={t("Kleiner", "Smaller")} title={t("Kleiner", "Smaller")} disabled={value !== null && value <= min} onClick={() => step(-1)}>
          <Minus size={14} weight="bold" />
        </button>
        <label>
          <input
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            aria-label={t("Schriftgröße in Punkt", "Text size in points")}
            placeholder={MIXED}
            value={draft ?? (value === null ? "" : String(value))}
            onChange={(e) => {
              setDraft(e.target.value);
              const n = Number(e.target.value.replace(",", "."));
              if (e.target.value && Number.isFinite(n) && n >= min && n <= max) set(n, "size-field");
            }}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const n = Number((draft ?? "").replace(",", "."));
                if (draft && Number.isFinite(n)) set(n);
                setDraft(null);
              }
            }}
          />
          <span aria-hidden="true">pt</span>
        </label>
        <button type="button" aria-label={t("Größer", "Larger")} title={t("Größer", "Larger")} disabled={value !== null && value >= max} onClick={() => step(1)}>
          <Plus size={14} weight="bold" />
        </button>
      </div>
    </>
  );
}

// Alignment of the lines and the line height.
export function AlignControls({ look, onChange }: { look: Pick<SharedTextLook, "align" | "lineHeight">; onChange: (patch: TextLookPatch) => void }) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const names = alignNames(t);
  return (
    <>
      <Segmented
        label={t("Ausrichtung", "Alignment")}
        className="ink-text-aligns"
        value={look.align}
        onChange={(align) => onChange({ align })}
        options={TEXT_ALIGNS.map((a) => {
          const Icon = ALIGN_ICONS[a];
          return {
            value: a,
            label: names[a],
            icon: <Icon size={17} aria-hidden="true" />,
          };
        })}
      />
      <SectionHead id={id} label={t("Zeilenabstand", "Line spacing")} value={look.lineHeight === null ? MIXED : undefined} />
      <Segmented
        label={t("Zeilenabstand", "Line spacing")}
        value={look.lineHeight}
        onChange={(lineHeight) => onChange({ lineHeight })}
        options={LINE_HEIGHTS.map((h) => ({
          value: h,
          label: h.toLocaleString(locale, {
            minimumFractionDigits: h % 1 ? 1 : 0,
          }),
        }))}
      />
    </>
  );
}

// Colours of the palette and own colours lately used, then the picker.
function ColorControls({
  value,
  recent,
  onChange,
  onRemember,
}: {
  value: string | null;
  recent: string[];
  onChange: (color: string, merge?: string) => void;
  onRemember: (color: string) => void;
}) {
  const t = useT();
  const own = recent.filter((c) => !PEN_COLORS.includes(c));
  return (
    <>
      <div className="ink-selection-colors" role="group" aria-label={t("Farbe", "Colour")}>
        {[...PEN_COLORS, ...own].map((c) => (
          <button
            key={c}
            type="button"
            className={`ink-swatch${value === c ? " active" : ""}`}
            style={{ "--swatch": c } as React.CSSProperties}
            aria-label={t(`Farbe ${c}`, `Colour ${c}`)}
            aria-pressed={value === c}
            onClick={() => onChange(c)}
          />
        ))}
      </div>
      <ColorPicker value={value || PEN_COLORS[0]} onChange={(c) => onChange(c, "color")} onCommit={onRemember} recent={[]} />
    </>
  );
}

export function TextStyleBar({
  look,
  onChange,
  color,
  className = "",
}: {
  look: SharedTextLook;
  onChange: (patch: TextLookPatch, merge?: string) => void;
  // With the colour (text tool); without it in the selection bar, whose
  // first row has the colour for every kind of item.
  color?: { recent: string[]; onRemember: (color: string) => void };
  className?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const fontId = useId();
  const sizeId = useId();
  const alignId = useId();
  const AlignIcon = look.align ? ALIGN_ICONS[look.align] : null;
  const fontName = look.font === null ? MIXED : look.font ? INK_FONT_NAMES[look.font] : "Helvetica";
  const sizeShown = look.size === null ? MIXED : `${look.size.toLocaleString(locale, { maximumFractionDigits: 1 })}`;
  return (
    <div className={`ink-text-bar ${className}`} role="group" aria-label={t("Textstil", "Text style")}>
      <InkPopover
        label={t("Schrift", "Font")}
        title={`${t("Schrift", "Font")}: ${fontName}`}
        className="ink-text-font"
        button={
          <span className={`ink-text-font-name${look.font === null ? " is-mixed" : ""}`} style={{ fontFamily: look.font === null ? undefined : inkFontFamily(look.font) }}>
            {look.font === null ? `${t("Schrift", "Font")} ${MIXED}` : fontName}
          </span>
        }
      >
        <div className="ink-text-menu">
          <SectionHead id={fontId} label={t("Schrift", "Font")} value={look.font === null ? MIXED : undefined} />
          <FontList value={look.font} onChange={(font) => onChange({ font })} labelledBy={fontId} />
        </div>
      </InkPopover>
      <InkPopover
        label={t("Schriftgröße", "Text size")}
        title={`${t("Schriftgröße", "Text size")}: ${look.size === null ? MIXED : `${sizeShown} pt`}`}
        className="ink-text-size"
        button={
          <span className="ink-text-size-label">
            {sizeShown}
            <small>pt</small>
          </span>
        }
      >
        <div className="ink-text-menu">
          <SectionHead id={sizeId} label={t("Schriftgröße", "Text size")} value={look.size === null ? MIXED : `${sizeShown} pt`} />
          <SizeControls value={look.size} onChange={(size, merge) => onChange({ size }, merge)} />
        </div>
      </InkPopover>
      <span className="ink-text-sep" aria-hidden="true" />
      <LookToggles look={look} onChange={onChange} />
      <span className="ink-text-sep" aria-hidden="true" />
      <InkPopover
        label={t("Ausrichtung und Zeilenabstand", "Alignment and line spacing")}
        className="ink-text-align"
        button={AlignIcon ? <AlignIcon size={17} /> : <span className="ink-text-mixed">{MIXED}</span>}
      >
        <div className="ink-text-menu">
          <SectionHead id={alignId} label={t("Ausrichtung", "Alignment")} value={look.align === null ? MIXED : undefined} />
          <AlignControls look={look} onChange={onChange} />
        </div>
      </InkPopover>
      {color && (
        <InkPopover
          label={t("Farbe", "Colour")}
          title={`${t("Farbe", "Colour")}: ${look.color ? look.color.toUpperCase() : MIXED}`}
          className="ink-selection-style"
          button={<span className="ink-selection-dot" style={{ "--swatch": look.color || "#868e96" } as React.CSSProperties} />}
        >
          <ColorControls value={look.color} recent={color.recent} onChange={(c, merge) => onChange({ color: c }, merge)} onRemember={color.onRemember} />
        </InkPopover>
      )}
    </div>
  );
}

// The bar over the text box being typed (text tool), kept inside the page:
// above the box, else below it. `anchor` is the text field.
export function FloatingTextBar({
  anchor,
  barRef,
  label,
  children,
  ...events
}: {
  label: string;
  onPointerDown?: React.PointerEventHandler<HTMLDivElement>;
  onBlur?: React.FocusEventHandler<HTMLDivElement>;
  anchor: React.RefObject<HTMLElement | null>;
  barRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const frame = useRef(0);
  // Its menus (size, face, …) open where they leave the text in view.
  const avoid = useCallback(() => anchor.current?.getBoundingClientRect() ?? null, [anchor]);
  useLayoutEffect(() => {
    const el = barRef.current;
    const field = anchor.current;
    const layer = el?.parentElement;
    if (!el || !field || !layer) return;
    const measure = () => {
      const box = layer.getBoundingClientRect();
      const at = field.getBoundingClientRect();
      const width = el.offsetWidth,
        height = el.offsetHeight;
      const left = Math.max(4, Math.min(at.left - box.left, layer.clientWidth - width - 4));
      const above = at.top - box.top - 8 - height;
      const top = above >= 4 ? above : at.bottom - box.top + 8;
      setPlace((now) => (now && Math.abs(now.left - left) < 0.5 && Math.abs(now.top - top) < 0.5 ? now : { left, top }));
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => (cancelAnimationFrame(frame.current), (frame.current = requestAnimationFrame(measure)))) : null;
    ro?.observe(field);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(frame.current);
    };
  });
  return (
    <div
      ref={barRef}
      className="ink-ui ink-selection-bar ink-text-float"
      role="toolbar"
      aria-label={label}
      {...events}
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: "hidden" }}
    >
      <MenuAvoid.Provider value={avoid}>{children}</MenuAvoid.Provider>
    </div>
  );
}
