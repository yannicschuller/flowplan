"use client";
// A text of a database rule that takes placeholders (#413): the task and
// its heading of "Aufgabe erstellen" (lib/automation-task.ts). The {}
// button or typing "{{" opens the picker of the workflow editor with the
// database's properties and the built-ins the rule fills in
// (lib/automation-placeholders.ts); a pick goes in at the cursor.
import { useMemo, useRef, useState } from "react";
import { BracketsCurly } from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";
import { PickerList, type PickerItem } from "./placeholder-picker";
import { builtinLang, insertToken, opensPicker, rulePlaceholders } from "@/lib/automation-placeholders";
import type { Builtin } from "@/lib/record-placeholders";
import type { Field } from "@/lib/types";

export function RuleTextInput({
  label,
  inputLabel,
  value,
  onChange,
  fields,
  scheduled,
  maxLength,
  placeholder,
  invalid,
}: {
  // The text in front of the field and the field's own name.
  label: string;
  inputLabel: string;
  value: string;
  onChange: (next: string) => void;
  fields: Field[];
  scheduled: boolean;
  maxLength: number;
  placeholder?: string;
  invalid?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const all = useMemo(() => {
    const builtins: Record<Builtin, string> = {
      title: t("Titel des Eintrags", "Title of the record"),
      today: t("Heutiges Datum", "Today's date"),
      now: t("Datum und Uhrzeit", "Date and time"),
      creator: t("Wer den Eintrag erstellt hat", "Who created the record"),
      me: scheduled ? t("Wer die Regel speichert", "Whoever saves the rule") : t("Auslösende Person", "Person who triggered it"),
      database: t("Name der Datenbank", "Name of the database"),
      space: t("Name des Bereichs", "Name of the space"),
    };
    return rulePlaceholders(fields, { scheduled, lang: builtinLang(locale) }).map(
      (p): PickerItem =>
        p.kind === "field"
          ? { id: p.id, group: t("Eigenschaften", "Properties"), label: p.name || t("Ohne Namen", "Unnamed"), example: p.token, stored: p.token }
          : { id: p.id, group: t("Allgemein", "General"), label: builtins[p.builtin], example: p.token, stored: p.token },
    );
  }, [fields, scheduled, locale, t]);
  const q = query.trim().toLowerCase();
  const items = q ? all.filter((i) => `${i.group} ${i.label} ${i.stored}`.toLowerCase().includes(q)) : all;
  const close = (focus = true) => {
    setOpen(false);
    setQuery("");
    if (focus) input.current?.focus();
  };
  const insert = (token: string) => {
    const el = input.current;
    const start = el?.selectionStart ?? value.length,
      end = el?.selectionEnd ?? value.length;
    const next = insertToken(value, start, end, token, maxLength);
    close(false);
    if (!next) return el?.focus();
    onChange(next.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };
  // A div, not a label: a label would pass taps on the {} button to the
  // text field (WebKit, see .field-group in app/globals.css).
  return (
    <div className="automation-row automation-text">
      <span>{label}</span>
      <div
        className="automation-text-field"
        onBlur={(e) => {
          // Leaving the field and its picker closes the picker.
          if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) close(false);
        }}
      >
        <div className="automation-text-row">
          <input
            ref={input}
            aria-label={inputLabel}
            value={value}
            maxLength={maxLength}
            aria-invalid={invalid || undefined}
            placeholder={placeholder}
            autoComplete="off"
            onChange={(e) => {
              const next = e.target.value;
              const at = e.target.selectionStart ?? next.length;
              onChange(next);
              if (opensPicker(value, next, at)) setOpen(true);
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={t(`Platzhalter einfügen in „${inputLabel}“`, `Insert a placeholder into “${inputLabel}”`)}
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={() => (open ? close() : setOpen(true))}
          >
            <BracketsCurly />
          </button>
        </div>
        {open && (
          <PickerList
            items={items}
            query={query}
            onQuery={setQuery}
            onPick={insert}
            onClose={() => close()}
            empty={t("Nichts gefunden.", "Nothing found.")}
            hint={
              scheduled
                ? t("Eine geplante Regel hat keinen Eintrag: Nur Datum, Uhrzeit, deine Person und die Datenbank werden ausgefüllt.", "A scheduled rule has no record: only the date, the time, you and the database are filled in.")
                : t("Umbenannte Eigenschaften passen danach nicht mehr – der Platzhalter bleibt dann stehen.", "A property renamed later no longer matches – the placeholder then stays as it is.")
            }
          />
        )}
      </div>
    </div>
  );
}
