"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { Select } from "./select";
import { useState } from "react";
import { Modal } from "./ui";
import { flushOpenDocuments } from "@/lib/document-flush";
import { exportName } from "@/lib/export-name";
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
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
      const response = await fetch("/api/markdown-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId: page.id,
          format,
          includeSubpages: format === "zip" && children,
        }),
      });
      if (!response.ok)
        throw new Error(
          serverMessage((await response.json()).error) || t("Export fehlgeschlagen.", "Export failed."),
        );
      const blob = await response.blob(),
        url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = `${exportName(page.title)}.${format === "zip" ? "zip" : "md"}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
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
        <p className="muted">
          {format === "markdown"
            ? t("Eine Markdown-Datei. Datei- und Seitenlinks verweisen weiterhin auf Flowplan.", "One Markdown file. File and page links keep pointing to Flowplan.")
            : format === "zip"
              ? t("Lokale Anhänge und relative Links sind enthalten. Externe Medien bleiben Links.", "Local attachments and relative links are included. External media stay links.")
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
            {busy ? t("Export wird erstellt …", "Creating export …") : t("Herunterladen", "Download")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
