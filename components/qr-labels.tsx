"use client";
// "QR-Etiketten drucken" (#448): a sheet of labels for the selected records
// of a database, or else the records of the current view (its filters, its
// order). Each label holds the QR code of the record's address
// (lib/qr-labels.ts: itemLink) with the title and up to two properties; a
// preset or a custom label sheet, a start place on a partly used sheet, a
// live preview of the first sheet, then the browser's print dialog through
// printPage – sizes in millimetres from a generated style sheet (numbers
// only), never style attributes. Loaded on first use.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Printer } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { Select } from "./select";
import { printPage } from "./print-page";
import { cellText } from "@/lib/cell-text";
import { clipboardCell, type ClipboardContext } from "@/lib/database-clipboard";
import { isFormattedText } from "@/lib/inline-markdown";
import { QR_MAX_BYTES, qrBytes, qrFits, qrModules, qrPath, QR_QUIET_ZONE } from "@/lib/qr";
import {
  LABEL_LIMITS,
  LABEL_PRESETS,
  MAX_LABELS,
  MIN_CODE_MM,
  PAPER_SIZE,
  clampSkip,
  itemLink,
  labelBox,
  labelSheetCss,
  labelSheets,
  labelsPerSheet,
  layoutProblem,
  presetLayout,
  type LabelLayout,
  type LabelText,
  type Paper,
} from "@/lib/qr-labels";
import type { Field, Row } from "@/lib/types";
import "@/app/qr-labels.css";

type Settings = {
  preset: string;
  custom: LabelLayout;
  placement: LabelText;
  title: boolean;
  fields: [string, string];
  names: boolean;
};
const DEFAULTS: Settings = {
  preset: LABEL_PRESETS[0].id,
  custom: LABEL_PRESETS[0].layout,
  placement: "beside",
  title: true,
  fields: ["", ""],
  names: false,
};
// The last choice per database stays in this browser (a convenience only).
const storeKey = (pageId: string) => `flowplan.qr-labels.${pageId}`;
function loadSettings(pageId: string): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey(pageId)) || "null") as Partial<Settings> | null;
    if (!saved || typeof saved !== "object") return DEFAULTS;
    const custom = { ...DEFAULTS.custom, ...(saved.custom || {}) };
    return {
      preset: saved.preset === "custom" || presetLayout(String(saved.preset)) ? String(saved.preset) : DEFAULTS.preset,
      custom: layoutProblem(custom) ? DEFAULTS.custom : custom,
      placement: saved.placement === "below" ? "below" : "beside",
      title: saved.title !== false,
      fields: Array.isArray(saved.fields) ? [String(saved.fields[0] || ""), String(saved.fields[1] || "")] : DEFAULTS.fields,
      names: saved.names === true,
    };
  } catch {
    return DEFAULTS;
  }
}
function saveSettings(pageId: string, settings: Settings) {
  try {
    localStorage.setItem(storeKey(pageId), JSON.stringify(settings));
  } catch {}
}

type Label = { id: string; url: string; title: string; details: string[] };

