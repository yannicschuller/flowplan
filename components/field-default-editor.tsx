"use client";
// "Standardwert" in a property's settings (#411, lib/field-defaults.ts): a
// fixed value for text, number, select, multi-select, checkbox and date
// properties, "Heute"/"Jetzt" for dates and "Ersteller" for people. New
// records without a value of their own get it; existing ones stay.
import { Sparkle } from "@phosphor-icons/react";
import { cleanDefault, defaultKinds, type FieldDefault } from "@/lib/field-defaults";
import type { Field } from "@/lib/types";
import { useT } from "./i18n";
import { Select } from "./select";
import DateInput from "./date-input";
import type { ReactNode } from "react";

type Choice = "none" | "value" | "now" | "creator";

export function FieldDefaultEditor({ draft, disabled, onChange }: { draft: Field; disabled: boolean; onChange: (value: FieldDefault | undefined) => void }) {
  const t = useT();
  const kinds = defaultKinds(draft);
  if (!kinds.length) return null;
  // What is stored, as far as it still fits the draft (another type or a
  // removed option shows as no default; saving drops it).
  const current = cleanDefault(draft);
  const choice: Choice = current?.kind ?? (draft.defaultValue?.kind === "value" ? "value" : "none");
  const value = current?.kind === "value" ? current.value : draft.defaultValue?.kind === "value" ? draft.defaultValue.value : undefined;
  const set = (next: FieldDefault | undefined) => onChange(next);
  const nowLabel = draft.noTime ? t("Heute", "Today") : t("Jetzt", "Now");
  const options = draft.options || [];
  let control: ReactNode = null;
  if (draft.type === "person")
    control = (
      <label className="checkbox-label">
        <input type="checkbox" checked={choice === "creator"} disabled={disabled} onChange={(e) => set(e.target.checked ? { kind: "creator" } : undefined)} />
        {t("Ersteller – wer den Eintrag anlegt", "Creator – whoever creates the record")}
      </label>
    );
  else if (draft.type === "checkbox")
    control = (
      <label className="checkbox-label">
        <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => set(e.target.checked ? { kind: "value", value: true } : undefined)} />
        {t("Neue Einträge sind angehakt", "New records are checked")}
      </label>
    );
  else if (draft.type === "select")
    control = (
      <Select aria-label={t("Standardwert", "Default value")} value={typeof value === "string" && options.includes(value) ? value : ""} disabled={disabled} onChange={(e) => set(e.target.value ? { kind: "value", value: e.target.value } : undefined)}>
        <option value="">{t("Kein Standardwert", "No default value")}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    );
  else if (draft.type === "multiselect") {
    const chosen = Array.isArray(value) ? value : [];
    control = options.length ? (
      <div className="field-default-options" role="group" aria-label={t("Standardwert", "Default value")}>
        {options.map((o) => (
          <label key={o} className="checkbox-label">
            <input
              type="checkbox"
              disabled={disabled}
              checked={chosen.includes(o)}
              onChange={(e) => {
                const next = e.target.checked ? [...chosen, o] : chosen.filter((x) => x !== o);
                set(next.length ? { kind: "value", value: next } : undefined);
              }}
            />
            {o}
          </label>
        ))}
      </div>
    ) : (
      <small className="muted">{t("Lege zuerst Optionen an.", "Add options first.")}</small>
    );
  } else if (draft.type === "number")
    control = (
      <input
        type="number"
        step="any"
        aria-label={t("Standardwert", "Default value")}
        placeholder={t("Kein Standardwert", "No default value")}
        disabled={disabled}
        value={typeof value === "number" ? value : ""}
        onChange={(e) => (e.target.value === "" || !Number.isFinite(e.target.valueAsNumber) ? set(undefined) : set({ kind: "value", value: e.target.valueAsNumber }))}
      />
    );
  else if (draft.type === "text")
    control = (
      <input
        type="text"
        maxLength={10000}
        aria-label={t("Standardwert", "Default value")}
        placeholder={t("Kein Standardwert", "No default value")}
        disabled={disabled}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => set(e.target.value ? { kind: "value", value: e.target.value } : undefined)}
      />
    );
  else if (draft.type === "date")
    control = (
      <>
        <Select
          aria-label={t("Standardwert", "Default value")}
          value={choice}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value as Choice;
            set(next === "now" ? { kind: "now" } : next === "value" ? { kind: "value", value: "" } : undefined);
          }}
        >
          <option value="none">{t("Kein Standardwert", "No default value")}</option>
          <option value="now">{nowLabel}</option>
          <option value="value">{t("Festes Datum", "Fixed date")}</option>
        </Select>
        {choice === "value" && (
          <DateInput
            name="field-default-date"
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            allowTime={!draft.noTime}
            commit="change"
            onChange={(next) => set({ kind: "value", value: next })}
          />
        )}
      </>
    );
  return (
    <fieldset className="field-default">
      <legend>
        <Sparkle size={14} aria-hidden /> {t("Standardwert", "Default value")}
      </legend>
      {control}
      <small className="muted">
        {draft.type === "date" && choice === "now"
          ? draft.noTime
            ? t("Neue Einträge bekommen das Datum des Tages, an dem sie angelegt werden.", "New records get the date of the day they are created.")
            : t("Neue Einträge bekommen den Zeitpunkt, zu dem sie angelegt werden.", "New records get the moment they are created.")
          : t(
              "Neue Einträge ohne eigenen Wert bekommen ihn – auch aus Formularen, Automationen, Workflows und der API. Vorhandene Einträge ändern sich nicht.",
              "New records without a value of their own get it – also from forms, automations, workflows and the API. Existing records do not change.",
            )}
      </small>
    </fieldset>
  );
}
