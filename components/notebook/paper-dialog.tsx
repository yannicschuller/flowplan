"use client";
// The paper of a notebook sheet (components/notebook/notebook-view.tsx):
// template, size, orientation and colour, for this sheet, as the notebook's
// default or for all sheets. From 800 px on a live preview of the sheet sits
// on the left (real orientation and paper colour); below that one column,
// on phones a bottom sheet with the templates as a strip. Only the body
// scrolls; the buttons stay at the bottom edge. Native radio inputs
// throughout (one tab stop per group, arrow keys, VoiceOver). Below the
// built-in templates the workspace's own ones ("Eigene", "Vorlage
// hinzufügen …", components/notebook/custom-paper.tsx); choosing a built-in
// one clears an own template.
import { useEffect, useId, useState } from "react";
import { Check } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal } from "../ui";
import { PaperSvg } from "./paper";
import { CustomPaperSection, PaperImageLayer } from "./custom-paper";
import type { TemplateEntry } from "./notebook-media";
import { PAPER_COLORS, PAPER_ORIENTATIONS, PAPER_SIZES, PAPER_TEMPLATES, paperLayout, paperSize, type Paper } from "@/lib/notebook-paper";
import type { PaperThumb } from "@/lib/notebook-paper-thumb";

export type PaperScope = "sheet" | "new" | "all";

// Tiles: the top left part, lines at least a pixel wide; the preview: all
// of it, lines at least 0.75 px.
const TILE: PaperThumb = { px: 46, minStroke: 1, crop: 0.55 };
const PREVIEW: PaperThumb = { px: 210, minStroke: 0.75 };

function Choice<V extends string>({ name, value, chosen, onChange, children }: { name: string; value: V; chosen: V; onChange: (v: V) => void; children: React.ReactNode }) {
  return (
    <label data-active={chosen === value}>
      <input type="radio" name={name} checked={chosen === value} onChange={() => onChange(value)} />
      {children}
    </label>
  );
}

