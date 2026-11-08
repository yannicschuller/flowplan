"use client";
// Placeholders as chips (docs/specs/workflows.md §10.2): a longer text with
// placeholders shows them as named chips while it is not being typed in;
// a chip opens its filters (the list of §7.2 with their arguments) and a
// preview of the result from the last test run. Clicking the text (or Enter
// on it) goes back to typing. One-line fields keep the text form.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Trash, X } from "@phosphor-icons/react";
import { Select } from "../select";
import { FILTERS, formatTemplate, parseTemplate, renderText, type FilterArg, type Placeholder, type Segment } from "@/lib/workflows/placeholders";
import { useLocale } from "../i18n";
import { displayContext, showText, useStableT, type T } from "./model";
import type { PickerContext } from "./template-input";

// The arguments of each filter: kind and name [de, en].
// i18n-table: 2 – [kind, German, English]
const FILTER_ARGS: Record<string, [("text" | "number"), string, string][]> = {
  date: [["text", "Format (z. B. dd.MM.yyyy, kurz, lang)", "Format (e.g. yyyy-MM-dd, short, long)"]],
  add_days: [["number", "Tage", "Days"]],
  add_hours: [["number", "Stunden", "Hours"]],
  truncate: [
    ["number", "Länge", "Length"],
    ["text", "Endung (Standard …)", "Ending (default …)"],
  ],
  replace: [
    ["text", "Suchen", "Find"],
    ["text", "Ersetzen durch", "Replace with"],
  ],
  default: [["text", "Wert, wenn leer", "Value when empty"]],
  join: [["text", "Trenner (Standard „, “)", "Separator (default “, ”)"]],
  number: [["number", "Nachkommastellen", "Decimals"]],
};
// i18n-table: 1 – [German, English] pairs (what a filter does)
const FILTER_TEXT: Record<string, [string, string]> = {
  date: ["Datum formatieren", "Format a date"],
  add_days: ["Tage dazu", "Add days"],
  add_hours: ["Stunden dazu", "Add hours"],
  truncate: ["Kürzen", "Shorten"],
  upper: ["Großbuchstaben", "Upper case"],
  lower: ["Kleinbuchstaben", "Lower case"],
  trim: ["Leerraum entfernen", "Trim"],
  replace: ["Ersetzen", "Replace"],
  default: ["Standardwert", "Default"],
  join: ["Liste verbinden", "Join a list"],
  first: ["Erstes Element", "First item"],
  last: ["Letztes Element", "Last item"],
  count: ["Anzahl", "Count"],
  number: ["Zahl formatieren", "Format a number"],
  plain: ["Nur Text", "Plain text"],
  required: ["Pflicht (leer = Fehler)", "Required (empty = error)"],
  json: ["Als JSON", "As JSON"],
};

const filterName = (name: string, locale: string) => (locale.startsWith("de") ? FILTERS[name] || name : name);

// The text with chips; `onEdit` goes back to typing.
export function ChipText({ value, picker, disabled, onChange, onEdit, label }: { value: string; picker: PickerContext; disabled: boolean; onChange: (stored: string) => void; onEdit: () => void; label: string }) {
  const t = useStableT();
  const locale = useLocale();
  const ctx = useMemo(() => displayContext(picker.graph, locale, picker.ws), [picker, locale]);
  const [open, setOpen] = useState<number | null>(null);
  let segments: Segment[];
  try {
    segments = parseTemplate(value);
  } catch {
    segments = [value];
  }
  const chipName = (p: Placeholder) => showText(formatTemplate([{ ...p, filters: [] }]), ctx).replace(/^\{\{|\}\}$/g, "");
  return (
    <div className="wf-chiptext" role="group" aria-label={t(`${label} (mit Platzhaltern)`, `${label} (with placeholders)`)}>
      <div
        className="wf-chiptext-body"
        tabIndex={disabled ? -1 : 0}
        aria-label={t("Text bearbeiten", "Edit the text")}
        onClick={(e) => !disabled && !(e.target as HTMLElement).closest("button, .wf-filter-pop") && onEdit()}
        onKeyDown={(e) => {
          if (!disabled && (e.key === "Enter" || e.key === "F2") && e.target === e.currentTarget) {
            e.preventDefault();
            onEdit();
          }
        }}
      >
        {segments.map((s, i) =>
          typeof s === "string" ? (
            <span key={i}>{s}</span>
          ) : (
            <span key={i} className="wf-chip-wrap">
              <button type="button" className="wf-chip" aria-expanded={open === i} disabled={disabled} onClick={() => setOpen(open === i ? null : i)}>
                {chipName(s)}
                {s.filters.length > 0 && <span className="wf-chip-filters">{s.filters.map((f) => ` | ${filterName(f.name, locale)}`).join("")}</span>}
              </button>
            </span>
          ),
        )}
        {!segments.length && <span className="muted">{t("Leer", "Empty")}</span>}
      </div>
      {/* A chip whose text changed under an open popover may be gone: only an existing placeholder opens it. */}
      {open !== null && segments[open] !== undefined && typeof segments[open] !== "string" && (
        <FilterPopover
          placeholder={segments[open] as Placeholder}
          title={chipName(segments[open] as Placeholder)}
          picker={picker}
          onClose={() => setOpen(null)}
          onChange={(p) => onChange(formatTemplate(segments.map((x, j) => (j === open ? p : x))))}
          onRemove={() => {
            const at = open;
            setOpen(null);
            onChange(formatTemplate(segments.filter((_, j) => j !== at)));
          }}
          t={t}
        />
      )}
    </div>
  );
}

