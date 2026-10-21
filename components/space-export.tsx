"use client";
// A whole space as one file: a Markdown ZIP (#33) with every top-level page
// in a folder of its own, a print view for a PDF, or an e-book – with what
// the person may read. From the space's row in the sidebar and from
// Settings → Data.
import { useState } from "react";
import { serverMessage } from "@/lib/i18n-errors";
import { flushOpenDocuments } from "@/lib/document-flush";
import { exportName } from "@/lib/export-name";
import { useT } from "./i18n";
import { Select } from "./select";
import { downloadBlob, Modal } from "./ui";
import { downloadExport, epubUrl, pdfUrl, printExport } from "./export-download";

type SpaceChoice = { id: string; name: string };

export function SpaceExportDialog({ spaces, initial, onClose }: { spaces: SpaceChoice[]; initial?: string; onClose: () => void }) {
  const t = useT();
  const [spaceId, setSpaceId] = useState(initial || spaces[0]?.id || "");
  const [format, setFormat] = useState("zip");
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const space = spaces.find((s) => s.id === spaceId);
  async function download() {
    if (!space) return;
    setBusy(true);
    setError("");
    try {
      await flushOpenDocuments();
      if (format === "pdf") {
        await printExport(pdfUrl({ spaceId }));
        onClose();
        return;
      }
      if (format === "epub") {
        await downloadExport(epubUrl({ spaceId }), `${exportName(space.name)}.epub`);
        onClose();
        return;
      }
      const response = await fetch("/api/markdown-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spaceId, format: "zip", history }),
      });
      if (!response.ok) throw new Error(serverMessage((await response.json().catch(() => ({}))).error) || t("Export fehlgeschlagen.", "Export failed."));
      downloadBlob(`${exportName(space.name)}.zip`, await response.blob());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Export fehlgeschlagen.", "Export failed."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open title={t("Bereich exportieren", "Export space")} onClose={() => !busy && onClose()}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void download();
        }}
      >
        {spaces.length > 1 && (
          <label>
            {t("Bereich", "Space")}
            <Select aria-label={t("Bereich", "Space")} value={spaceId} disabled={busy} onChange={(event) => setSpaceId(event.target.value)}>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label>
          {t("Format", "Format")}
          <Select aria-label={t("Exportformat", "Export format")} value={format} disabled={busy} onChange={(event) => setFormat(event.target.value)}>
            <option value="zip">{t("Bereich als Markdown (.zip)", "Space as Markdown (.zip)")}</option>
            <option value="pdf">{t("Bereich als PDF", "Space as PDF")}</option>
            <option value="epub">{t("Bereich als E-Book (EPUB)", "Space as e-book (EPUB)")}</option>
          </Select>
        </label>
        {format === "zip" && (
          <label className="export-children">
            <input type="checkbox" checked={history} disabled={busy} onChange={(event) => setHistory(event.target.checked)} />
            {t("Kommentare und frühere Versionen einschließen", "Include comments and earlier versions")}
          </label>
        )}
        <p className="muted">
          {format === "zip"
            ? t(
                "Ein ZIP mit allen Seiten und Datenbanken des Bereichs, die du lesen darfst – jede Seite der obersten Ebene in einem eigenen Ordner, mit Anhängen und relativen Links. Private Einträge und Journale mit PIN anderer bleiben draußen.",
                "One ZIP with all pages and databases of the space you may read – every top-level page in a folder of its own, with attachments and relative links. Other people's private records and PIN-locked journals stay out.",
              )
            : format === "pdf"
              ? t(
                  "Eine Druckansicht mit Deckblatt, Inhaltsverzeichnis und jeder Seite des Bereichs als Kapitel, die der Druckdialog als PDF sichert. Enthalten ist, was du lesen darfst – höchstens 200 Seiten.",
                  "A print view with a cover, a table of contents and every page of the space as a chapter, which the print dialog saves as PDF. It holds what you may read – at most 200 pages.",
                )
              : t(
                  "Ein E-Book mit jeder Seite des Bereichs als Kapitel, Bildern und Inhaltsverzeichnis. Enthalten ist, was du lesen darfst – höchstens 200 Seiten.",
                  "An e-book with every page of the space as a chapter, pictures and a table of contents. It holds what you may read – at most 200 pages.",
                )}
        </p>
        {space && format === "zip" && (
          <p className="muted small">
            {t("Für Skripte mit einem Lese-Token:", "For scripts with a read token:")} <code>{`{"spaceId":"${space.id}","format":"zip"}`}</code>
          </p>
        )}
        {space && format !== "zip" && (
          <p className="muted small">
            {t("Für Skripte mit einem Lese-Token:", "For scripts with a read token:")} <code>{`GET /api/export/${format}?space=${space.id}`}</code>
          </p>
        )}
        {error && (
          <p role="alert" className="math-validation">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={busy || !space}>
            {busy
              ? format === "pdf"
                ? t("Druckansicht wird vorbereitet …", "Preparing the print view …")
                : t("Export wird erstellt …", "Creating export …")
              : format === "pdf"
                ? t("Drucken / PDF", "Print / PDF")
                : t("Herunterladen", "Download")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
