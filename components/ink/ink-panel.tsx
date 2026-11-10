"use client";
// The panel of a tool (components/ink/ink-toolbar.tsx): opened by tapping
// the tool in hand again, or the gear. Pen and highlighter: favourite pens,
// a live preview, the width (presets and a slider), the colour (standard
// colours, the last own one and the colour picker beside the panel) and the
// input settings. Text: size, face, style (bold, italic, underline,
// alignment, line height) and colour – for new text; text on the page has
// its own bar (text-style-bar.tsx); the input settings folded
// into one row. Eraser: its kind, the size of the partial eraser and
// clearing the page. Shapes: a preview, the kind, width, line style, colour,
// fill and the ruler (components/ink/shape-panel.tsx). Lasso and laser
// (gear only): the ruler and the input settings.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CaretRight, Check, PencilSimpleLine, Plus, Trash, X } from "@phosphor-icons/react";
import { useLocale, useT } from "../i18n";
import { HIGHLIGHTER_OPACITY, clampWidth, type InkTool, type PencilSetting } from "@/lib/ink/presets";
import { INK_FONTS, INK_FONT_NAMES, inkFontFamily, type InkFont } from "@/lib/ink/fonts";
import { ERASER_SIZE, type EraserMode } from "@/lib/ink/eraser";
import { MAX_FAVORITES, favoriteMark, type InkFavorite } from "@/lib/ink/favorites";
import type { InkEditor } from "./use-ink-editor";
import { placeMenu } from "./menu-placement";
import { ColorPicker } from "./color-picker";
import { InkSlider, SectionHead, Segmented, SettingSwitch } from "./panel-parts";
import { RulerSection, ShapeFillSection, ShapeKindSection, ShapeLineSection, ShapePreview } from "./shape-panel";
import { AlignControls, LookToggles } from "./text-style-bar";
import { LINE_HEIGHT } from "@/lib/ink/model";

type T = ReturnType<typeof useT>;
const STYLED: InkTool[] = ["pen", "highlighter", "text"];

export const toolName = (t: T, tool: InkTool) =>
  ({
    pen: t("Stift", "Pen"),
    highlighter: t("Textmarker", "Highlighter"),
    eraser: t("Radierer", "Eraser"),
    lasso: t("Lasso", "Lasso"),
    text: t("Text", "Text"),
    laser: t("Laserpointer", "Laser pointer"),
    shape: t("Formen", "Shapes"),
  })[tool];

// ---- Favourite chips (also in the toolbar row) ----

export function favoriteLabel(t: T, fav: InkFavorite, number: (n: number) => string) {
  const face = fav.type === "text" ? (fav.font ? INK_FONT_NAMES[fav.font] : t("Standardschrift", "Default font")) : "";
  return `${toolName(t, fav.type)}, ${fav.color}, ${number(fav.width)} pt${face ? `, ${face}` : ""}`;
}
export function FavoriteMark({ fav }: { fav: InkFavorite }) {
  if (fav.type === "text")
    return (
      <span className="ink-preset-text" style={{ color: fav.color, fontFamily: inkFontFamily(fav.font) }}>
        A
      </span>
    );
  return <span className={`ink-preset-mark ${fav.type}`} style={{ "--swatch": fav.color, "--mark": `${favoriteMark(fav)}px` } as React.CSSProperties} />;
}
export function FavoriteChips({ editor, className = "ink-preset" }: { editor: InkEditor; className?: string }) {
  const t = useT();
  const number = useNumber();
  return (
    <>
      {editor.favorites.map((fav, i) => {
        const label = favoriteLabel(t, fav, number);
        const on = editor.favorite === i;
        return (
          <button
            key={`${i}-${fav.type}-${fav.color}-${fav.width}-${fav.font || ""}`}
            type="button"
            aria-pressed={on}
            aria-label={t(`Lieblingsstift ${i + 1}: ${label}`, `Favourite pen ${i + 1}: ${label}`)}
            title={label}
            className={`${className}${on ? " active" : ""}`}
            onClick={() => editor.pickFavorite(i)}
          >
            <FavoriteMark fav={fav} />
          </button>
        );
      })}
    </>
  );
}

