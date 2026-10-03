"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { useState } from "react";
import {
  recordOpenLabels,
  recordOpenModes,
  type RecordLayout,
  type RecordOpenMode,
} from "@/lib/record-layout";
import type { Field } from "@/lib/types";

// Layout of all record pages of a database, changed by editors.
export function RecordLayoutEditor({
  layout,
  fields,
  save,
}: {
  layout: RecordLayout;
  fields: Field[];
  save: (layout: RecordLayout) => Promise<unknown>;
}) {
  const t = useT();
  const [draft, setDraft] = useState(layout),
    [busy, setBusy] = useState(false);
  async function change(next: RecordLayout) {
    setDraft(next);
    setBusy(true);
    await save(next);
    setBusy(false);
  }
  return (
    <div
      className="record-layout"
      role="group"
      aria-label={t("Layout der Einträge", "Record layout")}
    >
      <p className="muted">{t("Gilt für alle Einträge dieser Datenbank.", "Applies to all records of this database.")}</p>
      <label>
        {t("Einträge öffnen als", "Open records as")}
        <Select
          value={draft.open}
          disabled={busy}
          onChange={(e) =>
            void change({ ...draft, open: e.target.value as RecordOpenMode })
          }
        >
          {recordOpenModes.map((mode) => (
            <option key={mode} value={mode}>
              {t(recordOpenLabels[mode])}
            </option>
          ))}
        </Select>
      </label>
      <label>
        {t("Position der Eigenschaften", "Position of properties")}
        <Select
          value={draft.properties}
          disabled={busy}
          onChange={(e) =>
            void change({
              ...draft,
              properties: e.target.value as RecordLayout["properties"],
            })
          }
        >
          <option value="top">{t("Über dem Inhalt", "Above the content")}</option>
          <option value="side">{t("Neben dem Inhalt", "Beside the content")}</option>
        </Select>
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={draft.hideEmpty}
          disabled={busy}
          onChange={(e) =>
            void change({ ...draft, hideEmpty: e.target.checked })
          }
        />
        {t("Leere Eigenschaften einklappen", "Collapse empty properties")}
      </label>
      <fieldset>
        <legend>{t("Sichtbare Eigenschaften", "Visible properties")}</legend>
        {fields.slice(1).map((f) => (
          <label className="checkbox-label" key={f.id}>
            <input
              type="checkbox"
              checked={!draft.hidden.includes(f.id)}
              disabled={busy}
              onChange={(e) =>
                void change({
                  ...draft,
                  hidden: e.target.checked
                    ? draft.hidden.filter((id) => id !== f.id)
                    : [...draft.hidden, f.id],
                })
              }
            />
            {f.name}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