export function PaperDialog({
  open,
  sheetNumber,
  sheetCount = 1,
  paper,
  onApply,
  onClose,
  templateName,
  pageId,
  onError,
}: {
  open: boolean;
  sheetNumber: number;
  // Several sheets chosen in the page overview: "These 3 sheets".
  sheetCount?: number;
  // The sheet's (the first chosen sheet's) paper as it is now (its own choices over the notebook's).
  paper: Paper;
  onApply: (draft: Paper, scope: PaperScope) => void;
  onClose: () => void;
  templateName: (template: Paper["template"]) => string;
  // The notebook page (own templates of its workspace); without it no "Eigene".
  pageId?: string;
  onError?: (message: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Paper>(paper);
  const [scope, setScope] = useState<PaperScope>("sheet");
  // The own template chosen in this dialog (its picture for the preview).
  const [own, setOwn] = useState<TemplateEntry | null>(null);
  const noteId = useId();
  useEffect(() => {
    if (!open) return;
    setDraft(paper);
    setOwn(null);
    setScope("sheet");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const size = paperSize(draft);
  const ownChosen = own && draft.image?.template === own.id ? own : null;
  const ownName = draft.image ? ownChosen?.name || draft.image.name || t("Eigene Vorlage", "Own template") : null;
  const scopes: { value: PaperScope; short: string; long: string; note: string }[] = [
    {
      value: "sheet",
      ...(sheetCount > 1
        ? {
            short: t("Diese Blätter", "These sheets"),
            long: t(`Die ${sheetCount} ausgewählten Blätter`, `The ${sheetCount} selected sheets`),
            note: t(`Nur die ${sheetCount} ausgewählten Blätter bekommen dieses Papier (PDF-Seiten bleiben). Andere Blätter bleiben, wie sie sind.`, `Only the ${sheetCount} selected sheets get this paper (PDF pages stay). Other sheets stay as they are.`),
          }
        : {
            short: t("Dieses Blatt", "This sheet"),
            long: t("Dieses Blatt", "This sheet"),
            note: t(`Nur Blatt ${sheetNumber} bekommt dieses Papier. Andere Blätter bleiben, wie sie sind.`, `Only sheet ${sheetNumber} gets this paper. Other sheets stay as they are.`),
          }),
    },
    {
      value: "new",
      short: t("Standard", "Default||paper scope"),
      long: t("Standard des Notizbuchs", "Notebook default"),
      note: t("Für neue Blätter und alle Blätter ohne eigenes Papier.", "For new sheets and all sheets without their own paper."),
    },
    {
      value: "all",
      short: t("Alle Blätter", "All sheets"),
      long: t("Alle Blätter", "All sheets"),
      note: t("Wird Standard und ersetzt eigenes Papier aller Blätter (PDF-Seiten bleiben).", "Becomes the default and replaces the own paper of all sheets (PDF pages stay)."),
    },
  ];
  const orientationName = (o: Paper["orientation"]) => (o === "portrait" ? t("Hochformat", "Portrait") : t("Querformat", "Landscape"));
  const colorName = (c: Paper["color"]) => (c === "light" ? t("Hell", "Light") : t("Dunkel", "Dark"));
  return (
    <Modal open={open} onClose={onClose} title={t("Papier", "Paper")} subtitle={sheetCount > 1 ? t(`${sheetCount} Blätter`, `${sheetCount} sheets`) : t(`Blatt ${sheetNumber}`, `Sheet ${sheetNumber}`)} className="notebook-paper-dialog" sheet>
      <div className="paper-dialog-body">
        <figure className="paper-dialog-preview" aria-hidden="true">
          <span className={`paper-dialog-sheet${draft.color === "dark" ? " is-dark" : ""}`} style={{ aspectRatio: `${size.width} / ${size.height}` }}>
            {draft.image ? (
              <PaperImageLayer image={{ ...draft.image, ...(ownChosen ? { kind: ownChosen.kind, width: ownChosen.width, height: ownChosen.height } : {}) }} src={ownChosen?.url} size={size} width={210} eager />
            ) : (
              <PaperSvg layout={paperLayout(draft)} thumb={PREVIEW} />
            )}
          </span>
          <figcaption>
            <b>{ownName ?? templateName(draft.template)}</b>
            {[draft.size === "a4" ? "A4" : "Letter", orientationName(draft.orientation), colorName(draft.color)].join(" · ")}
          </figcaption>
        </figure>
        <div className="paper-dialog-main">
          <fieldset className="paper-dialog-section">
            <legend>{t("Vorlage", "Template")}</legend>
            <div className="paper-dialog-templates">
              {PAPER_TEMPLATES.map((template) => (
                <label key={template} className={!draft.image && draft.template === template ? "chosen" : ""}>
                  <input type="radio" name="notebook-template" checked={!draft.image && draft.template === template} onChange={() => setDraft({ ...draft, template, image: null })} />
                  <span className={`paper-dialog-tile${draft.color === "dark" ? " is-dark" : ""}`}>
                    <PaperSvg layout={paperLayout({ ...draft, template, orientation: "portrait" })} thumb={TILE} />
                  </span>
                  <span className="paper-dialog-tile-name">{templateName(template)}</span>
                  <span className="paper-dialog-check" aria-hidden="true">
                    <Check size={11} weight="bold" />
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {pageId && (
            <CustomPaperSection
              pageId={pageId}
              draft={draft}
              onChoose={(image, entry) => {
                setDraft({ ...draft, image });
                setOwn(entry ?? null);
              }}
              onError={onError || (() => {})}
            />
          )}
          <div className="paper-dialog-section">
            <h3 className="paper-dialog-legend">{t("Blatt", "Sheet")}</h3>
            <div className="paper-dialog-group">
              <div className="paper-dialog-row">
                <span className="paper-dialog-row-label">{t("Format", "Size||paper")}</span>
                <div className="segmented" role="radiogroup" aria-label={t("Format", "Size||paper")}>
                  {PAPER_SIZES.map((v) => (
                    <Choice key={v} name="notebook-size" value={v} chosen={draft.size} onChange={(size) => setDraft({ ...draft, size })}>
                      {v === "a4" ? "A4" : "Letter"}
                    </Choice>
                  ))}
                </div>
              </div>
              <div className="paper-dialog-row">
                <span className="paper-dialog-row-label">{t("Ausrichtung", "Orientation")}</span>
                <div className="segmented" role="radiogroup" aria-label={t("Ausrichtung", "Orientation")}>
                  {PAPER_ORIENTATIONS.map((v) => (
                    <Choice key={v} name="notebook-orientation" value={v} chosen={draft.orientation} onChange={(orientation) => setDraft({ ...draft, orientation })}>
                      <span className={`paper-dialog-ori is-${v}`} aria-hidden="true" />
                      {orientationName(v)}
                    </Choice>
                  ))}
                </div>
              </div>
              <div className="paper-dialog-row">
                <span className="paper-dialog-row-label">{t("Papierfarbe", "Paper colour")}</span>
                <div className="segmented" role="radiogroup" aria-label={t("Papierfarbe", "Paper colour")}>
                  {PAPER_COLORS.map((v) => (
                    <Choice key={v} name="notebook-color" value={v} chosen={draft.color} onChange={(color) => setDraft({ ...draft, color })}>
                      <span className={`paper-dialog-dot is-${v}`} aria-hidden="true" />
                      {colorName(v)}
                    </Choice>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <fieldset className="paper-dialog-section" aria-describedby={noteId}>
            <legend>{t("Anwenden auf", "Apply to")}</legend>
            <div className="paper-dialog-scopes">
              {scopes.map((s) => (
                <label key={s.value} data-active={scope === s.value}>
                  <input type="radio" name="notebook-scope" checked={scope === s.value} onChange={() => setScope(s.value)} />
                  <span className="paper-dialog-scope-short">{s.short}</span>
                  <span className="paper-dialog-scope-long">{s.long}</span>
                  <span className="paper-dialog-scope-note">{s.note}</span>
                </label>
              ))}
            </div>
            <p id={noteId} className="paper-dialog-note">
              {scopes.find((s) => s.value === scope)!.note}
            </p>
          </fieldset>
        </div>
      </div>
      <div className="paper-dialog-foot">
        <button type="button" className="button" onClick={onClose}>
          {t("Abbrechen", "Cancel")}
        </button>
        <button type="button" className="button primary" onClick={() => onApply(draft, scope)}>
          {t("Übernehmen", "Apply")}
        </button>
      </div>
    </Modal>
  );
}