function useNumber() {
  const locale = useLocale();
  return useCallback((n: number, digits = 1) => n.toLocaleString(locale, { maximumFractionDigits: digits }), [locale]);
}

// ---- Sections ----

function Preview({ editor }: { editor: InkEditor }) {
  const t = useT();
  const { color, width, font } = editor.style;
  return (
    <div className="ink-panel-preview" aria-hidden="true">
      {editor.tool === "text" ? (
        <span
          style={{
            fontFamily: inkFontFamily(font),
            fontSize: Math.max(12, Math.min(width * 1.33, 40)),
            color,
            fontWeight: editor.style.bold ? 700 : undefined,
            fontStyle: editor.style.italic ? "italic" : undefined,
            textDecoration: editor.style.underline ? "underline" : undefined,
          }}
        >
          {t("Notizen am Rand", "Notes in the margin")}
        </span>
      ) : (
        <svg viewBox="0 0 326 62" preserveAspectRatio="xMidYMid meet">
          <path
            d="M18 40 C 60 10, 90 12, 110 32 S 160 56, 190 30 S 250 8, 306 26"
            fill="none"
            stroke={color}
            strokeOpacity={editor.tool === "highlighter" ? HIGHLIGHTER_OPACITY : 1}
            strokeWidth={Math.min(36, width * 1.33)}
            strokeLinecap={editor.tool === "highlighter" ? "butt" : "round"}
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

function WidthSection({ editor }: { editor: InkEditor }) {
  const t = useT();
  const number = useNumber();
  const text = editor.tool === "text";
  const kind = text ? "text" : editor.tool === "highlighter" ? "highlighter" : "pen";
  const { min, max } = editor.widthRange;
  const width = editor.style.width;
  const shown = `${number(width, text ? 0 : 1)} pt`;
  const label = text ? t("Schriftgröße", "Text size") : t("Strichstärke", "Line width");
  const names = text
    ? [t("Klein", "Small||text"), t("Mittel", "Medium"), t("Groß", "Large||text")]
    : [t("Fein", "Fine||pen width"), t("Mittel", "Medium"), t("Breit", "Bold||pen width")];
  const id = useId();
  return (
    <section className="ink-panel-sec" aria-labelledby={id}>
      <SectionHead id={id} label={label} value={shown} />
      <Segmented
        label={label}
        value={editor.widths.find((w) => Math.abs(w - width) < 0.05) ?? null}
        onChange={(w) => editor.setStyle({ width: w })}
        options={editor.widths.map((w, i) => ({
          value: w,
          label: names[i],
          icon: text ? (
            <span className="ink-size" style={{ fontSize: 11 + i * 3 }} aria-hidden="true">
              A
            </span>
          ) : (
            <span className="ink-width" style={{ height: 2 + i * 2.5 }} aria-hidden="true" />
          ),
        }))}
      />
      <InkSlider
        label={label}
        value={width}
        min={min}
        max={max}
        ticks={editor.widths}
        valueText={shown}
        onChange={(v) => editor.setStyle({ width: clampWidth(kind, v) })}
        lo={text ? <span className="ink-slider-a small">A</span> : <span className="ink-slider-dot" style={{ width: 4, height: 4 }} />}
        hi={text ? <span className="ink-slider-a">A</span> : <span className="ink-slider-dot" style={{ width: 12, height: 12 }} />}
      />
    </section>
  );
}

function FontSection({ editor }: { editor: InkEditor }) {
  const t = useT();
  const id = useId();
  const kinds: Record<InkFont, string> = {
    sans: t("Serifenlos", "Sans serif"),
    serif: t("Serif", "Serif"),
    mono: t("Monospace", "Monospace"),
    caveat: t("Handschrift", "Handwriting"),
    patrick: t("Handschrift", "Handwriting"),
  };
  return (
    <section className="ink-panel-sec" aria-labelledby={id}>
      <SectionHead id={id} label={t("Schrift", "Font")} />
      <div className="ink-panel-fonts" role="radiogroup" aria-labelledby={id}>
        {([undefined, ...INK_FONTS] as (InkFont | undefined)[]).map((font) => {
          const on = (editor.style.font || undefined) === font;
          return (
            <button key={font || "default"} type="button" role="radio" aria-checked={on} className={on ? "active" : ""} onClick={() => editor.setStyle({ font })}>
              <span className={`ink-panel-font-name font-${font || "default"}`} style={{ fontFamily: inkFontFamily(font) }}>
                {font ? INK_FONT_NAMES[font] : t("Standard", "Default||font")}
              </span>
              <span className="ink-panel-font-meta">{on ? <Check size={16} weight="bold" aria-hidden="true" /> : font ? kinds[font] : "Helvetica"}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// Text: bold, italic, underline, alignment and line height of new text
// (text-style-bar.tsx has the same controls for text on the page).
function TextLookSection({ editor }: { editor: InkEditor }) {
  const t = useT();
  const id = useId();
  const s = editor.style;
  const look = { bold: !!s.bold, italic: !!s.italic, underline: !!s.underline, align: s.align || ("left" as const), lineHeight: s.lineHeight ?? LINE_HEIGHT.default };
  return (
    <section className="ink-panel-sec ink-panel-text-look" aria-labelledby={id}>
      <SectionHead id={id} label={t("Stil", "Style")} />
      <div className="ink-panel-text-toggles" role="group" aria-labelledby={id}>
        <LookToggles look={look} onChange={editor.setStyle} />
      </div>
      <AlignControls look={look} onChange={editor.setStyle} />
    </section>
  );
}

function ColorSection({ editor }: { editor: InkEditor }) {
  const t = useT();
  const id = useId();
  const color = editor.style.color;
  const custom = !editor.palette.includes(color);
  // The own colour in use, or the last one used.
  const own = custom ? color : editor.recentColors.find((c) => !editor.palette.includes(c));
  const [picker, setPicker] = useState(false);
  const plus = useRef<HTMLButtonElement>(null);
  const flyout = useRef<HTMLDivElement | null>(null);
  const [inline, setInline] = useState(false);
  // Beside the panel where there is room, otherwise in it.
  const place = useCallback((el: HTMLDivElement | null) => {
    flyout.current = el;
    if (!el) return;
    const panel = el.closest<HTMLElement>(".ink-panel");
    const box = panel?.getBoundingClientRect();
    const width = 280;
    if (!box || window.innerWidth - box.right < width + 16) {
      setInline(true);
      return;
    }
    setInline(false);
    const at = plus.current?.getBoundingClientRect();
    const height = el.offsetHeight;
    const top = Math.max(8, Math.min((at ? at.top + at.height / 2 : box.top) - 110, window.innerHeight - height - 8));
    el.style.left = `${box.right + 10}px`;
    el.style.top = `${top}px`;
    el.style.setProperty("--arrow", `${Math.max(16, Math.min(height - 16, (at ? at.top + at.height / 2 : top + 110) - top))}px`);
  }, []);
  const swatch = (c: string, label: string) => (
    <button
      key={c}
      type="button"
      role="radio"
      aria-checked={color === c}
      aria-label={label}
      title={c}
      className={`ink-swatch${color === c ? " active" : ""}`}
      style={{ "--swatch": c } as React.CSSProperties}
      onClick={() => editor.setStyle({ color: c })}
    />
  );
  return (
    <section className="ink-panel-sec" aria-labelledby={id}>
      <SectionHead id={id} label={t("Farbe", "Colour")} value={color.toUpperCase()} />
      <div className="ink-panel-swatches">
        <div role="radiogroup" aria-labelledby={id} className="ink-panel-swatches">
          {editor.palette.map((c) => swatch(c, t(`Farbe ${c}`, `Colour ${c}`)))}
          {own && <span className="ink-panel-swatch-sep" aria-hidden="true" />}
          {own && swatch(own, t(`Eigene Farbe ${own}`, `Custom colour ${own}`))}
        </div>
        <button
          ref={plus}
          type="button"
          className="ink-swatch ink-panel-rainbow"
          aria-label={t("Eigene Farbe …", "Custom colour …")}
          title={t("Eigene Farbe …", "Custom colour …")}
          aria-expanded={picker}
          aria-haspopup="dialog"
          onClick={() => setPicker((p) => !p)}
        >
          <span>
            <Plus size={10} weight="bold" />
          </span>
        </button>
      </div>
      {picker && (
        <div ref={place} className={`ink-panel-flyout${inline ? " is-inline" : ""}`} role="dialog" aria-label={t("Eigene Farbe", "Custom colour")}>
          <div className="ink-panel-flyout-head">
            <span>{t("Eigene Farbe", "Custom colour")}</span>
            <button
              type="button"
              aria-label={t("Schließen", "Close")}
              onClick={() => {
                setPicker(false);
                plus.current?.focus();
              }}
            >
              <X size={16} />
            </button>
          </div>
          <ColorPicker value={color} onChange={(c) => editor.setStyle({ color: c })} onCommit={editor.rememberCustomColor} recent={editor.recentColors} />
        </div>
      )}
    </section>
  );
}

function InputSection({ editor, folded }: { editor: InkEditor; folded: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(!folded);
  const id = useId();
  if (!open)
    return (
      <section className="ink-panel-sec ink-panel-more-sec">
        <button type="button" className="ink-panel-more" aria-expanded={false} onClick={() => setOpen(true)}>
          <span>{t("Eingabe-Einstellungen", "Input settings")}</span>
          <CaretRight size={14} aria-hidden="true" />
        </button>
      </section>
    );
  return (
    <section className="ink-panel-sec ink-panel-settings" aria-labelledby={id}>
      <SectionHead id={id} label={t("Eingabe", "Input")} />
      <SettingSwitch
        title={t("Nur mit dem Stift zeichnen", "Draw with the pen only")}
        description={t("Finger blättern und zoomen dann.", "Fingers then scroll and zoom.")}
        checked={editor.penOnly}
        onChange={editor.setPenOnly}
      />
      <SettingSwitch
        title={t("Formen beim Halten begradigen", "Straighten shapes when holding")}
        description={t(
          "Am Ende eines Strichs kurz stillhalten: Linie, Pfeil, Rechteck, Kreis, Vieleck, Stern … Weiterziehen ändert die Größe; mit dem Lasso antippen zum Bearbeiten.",
          "Hold still at the end of a stroke: line, arrow, rectangle, circle, polygon, star … Keep moving to resize; tap with the lasso to edit.",
        )}
        checked={editor.snap}
        onChange={editor.setSnap}
      />
      <div className="ink-panel-setting">
        <span className="ink-panel-setting-title" id={`${id}-pencil`}>
          {t("Apple Pencil doppelt tippen", "Apple Pencil double-tap")}
        </span>
        <span className="ink-panel-setting-desc">{t("Was Doppeltippen oder Drücken am Pencil auslöst.", "What a double-tap or squeeze on the Pencil does.")}</span>
        <select className="ink-panel-select" aria-labelledby={`${id}-pencil`} value={editor.pencil} onChange={(e) => editor.setPencil(e.target.value as PencilSetting)}>
          <option value="system">{t("Wie iPad", "As on iPad")}</option>
          <option value="eraser">{t("Radierer", "Eraser")}</option>
          <option value="previous">{t("Letztes Werkzeug", "Last tool")}</option>
          <option value="off">{t("Nichts", "Nothing")}</option>
        </select>
      </div>
    </section>
  );
}

function EraserSection({ editor, page }: { editor: InkEditor; page: string }) {
  const t = useT();
  const id = useId();
  const [confirm, setConfirm] = useState(false);
  const notes: Record<EraserMode, string> = {
    stroke: t("Ein Strich verschwindet ganz, sobald der Radierer ihn berührt.", "A stroke goes as a whole as soon as the eraser touches it."),
    partial: t("Nur was unter dem Radierer liegt, verschwindet; Striche werden geteilt.", "Only what is under the eraser goes; strokes are split."),
    highlighter: t("Entfernt nur Textmarker-Striche, die Schrift darunter bleibt.", "Removes highlighter strokes only; the writing under them stays."),
  };
  const empty = !editor.doc.pages[page]?.length;
  return (
    <>
      <section className="ink-panel-sec" aria-labelledby={id}>
        <SectionHead id={id} label={t("Radieren", "Erase")} />
        <Segmented
          label={t("Art des Radierers", "Eraser kind")}
          className="is-stacked"
          value={editor.eraserMode}
          onChange={editor.setEraserMode}
          options={[
            { value: "stroke", label: t("Ganze Striche", "Whole strokes") },
            { value: "partial", label: t("Teile", "Parts||eraser") },
            { value: "highlighter", label: t("Nur Textmarker", "Highlighter only") },
          ]}
        />
        <p className="ink-panel-note">{notes[editor.eraserMode]}</p>
      </section>
      {editor.eraserMode === "partial" && (
        <section className="ink-panel-sec" aria-labelledby={`${id}-size`}>
          <SectionHead id={`${id}-size`} label={t("Größe", "Size")} value={`${editor.eraserSize} px`} />
          <InkSlider
            label={t("Größe des Radierers", "Eraser size")}
            value={editor.eraserSize}
            min={ERASER_SIZE.min}
            max={ERASER_SIZE.max}
            linear
            ticks={[ERASER_SIZE.default]}
            valueText={`${editor.eraserSize} px`}
            onChange={(v) => editor.setEraserSize(v)}
            lo={<span className="ink-slider-ring" style={{ width: 6, height: 6 }} />}
            hi={<span className="ink-slider-ring" style={{ width: 16, height: 16 }} />}
          />
        </section>
      )}
      <section className="ink-panel-sec">
        {confirm ? (
          <div className="ink-panel-confirm" role="group" aria-label={t("Seite leeren", "Clear page")}>
            <p>{t("Alles auf dieser Seite löschen? Rückgängig bleibt möglich.", "Delete everything on this page? You can still undo it.")}</p>
            <div>
              <button type="button" className="button" autoFocus onClick={() => setConfirm(false)}>
                {t("Abbrechen", "Cancel")}
              </button>
              <button
                type="button"
                className="button danger-solid"
                onClick={() => {
                  editor.clearPage(page);
                  setConfirm(false);
                }}
              >
                {t("Seite leeren", "Clear page")}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="ink-panel-clear" disabled={empty} onClick={() => setConfirm(true)}>
            <Trash size={16} aria-hidden="true" />
            {t("Seite leeren …", "Clear page …")}
          </button>
        )}
      </section>
    </>
  );
}

function FavoritesEditor({ editor, onDone }: { editor: InkEditor; onDone: () => void }) {
  const t = useT();
  const number = useNumber();
  const list = editor.favorites;
  return (
    <section className="ink-panel-sec">
      <ul className="ink-panel-favs" aria-label={t("Lieblingsstifte", "Favourite pens")}>
        {list.map((fav, i) => {
          const label = favoriteLabel(t, fav, number);
          return (
            <li key={`${i}-${fav.type}-${fav.color}-${fav.width}-${fav.font || ""}`}>
              <span className="ink-panel-fav-chip" aria-hidden="true">
                <FavoriteMark fav={fav} />
              </span>
              <span className="ink-panel-fav-label">{label}</span>
              <button type="button" aria-label={t(`${label} nach vorne`, `Move ${label} up`)} disabled={i === 0} onClick={() => editor.moveFavorite(i, i - 1)}>
                <ArrowUp size={16} />
              </button>
              <button type="button" aria-label={t(`${label} nach hinten`, `Move ${label} down`)} disabled={i === list.length - 1} onClick={() => editor.moveFavorite(i, i + 1)}>
                <ArrowDown size={16} />
              </button>
              <button type="button" aria-label={t(`${label} entfernen`, `Remove ${label}`)} onClick={() => editor.removeFavorite(i)}>
                <Trash size={16} />
              </button>
            </li>
          );
        })}
      </ul>
      {!list.length && <p className="ink-panel-note">{t("Keine Lieblingsstifte. Mit + im Panel eines Stifts speichern.", "No favourite pens. Save one with + in a pen's panel.")}</p>}
      <div className="ink-panel-fav-done">
        <span className="ink-panel-note">{t(`Bis zu ${MAX_FAVORITES} Lieblingsstifte`, `Up to ${MAX_FAVORITES} favourite pens`)}</span>
        <button type="button" className="button" onClick={onDone}>
          {t("Fertig", "Done")}
        </button>
      </div>
    </section>
  );
}

// ---- The panel ----

export function InkPanel({ editor, page, fromGear, align, onClose }: { editor: InkEditor; page: string; fromGear: boolean; align: "start" | "end"; onClose: () => void }) {
  const t = useT();
  const tool = editor.tool;
  const styled = STYLED.includes(tool);
  // The shape tool draws with the pen's colour and width, but has no favourites.
  const shape = tool === "shape";
  const [editing, setEditing] = useState(false);
  const panel = useRef<HTMLDivElement | null>(null);
  // Placed under its button (menu-placement.ts) and again whenever its
  // content changes size (a folded section opened, the eraser kind).
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      panel.current = el;
      if (!el) return;
      placeMenu(el, align);
      el.focus({ preventScroll: true });
      const inner = el.firstElementChild;
      let frame = 0;
      const place = (event?: Event) => {
        if (event?.target instanceof Node && el.contains(event.target)) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => placeMenu(el, align));
      };
      const ro = typeof ResizeObserver !== "undefined" && inner ? new ResizeObserver(() => place()) : null;
      if (ro && inner) ro.observe(inner);
      window.addEventListener("resize", place);
      window.addEventListener("scroll", place, true);
      return () => {
        cancelAnimationFrame(frame);
        ro?.disconnect();
        window.removeEventListener("resize", place);
        window.removeEventListener("scroll", place, true);
      };
    },
    [align],
  );
  useEffect(() => setEditing(false), [tool]);
  const title = fromGear && !styled && !shape && tool !== "eraser" ? t("Stifteinstellungen", "Pen settings") : toolName(t, tool);
  return (
    <div
      ref={ref}
      className={`ink-menu ink-panel${align === "start" ? " is-start" : ""}`}
      role="dialog"
      aria-label={fromGear ? t("Stifteinstellungen", "Pen settings") : title}
      tabIndex={-1}
      data-tool={tool}
    >
      <div className="ink-panel-inner">
        <header className="ink-panel-head">
          <h3>{editing ? t("Lieblingsstifte", "Favourite pens") : title}</h3>
          {styled && !editing && (
            <div className="ink-panel-head-favs" role="group" aria-label={t("Lieblingsstifte", "Favourite pens")}>
              <FavoriteChips editor={editor} className="ink-preset" />
              <button
                type="button"
                className="ink-panel-fav-add"
                disabled={!editor.canAddFavorite}
                aria-label={t("Als Lieblingsstift speichern", "Save as favourite pen")}
                title={
                  editor.favorite >= 0
                    ? t("Schon ein Lieblingsstift", "Already a favourite pen")
                    : editor.favorites.length >= MAX_FAVORITES
                      ? t(`Höchstens ${MAX_FAVORITES} Lieblingsstifte`, `At most ${MAX_FAVORITES} favourite pens`)
                      : t("Als Lieblingsstift speichern", "Save as favourite pen")
                }
                onClick={editor.addFavorite}
              >
                <Plus size={14} weight="bold" />
              </button>
              {editor.favorites.length > 0 && (
                <button type="button" className="ink-panel-fav-edit" aria-label={t("Lieblingsstifte bearbeiten", "Edit favourite pens")} title={t("Lieblingsstifte bearbeiten", "Edit favourite pens")} onClick={() => setEditing(true)}>
                  <PencilSimpleLine size={15} />
                </button>
              )}
            </div>
          )}
          <button type="button" className="ink-panel-close" aria-label={t("Schließen", "Close")} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {editing ? (
          <FavoritesEditor editor={editor} onDone={() => setEditing(false)} />
        ) : (
          <>
            {(styled || shape) && (
              <div className="ink-panel-sec ink-panel-preview-sec">{shape ? <ShapePreview editor={editor} /> : <Preview editor={editor} />}</div>
            )}
            {shape && <ShapeKindSection />}
            {(styled || shape) && <WidthSection editor={editor} />}
            {shape && <ShapeLineSection />}
            {tool === "text" && <FontSection editor={editor} />}
            {tool === "text" && <TextLookSection editor={editor} />}
            {(styled || shape) && <ColorSection editor={editor} />}
            {shape && <ShapeFillSection editor={editor} />}
            {tool === "eraser" && <EraserSection editor={editor} page={page} />}
            {(shape || fromGear) && <RulerSection editor={editor} />}
            <InputSection key={tool} editor={editor} folded={!fromGear && (tool === "text" || tool === "eraser" || shape)} />
          </>
        )}
      </div>
    </div>
  );
}
