"use client";
// "Vorlage anwenden" on an existing record (record menu, table row menu):
// which record template, and what happens to text that is already there.
// The server fills empty properties and the placeholders
// (lib/record-template-apply.ts); existing text is never overwritten.
import { useState } from "react";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { Select } from "./select";

export type ApplyMode = "empty" | "append";

export function ApplyTemplateDialog({
  templates,
  hasContent,
  onApply,
  onClose,
}: {
  templates: { id: string; name: string; is_default?: number }[];
  // Whether the record already has text (unknown: undefined).
  hasContent?: boolean;
  onApply: (templateId: string, mode: ApplyMode) => Promise<boolean>;
  onClose: () => void;
}) {
  const t = useT();
  const [templateId, setTemplateId] = useState((templates.find((x) => x.is_default) || templates[0])?.id || "");
  const [mode, setMode] = useState<ApplyMode>(hasContent ? "append" : "empty");
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title={t("Vorlage anwenden", "Apply template")}>
      <form
        className="apply-template"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!templateId) return;
          setBusy(true);
          try {
            if (await onApply(templateId, mode)) onClose();
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {t("Datensatzvorlage", "Record template")}
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </label>
        <fieldset className="apply-template-mode">
          <legend>{t("Vorhandener Inhalt", "Existing content")}</legend>
          <label className="checkbox-label">
            <input type="radio" name="apply-mode" checked={mode === "empty"} onChange={() => setMode("empty")} />
            {t("Nur anwenden, wenn der Inhalt leer ist", "Apply only if the content is empty")}
          </label>
          <label className="checkbox-label">
            <input type="radio" name="apply-mode" checked={mode === "append"} onChange={() => setMode("append")} />
            {t("Unten anhängen", "Append below")}
          </label>
        </fieldset>
        <p className="muted">
          {t(
            "Leere Eigenschaften erhalten die Werte der Vorlage, Platzhalter wie {{Status}} die Werte des Eintrags. Vorhandener Text und ausgefüllte Eigenschaften bleiben, wie sie sind.",
            "Empty properties get the template's values, placeholders like {{Status}} the record's values. Existing text and filled properties stay as they are.",
          )}
        </p>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={busy || !templateId}>
            {busy ? t("Wird angewendet …", "Applying …") : t("Anwenden", "Apply")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
