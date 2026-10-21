"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { Select } from "./select";
import { useState } from "react";
import { downloadBlob, Modal } from "./ui";
import { flushOpenDocuments } from "@/lib/document-flush";
import { exportName } from "@/lib/export-name";
import { docxUrl, downloadExport, epubUrl, pdfUrl, printExport } from "./export-download";
export function PageExportDialog({
  page,
  onClose,
  onLegacy,
}: {
  page: { id: string; title: string; kind: string };
  onClose: () => void;
  onLegacy: () => void;
}) {
  const t = useT();
  const [format, setFormat] = useState("markdown"),
    [children, setChildren] = useState(false),
    [treeChildren, setTreeChildren] = useState(true),
    [history, setHistory] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const tree = format === "pdf" || format === "epub";
  async function download() {
    setBusy(true);
    setError("");
    try {
      await flushOpenDocuments();
      if (format === "legacy") {
        onLegacy();
        onClose();
        return;
      }
      if (format === "docx") {
        await downloadExport(docxUrl(page.id), `${exportName(page.title)}.docx`);
        onClose();
        return;
      }
      if (format === "epub") {
        await downloadExport(epubUrl({ pageId: page.id, children: treeChildren }), `${exportName(page.title)}.epub`);
        onClose();
        return;
      }
      if (format === "pdf") {
        // The print dialog takes over from here.
        await printExport(pdfUrl({ pageId: page.id, children: treeChildren }));
        onClose();
        return;
      }
      const response = await fetch("/api/markdown-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId: page.id,
          format,
          includeSubpages: format === "zip" && children,
          history: format === "zip" && history,
        }),
      });
      if (!response.ok)
        throw new Error(
          serverMessage((await response.json()).error) || t("Export fehlgeschlagen.", "Export failed."),
        );
      downloadBlob(`${exportName(page.title)}.${format === "zip" ? "zip" : "md"}`, await response.blob());
      onClose();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : t("Export fehlgeschlagen.", "Export failed."),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={t("Seite exportieren", "Export page")}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void download();
        }}
      >
        <label>
          {t("Format", "Format")}
          <Select
            aria-label={t("Exportformat", "Export format")}
            value={format}
            disabled={busy}
            onChange={(event) => setFormat(event.target.value)}
          >
            <option value="markdown">Markdown (.md)</option>
            <option value="zip">{t("Markdown mit Dateien (.zip)", "Markdown with files (.zip)")}</option>
            <option value="docx">{t("Als Word (DOCX)", "As Word (DOCX)")}</option>
            <option value="pdf">{t("Als PDF (mit Unterseiten)", "As PDF (with sub-pages)")}</option>
            <option value="epub">{t("Als E-Book (EPUB)", "As e-book (EPUB)")}</option>
            <option value="legacy">
              {page.kind === "document"
                ? "HTML (.html)"
                : t("Datenbank-JSON (.json)", "Database JSON (.json)")}
            </option>
          </Select>
        </label>
        {format === "zip" && (
          <label className="export-children">
            <input
              type="checkbox"
              checked={children}
              disabled={busy}
              onChange={(event) => setChildren(event.target.checked)}
            />
            {t("Zugängliche Unterseiten einschließen", "Include accessible sub-pages")}
          </label>
        )}
        {tree && (
          <label className="export-children">
            <input type="checkbox" checked={treeChildren} disabled={busy} onChange={(event) => setTreeChildren(event.target.checked)} />
            {t("Zugängliche Unterseiten einschließen", "Include accessible sub-pages")}
          </label>
        )}
        {format === "zip" && (
          <label className="export-children">
            <input type="checkbox" checked={history} disabled={busy} onChange={(event) => setHistory(event.target.checked)} />
            {t("Kommentare und frühere Versionen einschließen", "Include comments and earlier versions")}
          </label>
        )}
        <p className="muted">
          {format === "markdown"
            ? t("Eine Markdown-Datei. Datei- und Seitenlinks verweisen weiterhin auf Flowplan.", "One Markdown file. File and page links keep pointing to Flowplan.")
            : format === "zip"
              ? t("Lokale Anhänge und relative Links sind enthalten. Externe Medien bleiben Links.", "Local attachments and relative links are included. External media stay links.")
              : format === "docx"
                ? t(
                    "Ein Word-Dokument mit Überschriften, Listen, Aufgaben, Tabellen, Bildern, Hinweisen, Code und Fußnoten. Whiteboards und eingebettete Medien bleiben Links.",
                    "A Word document with headings, lists, tasks, tables, pictures, callouts, code and footnotes. Whiteboards and embedded media stay links.",
                  )
                : format === "pdf"
                  ? t(
                      "Eine Druckansicht mit Deckblatt, Inhaltsverzeichnis und jeder Seite als Kapitel, die der Druckdialog als PDF sichert. Höchstens 200 Seiten.",
                      "A print view with a cover, a table of contents and every page as a chapter, which the print dialog saves as PDF. At most 200 pages.",
                    )
                  : format === "epub"
                    ? t(
                        "Ein E-Book mit jeder Seite als Kapitel, Bildern und Inhaltsverzeichnis – für Lesegeräte und E-Book-Apps. Höchstens 200 Seiten.",
                        "An e-book with every page as a chapter, pictures and a table of contents – for e-readers and e-book apps. At most 200 pages.",
                      )
                    : t("Das vorhandene Exportformat dieser Seite.", "This page's existing export format.")}
        </p>
        {page.kind === "database" && format !== "legacy" && (
          <p className="muted">
            {t("Enthält alle Datensätze, Eigenschaften und Datensatzdokumente, unabhängig von Ansichtfiltern. Im ZIP liegt zusätzlich eine CSV-Tabelle.", "Contains all records, properties and record documents regardless of view filters. The ZIP also contains a CSV table.")}
          </p>
        )}
        <p className="muted">
          {t("Offene Dokumentänderungen werden vor dem Download gespeichert.", "Open document changes are saved before the download.")}
        </p>
        {error && (
          <p role="alert" className="math-validation">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onClose}
          >
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={busy}>
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
