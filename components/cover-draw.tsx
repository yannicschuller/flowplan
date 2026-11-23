"use client";
// "Zeichnen" in the cover dialog (design review): a canvas on the cover's
// proportions with the ink tools of drawing blocks and notebooks (pens,
// colours, widths, eraser, undo), Save and Cancel. Saving draws the canvas
// into a PNG with the ink kept inside it (lib/cover-drawing.ts), which the
// cover dialog uploads like any cover image. Loaded only when opened.
import { useState } from "react";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { InkLayer } from "./ink/ink-layer";
import { InkToolbar } from "./ink/ink-toolbar";
import { useInkEditor, useInkShortcuts } from "./ink/use-ink-editor";
import { emptyInk, type InkDoc } from "@/lib/ink/model";
import { COVER_DRAWING, COVER_DRAWING_PAGE, coverSvg, pngWithInk } from "@/lib/cover-drawing";

const SIZE = { width: COVER_DRAWING.width, height: COVER_DRAWING.height };

// The drawing as a PNG with its ink inside.
async function renderCover(ink: InkDoc): Promise<Blob> {
  const svg = coverSvg(ink.pages[COVER_DRAWING_PAGE] || []);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = COVER_DRAWING.width * COVER_DRAWING.scale;
  canvas.height = COVER_DRAWING.height * COVER_DRAWING.scale;
  const context = canvas.getContext("2d");
  if (!context) throw new Error();
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error();
  const bytes = pngWithInk(new Uint8Array(await blob.arrayBuffer()), { ...ink, pages: { [COVER_DRAWING_PAGE]: ink.pages[COVER_DRAWING_PAGE] || [] } });
  return new Blob([bytes as BlobPart], { type: "image/png" });
}

export default function CoverDraw({
  initial,
  onSave,
  onClose,
}: {
  initial: InkDoc | null;
  // Uploads the PNG and makes it the cover; false keeps the dialog open.
  onSave: (png: Blob) => Promise<boolean>;
  onClose: () => void;
}) {
  const t = useT();
  const ink = useInkEditor(initial || emptyInk(), { active: true });
  useInkShortcuts(ink, true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const empty = !(ink.doc.pages[COVER_DRAWING_PAGE] || []).length;
  return (
    <Modal
      open
      wide
      className="cover-draw"
      title={initial ? t("Cover-Zeichnung bearbeiten", "Edit cover drawing") : t("Cover zeichnen", "Draw a cover")}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <InkToolbar editor={ink} label={t("Zeichenwerkzeuge", "Drawing tools")} page={COVER_DRAWING_PAGE} />
      <div className="cover-draw-surface">
        <InkLayer page={COVER_DRAWING_PAGE} size={SIZE} editor={ink} editing label={t("Cover-Zeichnung", "Cover drawing")} />
      </div>
      <p className="muted cover-draw-hint">{t("Gezeichnet wird auf weißem Grund; den Ausschnitt wählst du danach wie bei jedem Coverbild.", "You draw on white; choose the crop afterwards as for any cover image.")}</p>
      {error && (
        <p role="alert" className="math-validation">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="button" disabled={busy} onClick={onClose}>
          {t("Abbrechen", "Cancel")}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || empty}
          onClick={async () => {
            setBusy(true);
            setError("");
            let png: Blob;
            try {
              png = await renderCover(ink.doc);
            } catch {
              setError(t("Die Zeichnung konnte nicht gespeichert werden.", "The drawing could not be saved."));
              setBusy(false);
              return;
            }
            try {
              if (await onSave(png)) onClose();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t("Bitte warten …", "Please wait …") : t("Als Cover speichern", "Save as cover")}
        </button>
      </div>
    </Modal>
  );
}
