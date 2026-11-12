"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { Select } from "./select";
import { useId, useState } from "react";
import { downloadBlob, download as downloadText, Modal } from "./ui";
import { showToast } from "./toast";
import { flushOpenDocuments } from "@/lib/document-flush";
import { exportName } from "@/lib/export-name";
import { docxUrl, downloadExport, epubUrl, exportText, pdfUrl, printExport, textExportUrl } from "./export-download";
import { requestPrint } from "./print-dialog";
import { absoluteLinks, copyExport, storeDestination, storedDestination, type ExportDestination as Destination } from "@/lib/export-clipboard";

// The page's own export of the open editor: HTML of a document (`html`
// is the fragment for rich-text pasting), JSON of a database.
export type LegacyExport = { name: string; text: string; mime: string; html?: string };
// Text formats can also go to the clipboard (#220); the others are files.
const TEXT_FORMATS = new Set(["markdown", "jira", "confluence", "legacy"]);
export function PageExportDialog({
  page,
  onClose,
  legacy,
}: {
  page: { id: string; title: string; kind: string };
  onClose: () => void;
  legacy: () => LegacyExport;
}) {
  const t = useT();
  const radioName = useId();
  const [format, setFormat] = useState("markdown"),
    [destination, setDestination] = useState<Destination>(storedDestination),
    [children, setChildren] = useState(false),
    [treeChildren, setTreeChildren] = useState(true),
    [history, setHistory] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const tree = format === "pdf" || format === "epub";
  const textFormat = TEXT_FORMATS.has(format);
  const toClipboard = textFormat && destination === "clipboard";
  const htmlLegacy = format === "legacy" && page.kind === "document";
  function chooseDestination(value: Destination) {
    setDestination(value);
    storeDestination(value);
  }
  // The text of a text format, fetched (or built) after open changes are saved.
  async function text(): Promise<{ text: string; html?: string }> {
    if (format === "legacy") {
      await flushOpenDocuments();
      const result = legacy();
      const origin = window.location.origin;
      return { text: absoluteLinks(result.text, origin), html: result.html === undefined ? undefined : absoluteLinks(result.html, origin) };
    }
    if (format === "jira" || format === "confluence") return { text: await exportText(textExportUrl(format, page.id)) };
    return { text: await (await markdown()).text() };
  }
  async function markdown() {
    await flushOpenDocuments();
    const response = await fetch("/api/markdown-export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageId: page.id,
        format: format === "zip" ? "zip" : "markdown",
        includeSubpages: format === "zip" && children,
        history: format === "zip" && history,
      }),
    });
    if (!response.ok)
      throw new Error(serverMessage((await response.json().catch(() => ({}))).error) || t("Export fehlgeschlagen.", "Export failed."));
    return response;
  }
  async function run() {
    setBusy(true);
    setError("");
    // The clipboard is asked right away, while the click still counts as
    // the person's own action (Safari and the iPhone app refuse it later);
    // the text follows once the server has it.
    if (toClipboard) {
      try {
        await copyExport(text(), htmlLegacy);
        showToast({ text: t("In die Zwischenablage kopiert.", "Copied to the clipboard.") });
        onClose();
      } catch (error) {
        setError(error instanceof Error ? error.message : t("Kopieren fehlgeschlagen.", "Copying failed."));
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      await flushOpenDocuments();
      if (format === "legacy") {
        const result = legacy();
        downloadText(result.name, result.text, result.mime);
      } else if (format === "docx") await downloadExport(docxUrl(page.id), `${exportName(page.title)}.docx`);
      else if (format === "epub") await downloadExport(epubUrl({ pageId: page.id, children: treeChildren }), `${exportName(page.title)}.epub`);
      else if (format === "pdf") {
        // The print options (#215), then the browser's print dialog.
        const url = pdfUrl({ pageId: page.id, children: treeChildren });
        onClose();
        requestPrint({ kind: "book", run: (options) => printExport(url, options) });
        return;
      }
      else if (format === "jira") await downloadExport(textExportUrl("jira", page.id), `${exportName(page.title)}.jira.txt`);
      else if (format === "confluence") await downloadExport(textExportUrl("confluence", page.id), `${exportName(page.title)}.confluence.xhtml`);
      else downloadBlob(`${exportName(page.title)}.${format === "zip" ? "zip" : "md"}`, await (await markdown()).blob());
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("Export fehlgeschlagen.", "Export failed."));
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
          void run();
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
            <option value="jira">{t("Jira (Wiki-Markup)", "Jira (wiki markup)")}</option>
            <option value="confluence">{t("Confluence (Speicherformat)", "Confluence (storage format)")}</option>
            <option value="legacy">
              {page.kind === "document"
                ? "HTML (.html)"
                : t("Datenbank-JSON (.json)", "Database JSON (.json)")}
            </option>
          </Select>
        </label>
        {textFormat && (
          <div className="export-destination">
            <span id={`${radioName}-label`}>{t("Ziel", "Destination")}</span>
            <span className="segmented" role="radiogroup" aria-labelledby={`${radioName}-label`}>
              <label data-active={destination === "file"}>
                <input type="radio" name={radioName} checked={destination === "file"} disabled={busy} onChange={() => chooseDestination("file")} />
                {t("Datei", "File")}
              </label>
              <label data-active={destination === "clipboard"}>
                <input type="radio" name={radioName} checked={destination === "clipboard"} disabled={busy} onChange={() => chooseDestination("clipboard")} />
                {t("Zwischenablage", "Clipboard")}
              </label>
            </span>
          </div>
        )}
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
                    : format === "jira"
                      ? t(
                          "Wiki-Markup für Jira-Beschreibungen und -Kommentare: Überschriften, Listen, Aufgaben, Tabellen, Code, Hinweise und Links. Nur diese Seite, ohne Unterseiten.",
                          "Wiki markup for Jira descriptions and comments: headings, lists, tasks, tables, code, callouts and links. This page only, without sub-pages.",
                        )
                      : format === "confluence"
                        ? t(
                            "Confluence-Speicherformat (XHTML) für den Quelltext-Editor oder die REST-API: Code-, Info- und Aufgaben-Makros, Tabellen und Bilder. Nur diese Seite, ohne Unterseiten.",
                            "Confluence storage format (XHTML) for the source editor or the REST API: code, info and task macros, tables and pictures. This page only, without sub-pages.",
                          )
                        : t("Das vorhandene Exportformat dieser Seite.", "This page's existing export format.")}
        </p>
        {toClipboard && (
          <p className="muted">
            {t(
              "Bilder und Anhänge kommen nicht mit: Sie bleiben Links auf Flowplan (vollständige Adressen), die nur mit Zugang zu Flowplan öffnen.",
              "Pictures and attachments do not come along: they stay links to Flowplan (full addresses) that open only with access to Flowplan.",
            )}
          </p>
        )}
        {page.kind === "database" && format !== "legacy" && (
          <p className="muted">
            {t("Enthält alle Datensätze, Eigenschaften und Datensatzdokumente, unabhängig von Ansichtfiltern. Im ZIP liegt zusätzlich eine CSV-Tabelle.", "Contains all records, properties and record documents regardless of view filters. The ZIP also contains a CSV table.")}
          </p>
        )}
        <p className="muted">
          {toClipboard
            ? t("Offene Dokumentänderungen werden vor dem Kopieren gespeichert.", "Open document changes are saved before copying.")
            : t("Offene Dokumentänderungen werden vor dem Download gespeichert.", "Open document changes are saved before the download.")}
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
                : toClipboard
                  ? t("Wird kopiert …", "Copying …")
                  : t("Export wird erstellt …", "Creating export …")
              : format === "pdf"
                ? t("Drucken / PDF", "Print / PDF")
                : toClipboard
                  ? t("Kopieren", "Copy")
                  : t("Herunterladen", "Download")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
