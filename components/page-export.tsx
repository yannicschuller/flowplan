"use client";
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
          (await response.json()).error || "Export fehlgeschlagen.",
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
        error instanceof Error ? error.message : "Export fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title="Seite exportieren"
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
          Format
          <Select
            aria-label="Exportformat"
            value={format}
            disabled={busy}
            onChange={(event) => setFormat(event.target.value)}
          >
            <option value="markdown">Markdown (.md)</option>
            <option value="zip">Markdown mit Dateien (.zip)</option>
            <option value="legacy">
              {page.kind === "document"
                ? "HTML (.html)"
                : "Datenbank-JSON (.json)"}
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
            Zugängliche Unterseiten einschließen
          </label>
        )}
        <p className="muted">
          {format === "markdown"
            ? "Eine Markdown-Datei. Datei- und Seitenlinks verweisen weiterhin auf Flowplan."
            : format === "zip"
              ? "Lokale Anhänge und relative Links sind enthalten. Externe Medien bleiben Links."
              : "Das vorhandene Exportformat dieser Seite."}
        </p>
        {page.kind === "database" && format !== "legacy" && (
          <p className="muted">
            Enthält alle Datensätze, Eigenschaften und Datensatzdokumente,
            unabhängig von Ansichtfiltern. Im ZIP liegt zusätzlich eine
            CSV-Tabelle.
          </p>
        )}
        <p className="muted">
          Offene Dokumentänderungen werden vor dem Download gespeichert.
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
            Abbrechen
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Export wird erstellt …" : "Herunterladen"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