export default function QrLabelsDialog({
  pageId,
  rows,
  fields,
  context,
  selection,
  viewName,
  onClose,
}: {
  pageId: string;
  // The records in the order of the view (only those the person sees).
  rows: Row[];
  fields: Field[];
  context: ClipboardContext;
  // The records are the selection, not the whole view.
  selection: boolean;
  viewName: string;
  onClose: () => void;
}) {
  const t = useT();
  const ids = useId();
  const [settings, setSettings] = useState<Settings>(() => loadSettings(pageId));
  const [skip, setSkip] = useState(0);
  const [printing, setPrinting] = useState(false);
  const printRoot = useRef<HTMLDivElement>(null);
  useEffect(() => saveSettings(pageId, settings), [pageId, settings]);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((s) => ({ ...s, [key]: value }));
  const layout = settings.preset === "custom" ? settings.custom : presetLayout(settings.preset) || DEFAULTS.custom;
  const problem = layoutProblem(layout);
  const titleField = fields[0];
  const choosable = fields.filter((f) => f.id !== titleField?.id);
  const chosen = settings.fields.map((id) => choosable.find((f) => f.id === id)).filter((f): f is Field => !!f);
  const lines = (settings.title ? 1 : 0) + chosen.length;
  const base = typeof location === "undefined" ? "" : `${location.origin}${location.pathname}`;
  // The addresses depend on the records alone; the texts also on the choice.
  const rowKey = rows
    .slice(0, MAX_LABELS)
    .map((row) => row.id)
    .join(",");
  const urls = useMemo(() => (rowKey ? rowKey.split(",") : []).map((rowId) => itemLink(base, { pageId, rowId })), [rowKey, base, pageId]);
  const labels: Label[] = rows.slice(0, MAX_LABELS).map((row, i) => ({
    id: row.id,
    url: urls[i],
    title: (titleField && cellText(row.cells[titleField.id]).trim()) || context.untitled,
    details: chosen.map((f) => {
      const value = clipboardCell(f, row.cells[f.id], context, isFormattedText(f, fields)).replace(/\s+/g, " ").trim();
      return value && settings.names ? `${f.name}: ${value}` : value;
    }),
  }));
  const per = labelsPerSheet(layout);
  const start = clampSkip(layout, skip);
  const sheets = problem ? [] : labelSheets(layout, labels.length, start);
  const box = labelBox(layout, settings.placement, lines);
  const tooLong = urls.find((url) => !qrFits(url));
  const ready = !problem && !tooLong && labels.length > 0;
  // The codes, one per record: the first sheet's for the preview, all of
  // them for printing.
  const paths = useMemo(() => {
    const result = new Map<string, { d: string; side: number }>();
    if (tooLong) return result;
    for (const url of urls.slice(0, printing ? urls.length : per)) {
      try {
        const modules = qrModules(url);
        result.set(url, { d: qrPath(modules), side: modules.length + 2 * QR_QUIET_ZONE });
      } catch {}
    }
    return result;
  }, [urls, printing, per, tooLong]);
  // The print copy exists only while printing (its style sheet sets the
  // paper for the whole document); printPage copies it a moment later.
  useEffect(() => {
    if (!printing || !printRoot.current) return;
    printPage(printRoot.current);
    const done = setTimeout(() => setPrinting(false), 2000);
    return () => clearTimeout(done);
  }, [printing]);

  const sheet = (places: ReturnType<typeof labelSheets>[number], index: number, preview: boolean) => (
    <div className="qrl-page" key={index}>
      {preview &&
        Array.from({ length: per }, (_, slot) => <div key={`e${slot}`} className={`qrl-label qrl-empty qrl-s${slot}${slot < start && index === 0 ? " qrl-skipped" : ""}`} aria-hidden />)}
      {places.map((place) => {
        const label = labels[place.record];
        const code = paths.get(label.url);
        return (
          <div key={label.id} className={`qrl-label qrl-s${place.slot}`}>
            {code && (
              <svg className="qrl-code" viewBox={`${-QR_QUIET_ZONE} ${-QR_QUIET_ZONE} ${code.side} ${code.side}`} shapeRendering="crispEdges" aria-hidden>
                <rect x={-QR_QUIET_ZONE} y={-QR_QUIET_ZONE} width={code.side} height={code.side} fill="#fff" />
                <path d={code.d} fill="#000" />
              </svg>
            )}
            {lines > 0 && (
              <div className="qrl-text">
                {settings.title && <div className="qrl-title">{label.title}</div>}
                {label.details.map((text, i) => (
                  <div className="qrl-detail" key={i}>
                    {text}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const number = (key: keyof typeof LABEL_LIMITS, label: string, step = 0.1) => (
    <label className="print-field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        min={LABEL_LIMITS[key][0]}
        max={LABEL_LIMITS[key][1]}
        step={key === "columns" || key === "rows" ? 1 : step}
        value={Number.isFinite(settings.custom[key]) ? settings.custom[key] : ""}
        onChange={(e) => set("custom", { ...settings.custom, [key]: e.target.value === "" ? NaN : Number(e.target.value) })}
      />
    </label>
  );
  const problemText = !problem
    ? ""
    : problem.kind === "width"
      ? t("Die Etiketten passen nicht in die Breite des Papiers.", "The labels do not fit the width of the paper.")
      : problem.kind === "height"
        ? t("Die Etiketten passen nicht in die Höhe des Papiers.", "The labels do not fit the height of the paper.")
        : t(
            `Ein Wert liegt außerhalb des Erlaubten (${LABEL_LIMITS[problem.key][0]}–${LABEL_LIMITS[problem.key][1]}).`,
            `A value is out of range (${LABEL_LIMITS[problem.key][0]}–${LABEL_LIMITS[problem.key][1]}).`,
          );
  const count = Math.min(labels.length, MAX_LABELS);
  const css = problem ? "" : labelSheetCss(layout, settings.placement, lines, false);
  return (
    <Modal open onClose={onClose} wide title={t("QR-Etiketten drucken", "Print QR labels")} className="qr-labels-dialog">
      <p className="print-note muted">
        {selection
          ? t(`Für die ${rows.length} ausgewählten Einträge.`, `For the ${rows.length} selected records.`)
          : t(`Für die ${rows.length} Einträge der Ansicht „${viewName}“ – mit ihren Filtern, in ihrer Reihenfolge.`, `For the ${rows.length} records of the view “${viewName}” – with its filters, in its order.`)}{" "}
        {t(
          "Gescannt öffnet ein Code seinen Eintrag für alle, die angemeldet sind und ihn sehen dürfen.",
          "Scanned, a code opens its record for everyone who is signed in and may see it.",
        )}
      </p>
      <div className="qr-labels-layout">
        <div className="qr-labels-form">
          <div className="print-fields">
            <label className="print-field qr-labels-wide">
              <span>{t("Etikettenbogen", "Label sheet")}</span>
              <Select value={settings.preset} onChange={(e) => set("preset", e.target.value)}>
                {LABEL_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                <option value="custom">{t("Eigene Größe …", "Custom size …")}</option>
              </Select>
            </label>
          </div>
          {settings.preset === "custom" && (
            <fieldset className="qr-labels-custom">
              <legend>{t("Eigene Größe (mm)", "Custom size (mm)")}</legend>
              <div className="print-fields">
                <label className="print-field">
                  <span>{t("Papier", "Paper")}</span>
                  <Select value={settings.custom.paper} onChange={(e) => set("custom", { ...settings.custom, paper: e.target.value as Paper })}>
                    {(Object.keys(PAPER_SIZE) as Paper[]).map((paper) => (
                      <option key={paper} value={paper}>
                        {paper === "a4" ? "A4" : "US Letter"}
                      </option>
                    ))}
                  </Select>
                </label>
                <span aria-hidden />
                {number("columns", t("Spalten", "Columns"))}
                {number("rows", t("Zeilen", "Rows"))}
                {number("width", t("Breite eines Etiketts", "Label width"))}
                {number("height", t("Höhe eines Etiketts", "Label height"))}
                {number("marginTop", t("Rand oben", "Top margin"))}
                {number("marginLeft", t("Rand links", "Left margin"))}
                {number("gapX", t("Abstand waagerecht", "Horizontal gap"))}
                {number("gapY", t("Abstand senkrecht", "Vertical gap"))}
              </div>
            </fieldset>
          )}
          <div className="segmented qr-labels-placement" role="radiogroup" aria-label={t("Text", "Text")}>
            {(["beside", "below"] as const).map((placement) => (
              <label key={placement} data-active={settings.placement === placement}>
                <input type="radio" name={`${ids}-placement`} checked={settings.placement === placement} onChange={() => set("placement", placement)} />
                {placement === "beside" ? t("Text neben dem Code", "Text beside the code") : t("Text unter dem Code", "Text below the code")}
              </label>
            ))}
          </div>
          <div className="print-fields">
            <label className="checkbox-label print-check qr-labels-wide">
              <input type="checkbox" checked={settings.title} onChange={(e) => set("title", e.target.checked)} />
              <span>{t("Titel", "Title")}</span>
            </label>
            {[0, 1].map((i) => (
              <label className="print-field" key={i}>
                <span>{i === 0 ? t("Eigenschaft 1", "Property 1") : t("Eigenschaft 2", "Property 2")}</span>
                <Select
                  value={settings.fields[i]}
                  onChange={(e) => {
                    const next: [string, string] = [...settings.fields];
                    next[i] = e.target.value;
                    set("fields", next);
                  }}
                >
                  <option value="">{t("Keine", "None")}</option>
                  {choosable.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
            <label className="checkbox-label print-check qr-labels-wide">
              <input type="checkbox" checked={settings.names} disabled={!chosen.length} onChange={(e) => set("names", e.target.checked)} />
              <span>{t("Mit dem Namen der Eigenschaft", "With the property's name")}</span>
            </label>
            <label className="print-field qr-labels-wide">
              <span>{t("Erste Plätze auf dem Bogen frei lassen (angefangener Bogen)", "Leave the first places on the sheet empty (partly used sheet)")}</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={Math.max(0, per - 1)}
                step={1}
                value={skip}
                onChange={(e) => setSkip(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              />
            </label>
          </div>
        </div>
        <div className="qr-labels-preview" aria-label={t("Vorschau des ersten Bogens", "Preview of the first sheet")} role="img">
          {css && <style>{css}</style>}
          {sheets[0] && <div className="qrl-root">{sheet(sheets[0], 0, true)}</div>}
        </div>
      </div>
      <div className="qr-labels-status" role="status">
        {problem ? (
          <p className="print-problem">{problemText}</p>
        ) : tooLong ? (
          <p className="print-problem">
            {t(
              `Die Adresse eines Eintrags ist zu lang für einen QR-Code: ${qrBytes(tooLong)} Zeichen, ein Code fasst höchstens ${QR_MAX_BYTES}. Eine kürzere Adresse der Instanz (APP_URL) hilft.`,
              `A record's address is too long for a QR code: ${qrBytes(tooLong)} characters, a code holds at most ${QR_MAX_BYTES}. A shorter address of the instance (APP_URL) helps.`,
            )}
          </p>
        ) : !labels.length ? (
          <p className="print-problem">{t("Keine Einträge für Etiketten.", "No records for labels.")}</p>
        ) : (
          <p className="print-note">
            {count === 1
              ? t("1 Etikett auf 1 Bogen", "1 label on 1 sheet")
              : sheets.length === 1
                ? t(`${count} Etiketten auf 1 Bogen`, `${count} labels on 1 sheet`)
                : t(`${count} Etiketten auf ${sheets.length} Bögen`, `${count} labels on ${sheets.length} sheets`)}
          </p>
        )}
        {rows.length > MAX_LABELS && (
          <p className="print-problem">
            {t(
              `Höchstens ${MAX_LABELS} Etiketten auf einmal: gedruckt werden die ersten ${MAX_LABELS} von ${rows.length}. Wähle weniger Einträge aus oder filtere die Ansicht.`,
              `At most ${MAX_LABELS} labels at once: the first ${MAX_LABELS} of ${rows.length} are printed. Select fewer records or filter the view.`,
            )}
          </p>
        )}
        {!problem && box.code < MIN_CODE_MM && (
          <p className="print-problem">
            {t(
              `Der Code wird nur ${box.code.toLocaleString()} mm groß – kleiner als ${MIN_CODE_MM} mm lesen ihn viele Kameras schlecht.`,
              `The code is only ${box.code.toLocaleString()} mm wide – below ${MIN_CODE_MM} mm many cameras read it poorly.`,
            )}
          </p>
        )}
      </div>
      <p className="print-note muted">
        {t(
          "Im Druckdialog „Tatsächliche Größe“ (100 %) wählen und Kopf- und Fußzeilen ausschalten, damit die Etiketten genau sitzen.",
          "In the print dialog choose “Actual size” (100 %) and turn headers and footers off so the labels line up exactly.",
        )}
      </p>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          {t("Abbrechen", "Cancel")}
        </button>
        <button type="button" className="button primary" disabled={!ready || printing} onClick={() => setPrinting(true)}>
          <Printer aria-hidden /> {t("Drucken", "Print")}
        </button>
      </div>
      {printing && ready && (
        <div className="qr-labels-print-source" aria-hidden>
          <div className="qrl-root" ref={printRoot}>
            <style>{labelSheetCss(layout, settings.placement, lines, true)}</style>
            {sheets.map((places, i) => sheet(places, i, false))}
          </div>
        </div>
      )}
    </Modal>
  );
}
