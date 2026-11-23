"use client";
// "Pflichtfeld" in a property's settings (#443, lib/field-required.ts) and
// the mark of a required property that has no value yet.
import { Asterisk, WarningCircle } from "@phosphor-icons/react";
import { canBeRequired, missingCount } from "@/lib/field-required";
import { cleanDefault } from "@/lib/field-defaults";
import type { Field, Row } from "@/lib/types";
import { useT } from "./i18n";

export function FieldRequiredEditor({
  draft,
  rows,
  disabled,
  onChange,
}: {
  draft: Field;
  rows: Pick<Row, "cells">[];
  disabled: boolean;
  onChange: (required: boolean) => void;
}) {
  const t = useT();
  if (!canBeRequired(draft)) return null;
  const on = !!draft.required;
  // Records already empty stay so (no migration); the switch says how many.
  const empty = on ? missingCount(draft, rows) : 0;
  const hasDefault = !!cleanDefault(draft);
  return (
    <fieldset className="field-required">
      <legend>
        <Asterisk size={14} aria-hidden /> {t("Pflichtfeld", "Required")}
      </legend>
      <label className="checkbox-label">
        <input type="checkbox" role="switch" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        {t("Darf nicht leer sein", "Cannot be empty")}
      </label>
      <small className="muted">
        {hasDefault
          ? t("Neue Einträge bekommen den Standardwert; leeren lässt sich der Wert nicht.", "New records get the default value; the value cannot be cleared.")
          : draft.type === "select"
            ? t("Neue Einträge ohne eigenen Wert bekommen die erste Option; leeren lässt sich der Wert nicht.", "New records without a value of their own get the first option; the value cannot be cleared.")
            : t("Neue Einträge ohne Wert werden als fehlend markiert; leeren lässt sich der Wert nicht.", "New records without a value are marked as missing; the value cannot be cleared.")}
      </small>
      {empty > 0 && (
        <p className="field-required-notice" role="status">
          <WarningCircle size={14} weight="fill" aria-hidden />
          {empty === 1
            ? t("1 Eintrag hat noch keinen Wert.", "1 record has no value yet.")
            : t(`${empty} Einträge haben noch keinen Wert.`, `${empty} records have no value yet.`)}
        </p>
      )}
    </fieldset>
  );
}

// An empty required property: a small mark with its meaning for screen
// readers (and as a tooltip); `label` shows the words next to it.
export function RequiredMissing({ label = false }: { label?: boolean }) {
  const t = useT();
  const text = t("Wert fehlt (Pflichtfeld)", "Value missing (required)");
  return (
    <span className="required-missing" title={text}>
      <WarningCircle size={14} weight="fill" aria-hidden />
      {label ? <span>{text}</span> : <span className="sr-only">{text}</span>}
    </span>
  );
}
// The asterisk after a required property's name.
export function RequiredMark() {
  const t = useT();
  return (
    <span className="required-mark" title={t("Pflichtfeld", "Required")}>
      <span aria-hidden>*</span>
      <span className="sr-only">{t("Pflichtfeld", "Required")}</span>
    </span>
  );
}
