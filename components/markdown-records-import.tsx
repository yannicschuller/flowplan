"use client";
// Markdown files (one, several or a ZIP) as records of this database: first
// a preview of what the frontmatter maps to, then the import.
import { useEffect, useState } from "react";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { Modal } from "./ui";

type Plan = {
  records: number;
  matched: string[];
  missing: { name: string; type: string }[];
  skipped: string[];
};

async function send(pageId: string, files: File[], options: Record<string, string>) {
  const body = new FormData();
  for (const file of files) body.append("file", file);
  for (const [key, value] of Object.entries(options)) body.set(key, value);
  const response = await fetch(`/api/pages/${pageId}/import-markdown`, { method: "POST", body });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(serverMessage(result.error) || "Import failed.");
  return result;
}

export function MarkdownRecordsImport({
  pageId,
  files,
  onClose,
  onDone,
  onError,
}: {
  pageId: string;
  files: File[];
  onClose: () => void;
  onDone: (created: number) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [createMissing, setCreateMissing] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    send(pageId, files, { dryRun: "1" })
      .then((result) => current && setPlan(result as Plan))
      .catch((e) => {
        if (!current) return;
        onError((e as Error).message);
        onClose();
      });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, files]);
  const typeNames: Record<string, string> = {
    text: t("Text", "Text"),
    number: t("Zahl", "Number"),
    date: t("Datum", "Date"),
    checkbox: t("Kontrollkästchen", "Checkbox"),
    select: t("Auswahl", "Select"),
    multiselect: t("Mehrfachauswahl", "Multi-select"),
    url: "URL",
  };
  return (
    <Modal open onClose={onClose} title={t("Markdown importieren", "Import Markdown")}>
      {!plan ? (
        <p className="muted">{t("Dateien werden gelesen …", "Reading files …")}</p>
      ) : (
        <form
          className="markdown-import"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const result = await send(pageId, files, { createMissing: createMissing ? "1" : "0" });
              onDone(Number(result.created) || 0);
            } catch (error) {
              onError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            {plan.records === 1
              ? t("1 Datei wird zu einem Eintrag.", "1 file becomes a record.")
              : t(`${plan.records} Dateien werden zu Einträgen.`, `${plan.records} files become records.`)}{" "}
            {t(
              "Der Titel kommt aus „title:“, der ersten Überschrift oder dem Dateinamen; der übrige Text wird zum Dokument des Eintrags.",
              "The title comes from “title:”, the first heading or the file name; the rest of the text becomes the record's document.",
            )}
          </p>
          {plan.matched.length > 0 && (
            <p>
              <strong>{t("Eigenschaften:", "Properties:")}</strong> {plan.matched.join(", ")}
            </p>
          )}
          {plan.missing.length > 0 && (
            <>
              <label className="checkbox-label">
                <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />
                {t("Fehlende Eigenschaften anlegen", "Create missing properties")}
              </label>
              <ul className="markdown-import-missing">
                {plan.missing.map((m) => (
                  <li key={m.name}>
                    {m.name} <small className="muted">{typeNames[m.type] || m.type}</small>
                  </li>
                ))}
              </ul>
              {!createMissing && (
                <p className="muted small">{t("Ohne neue Eigenschaften werden diese Werte nicht übernommen.", "Without new properties, these values are not taken over.")}</p>
              )}
            </>
          )}
          {plan.skipped.length > 0 && (
            <p className="muted small">
              {t("Berechnet und daher nicht übernommen:", "Computed and therefore not taken over:")} {plan.skipped.join(", ")}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? t("Wird importiert …", "Importing …") : t("Importieren", "Import")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