function FilterPopover({ placeholder, title, picker, onChange, onRemove, onClose, t }: { placeholder: Placeholder; title: string; picker: PickerContext; onChange: (p: Placeholder) => void; onRemove: () => void; onClose: () => void; t: T }) {
  const locale = useLocale();
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.querySelector<HTMLElement>("select, input, button")?.focus(), []);
  const set = (filters: Placeholder["filters"]) => onChange({ ...placeholder, filters });
  // The result with the values of the last test run, where there are some.
  const preview = useMemo(() => {
    const values = Object.fromEntries(picker.values);
    if (!Object.keys(values).length) return null;
    try {
      return renderText(formatTemplate([placeholder]), { values: { ...values, $today: new Date().toISOString().slice(0, 10), $now: new Date().toISOString() }, timeZone: picker.graph.settings.timeZone || "UTC", locale: locale as never });
    } catch (e) {
      return `⚠ ${(e as Error).message}`;
    }
  }, [placeholder, picker, locale]);
  const argInput = (f: number, a: number, kind: "text" | "number", label: string, value: FilterArg | undefined): ReactNode => (
    <input
      key={a}
      aria-label={label}
      placeholder={label}
      type={kind === "number" ? "number" : "text"}
      value={value ? (value.kind === "path" ? "" : String(value.value)) : ""}
      onChange={(e) => {
        const filters = placeholder.filters.map((x, i) => {
          if (i !== f) return x;
          const args = [...x.args];
          args[a] = kind === "number" ? { kind: "number", value: Number(e.target.value) || 0 } : { kind: "string", value: e.target.value };
          // Trailing empty optional arguments go.
          while (args.length && args[args.length - 1].kind === "string" && (args[args.length - 1] as { value: string }).value === "" && args.length > 1) args.pop();
          return { ...x, args };
        });
        set(filters);
      }}
    />
  );
  return (
    <div
      className="wf-filter-pop"
      role="dialog"
      aria-label={t(`Filter von „${title}“`, `Filters of “${title}”`)}
      ref={box}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="wf-filter-head">
        <strong>{title}</strong>
        <button type="button" className="icon-button" aria-label={t("Schließen", "Close")} onClick={onClose}>
          <X />
        </button>
      </div>
      {placeholder.filters.length === 0 && <p className="muted small">{t("Keine Filter: der Wert, wie er ist.", "No filters: the value as it is.")}</p>}
      <ol className="wf-filter-list">
        {placeholder.filters.map((f, i) => (
          <li key={i}>
            <span className="wf-filter-name">{t(FILTER_TEXT[f.name]?.[0] || f.name, FILTER_TEXT[f.name]?.[1] || f.name)}</span>
            {(FILTER_ARGS[f.name] || []).map(([kind, de, en], a) => argInput(i, a, kind, t(de, en), f.args[a]))}
            <button type="button" className="icon-button" aria-label={t(`Filter ${i + 1} entfernen`, `Remove filter ${i + 1}`)} onClick={() => set(placeholder.filters.filter((_, j) => j !== i))}>
              <Trash />
            </button>
          </li>
        ))}
      </ol>
      <div className="wf-inline">
        <Select
          id={id}
          aria-label={t("Filter hinzufügen", "Add a filter")}
          value=""
          onChange={(e) => {
            const name = e.target.value;
            if (!name) return;
            const args: FilterArg[] = (FILTER_ARGS[name] || []).slice(0, 1).map(([kind]) => (kind === "number" ? { kind: "number", value: name === "truncate" ? 140 : name === "number" ? 2 : 1 } : { kind: "string", value: name === "date" ? "dd.MM.yyyy" : "" }));
            set([...placeholder.filters, { name, args }]);
          }}
        >
          <option value="">{t("+ Filter …", "+ Filter …")}</option>
          {Object.keys(FILTERS).map((name) => (
            <option key={name} value={name}>
              {t(FILTER_TEXT[name][0], FILTER_TEXT[name][1])}
            </option>
          ))}
        </Select>
        <button type="button" className="button compact danger" onClick={onRemove}>
          <Trash /> {t("Platzhalter entfernen", "Remove the placeholder")}
        </button>
      </div>
      {preview !== null && (
        <p className="wf-filter-preview">
          <span className="muted">{t("Ergebnis im letzten Test:", "Result in the last test:")}</span> <code>{preview || "∅"}</code>
        </p>
      )}
      <p className="muted small">{t("Filter wirken der Reihe nach.", "Filters apply in order.")}</p>
    </div>
  );
}
