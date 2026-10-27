"use client";
// "Exportieren …": the whole board, the selection or one frame as PNG (1×,
// 2×, 4×), SVG or PDF – the PDF with the whole board on one page or one
// page per frame in presentation order (lib/whiteboard-pdf.ts).
import { useEffect, useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal } from "../ui";
import { Select } from "../select";
import { contentBounds } from "@/lib/whiteboard-geometry";
import { EXPORT_PAD, boardPdf, exportPages, frameBox, type Box, type PdfPicture } from "@/lib/whiteboard-pdf";
import { frameSequence } from "@/lib/whiteboard-frames";
import type { WhiteboardItem } from "@/lib/whiteboard-model";
import { boardSvgSource, exportFileName, rasterize, saveFile } from "./board-export";

export type ExportScope = { kind: "board" } | { kind: "selection" } | { kind: "frame"; id: string };
type Format = "png" | "svg" | "pdf";

export function ExportDialog({
  open,
  initial,
  items,
  selection,
  title,
  svg,
  onClose,
  onError,
}: {
  open: boolean;
  initial: ExportScope;
  items: WhiteboardItem[];
  selection: Set<string>;
  title: string;
  svg: () => SVGSVGElement | null;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const frames = frameSequence(items);
  const [scope, setScope] = useState<string>("board"),
    [format, setFormat] = useState<Format>("png"),
    [scale, setScale] = useState(2),
    [pdfMode, setPdfMode] = useState<"board" | "frames">("board"),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setScope(initial.kind === "frame" ? `frame:${initial.id}` : initial.kind);
    if (initial.kind !== "board") setPdfMode("board");
  }, [open, initial]);
  const map = new Map(items.map((i) => [i.id, i]));
  const scopeItems = (): { box: Box; name: string } | null => {
    if (scope.startsWith("frame:")) {
      const frame = map.get(scope.slice(6));
      return frame ? { box: frameBox(frame), name: frame.text || t("Rahmen", "Frame") } : null;
    }
    const list = scope === "selection" ? items.filter((i) => selection.has(i.id)) : items.filter((i) => i.type !== "comment");
    const box = contentBounds(list, map);
    return box
      ? { box: { x: box.x - EXPORT_PAD, y: box.y - EXPORT_PAD, w: box.w + EXPORT_PAD * 2, h: box.h + EXPORT_PAD * 2 }, name: title }
      : null;
  };
  async function run() {
    const node = svg();
    if (!node) return;
    setBusy(true);
    try {
      if (format === "pdf") {
        const pages =
          scope === "board"
            ? exportPages(items, pdfMode, title)
            : (() => {
                const one = scopeItems();
                return one ? [{ box: one.box, title: one.name }] : [];
              })();
        if (!pages.length) throw new Error(pdfMode === "frames" ? t("Auf diesem Board gibt es keine Rahmen für die Präsentation.", "This board has no frames for the presentation.") : t("Das Whiteboard ist leer.", "The whiteboard is empty."));
        const pictures: PdfPicture[] = [];
        for (const page of pages) {
          const { blob } = await rasterize(await boardSvgSource(node, page.box), page.box, 2);
          pictures.push({ png: new Uint8Array(await blob.arrayBuffer()), width: page.box.w, height: page.box.h, title: page.title });
        }
        const bytes = await boardPdf(pictures, title);
        saveFile(new Blob([bytes as BlobPart], { type: "application/pdf" }), exportFileName(title, "pdf"));
      } else {
        const target = scopeItems();
        if (!target) throw new Error(t("Das Whiteboard ist leer.", "The whiteboard is empty."));
        const source = await boardSvgSource(node, target.box, { inline: format === "png" });
        if (format === "svg") saveFile(new Blob([source], { type: "image/svg+xml" }), exportFileName(target.name, "svg"));
        else {
          const { blob } = await rasterize(source, target.box, scale);
          saveFile(blob, exportFileName(target.name, "png"));
        }
      }
      onClose();
    } catch (e) {
      const message = (e as Error).message;
      onError(message === "render" ? t("Der Browser konnte das Bild nicht erzeugen. Bitte SVG verwenden.", "The browser could not create the picture. Please use SVG.") : message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={t("Exportieren", "Export")} sheet className="wb-export-dialog">
      <div className="wb-export-form">
        <label>
          {t("Was", "What")}
          <Select value={scope} onChange={(e) => setScope(e.target.value)} aria-label={t("Was exportieren", "What to export")}>
            <option value="board">{t("Ganzes Board", "Whole board")}</option>
            {selection.size > 0 && <option value="selection">{t("Auswahl", "Selection")}</option>}
            {frames.map((f) => (
              <option key={f.id} value={`frame:${f.id}`}>
                {t("Rahmen", "Frame")}: {f.text || t("Ohne Titel", "Untitled")}
              </option>
            ))}
          </Select>
        </label>
        <div className="wb-export-formats" role="radiogroup" aria-label={t("Format", "Format")}>
          {(["png", "svg", "pdf"] as const).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={format === f} className={format === f ? "active" : ""} onClick={() => setFormat(f)}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
        {format === "png" && (
          <div className="wb-export-formats" role="radiogroup" aria-label={t("Auflösung", "Resolution")}>
            {[1, 2, 4].map((s) => (
              <button key={s} type="button" role="radio" aria-checked={scale === s} className={scale === s ? "active" : ""} onClick={() => setScale(s)}>
                {s}×
              </button>
            ))}
          </div>
        )}
        {format === "pdf" && scope === "board" && (
          <div className="wb-export-formats" role="radiogroup" aria-label={t("Seiten", "Pages")}>
            <button type="button" role="radio" aria-checked={pdfMode === "board"} className={pdfMode === "board" ? "active" : ""} onClick={() => setPdfMode("board")}>
              {t("Alles auf einer Seite", "Everything on one page")}
            </button>
            <button type="button" role="radio" aria-checked={pdfMode === "frames"} className={pdfMode === "frames" ? "active" : ""} onClick={() => setPdfMode("frames")}>
              {t("Eine Seite pro Rahmen", "One page per frame")}
            </button>
          </div>
        )}
        <p className="muted">
          {format === "pdf"
            ? t("Rahmen kommen in der Reihenfolge der Präsentation; ausgeblendete Rahmen fehlen.", "Frames follow the presentation order; hidden frames are left out.")
            : format === "png"
              ? t("Höhere Auflösung für Druck und große Bildschirme.", "Higher resolution for print and large screens.")
              : t("Vektorgrafik, beliebig skalierbar.", "Vector graphic, scales to any size.")}
        </p>
        <button type="button" className="button primary" disabled={busy} onClick={() => void run()}>
          <DownloadSimple size={16} /> {busy ? t("Wird erstellt …", "Creating …") : t("Exportieren", "Export")}
        </button>
      </div>
    </Modal>
  );
}
