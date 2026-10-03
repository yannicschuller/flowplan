"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { computedCellsDetailed, cellText } from "@/lib/database";
import { formulaFunctions } from "@/lib/formula-catalog";
import {
  validateFormula,
  rewriteFormulaReferences,
  FORMULA_MAX_LENGTH,
  hasClockFormulas,
} from "@/lib/formula";
import { useFilterClock } from "./use-filter-clock";
import {
  formulaCompletionRange,
  formulaSuggestions,
  insertFormulaSuggestion,
  type FormulaSuggestion,
} from "@/lib/formula-suggestions";
import type { Field, Row } from "@/lib/types";

export default function FormulaEditor({
  field,
  fields,
  rows,
  related,
  schemas,
  disabled,
  onChange,
}: {
  field: Field;
  fields: Field[];
  rows: Row[];
  related: Record<string, Row[]>;
  schemas: Record<string, Field[]>;
  disabled: boolean;
  onChange: (source: string) => void;
}) {
  const t = useT();
  const source = field.formula || "",
    id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<number | null>(null);
  useLayoutEffect(() => {
    const position = pendingSelection.current;
    if (position === null) return;
    pendingSelection.current = null;
    input.current?.focus();
    input.current?.setSelectionRange(position, position);
    setCursor({ start: position, end: position });
  });
  const [cursor, setCursor] = useState({
    start: source.length,
    end: source.length,
  });
  const [focused, setFocused] = useState(false),
    [hidden, setHidden] = useState(false),
    [active, setActive] = useState(0);
  const [search, setSearch] = useState(""),
    [category, setCategory] = useState("all"),
    [sample, setSample] = useState(rows[0]?.id || "");
  const draftFields = useMemo(
    () =>
      fields.some((f) => f.id === field.id)
        ? fields.map((f) => (f.id === field.id ? field : f))
        : [...fields, field],
    [fields, field],
  );
  const syntax = validateFormula(
    source,
    draftFields.flatMap((f) => [f.id, f.name]),
  );
  const stored = rewriteFormulaReferences(source, draftFields, "store");
  const tooLong = stored.length > FORMULA_MAX_LENGTH;
  const range = formulaCompletionRange(source, cursor.start, cursor.end);
  const suggestions = formulaSuggestions(
    range.query,
    draftFields,
    range.propertiesOnly,
  ).slice(0, 7);
  const showSuggestions =
    focused && !hidden && !!range.query && !!suggestions.length;
  const selected = Math.min(active, Math.max(0, suggestions.length - 1));
  const catalog = formulaSuggestions(search, draftFields).filter(
    (entry) =>
      category === "all" ||
      (category === "properties"
        ? entry.kind === "property"
        : entry.kind === "function" && entry.fn.category === category),
  );
  const categories = Array.from(
    new Set(formulaFunctions.map((fn) => fn.category)),
  );
  const sampleRows = rows.slice(0, 100);
  const row = sampleRows.find((r) => r.id === sample) || sampleRows[0];
  const now = useFilterClock(hasClockFormulas(draftFields, schemas));
  const preview = useMemo(() => {
    if (syntax || tooLong) return null;
    const record: Row = row || {
      id: "preview",
      page_id: "preview",
      cells: {},
      position: 0,
      created_at: "",
      updated_at: "",
      created_by: "",
      updated_by: "",
      version: 1,
    };
    return computedCellsDetailed(
      record,
      draftFields,
      related,
      schemas,
      new Date(now),
    );
  }, [
    source,
    row,
    draftFields,
    related,
    schemas,
    syntax?.message,
    tooLong,
    now,
  ]);
  const error = syntax || preview?.diagnostics[field.id];
  const descriptionId = `${id}-description`,
    listId = `${id}-suggestions`;
  function place(value: string, position: number) {
    pendingSelection.current = position;
    onChange(value);
    setCursor({ start: position, end: position });
    setHidden(true);
  }
  function insert(suggestion: FormulaSuggestion) {
    const next = insertFormulaSuggestion(
      source,
      cursor.start,
      cursor.end,
      suggestion,
      draftFields,
    );
    if (next.value.length > FORMULA_MAX_LENGTH) return;
    place(next.value, next.cursor);
  }
  return (
    <section className="formula-editor" aria-label={t("Formeleditor", "Formula editor")}>
      <label htmlFor={`${id}-input`}>{t("Formel", "Formula")}</label>
      <div className="formula-source">
        <textarea
          id={`${id}-input`}
          ref={input}
          aria-label={t("Formel", "Formula")}
          value={source}
          placeholder={'prop("Aufwand") * 2'}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          maxLength={FORMULA_MAX_LENGTH}
          aria-invalid={!!syntax || tooLong}
          aria-describedby={descriptionId}
          aria-autocomplete="list"
          aria-controls={showSuggestions ? listId : undefined}
          aria-activedescendant={
            showSuggestions ? `${listId}-${selected}` : undefined
          }
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSelect={(e) =>
            setCursor({
              start: e.currentTarget.selectionStart,
              end: e.currentTarget.selectionEnd,
            })
          }
          onChange={(e) => {
            onChange(e.target.value);
            setCursor({
              start: e.target.selectionStart,
              end: e.target.selectionEnd,
            });
            setActive(0);
            setHidden(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && showSuggestions) {
              e.preventDefault();
              e.stopPropagation();
              setHidden(true);
            }
            if (showSuggestions && ["ArrowDown", "ArrowUp"].includes(e.key)) {
              e.preventDefault();
              setActive(
                (selected +
                  (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) %
                  suggestions.length,
              );
            }
            if (showSuggestions && e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              insert(suggestions[selected]);
            }
          }}
        />
        {showSuggestions && (
          <div
            id={listId}
            className="formula-suggestions"
            role="listbox"
            aria-label={t("Formelvorschläge", "Formula suggestions")}
          >
            {suggestions.map((suggestion, index) => (
              <button
                id={`${listId}-${index}`}
                key={`${suggestion.kind}-${suggestion.kind === "property" ? suggestion.field.id : suggestion.name}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === selected}
                onPointerDown={(e) => {
                  e.preventDefault();
                  insert(suggestion);
                }}
                onClick={(e) => {
                  if (e.detail === 0) insert(suggestion);
                }}
              >
                <strong>{suggestion.name}</strong>
                <small>
                  {suggestion.kind === "property"
                    ? t("Eigenschaft", "Property")
                    : suggestion.fn.signature}
                </small>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="formula-editor-meta">
        <small id={descriptionId}>
          {t("Vorschläge: ↑ ↓ und Enter · Neue Zeile: Umschalt+Enter", "Suggestions: ↑ ↓ and Enter · New line: Shift+Enter")}
        </small>
        <small>
          {source.length}/{FORMULA_MAX_LENGTH}
        </small>
      </div>
      {tooLong ? (
        <p className="error" role="alert">
          {t("Die Formel enthält zu viele Eigenschaftsbezüge. Teile die Berechnung auf mehrere Formeleigenschaften auf.", "The formula contains too many property references. Split the calculation into several formula properties.")}
        </p>
      ) : syntax ? (
        <p className="error formula-diagnostic" role="alert">
          {syntax.message}{" "}
          <button
            type="button"
            onClick={() => {
              input.current?.focus();
              input.current?.setSelectionRange(syntax.start, syntax.end);
            }}
          >
            {t("Fehler markieren", "Highlight errors")}
          </button>
          <small>
            {t("Zeile", "Line")}{" "}{source.slice(0, syntax.start).split("\n").length}, Zeichen{" "}
            {syntax.start -
              source.lastIndexOf("\n", Math.max(0, syntax.start - 1))}
          </small>
        </p>
      ) : (
        <p className="formula-valid" role="status">
          {t("Formel ist gültig.", "Formula is valid.")}
        </p>
      )}
      <section className="formula-preview" aria-label={t("Formelvorschau", "Formula preview")}>
        <div className="formula-preview-heading">
          <strong>{t("Live-Vorschau", "Live preview")}</strong>
          {sampleRows.length > 0 && (
            <Select
              aria-label={t("Vorschaueintrag", "Preview record")}
              value={row?.id || ""}
              onChange={(e) => setSample(e.target.value)}
            >
              {sampleRows.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {cellText(entry.cells[fields[0]?.id || "title"]) ||
                    t("Ohne Titel", "Untitled")}
                </option>
              ))}
            </Select>
          )}
        </div>
        {!row && (
          <small>{t("Vorschau ohne Datensatz; Eigenschaften sind leer.", "Preview without a record; properties are empty.")}</small>
        )}
        {rows.length > 100 && (
          <small>{t("Die ersten 100 lesbaren Einträge stehen zur Auswahl.", "The first 100 readable records are available.")}</small>
        )}
        {syntax || tooLong ? (
          <p className="muted">{t("Behebe zuerst den Formelfehler.", "Fix the formula error first.")}</p>
        ) : error ? (
          <p role="alert" className="error">
            {error.code}: {error.message}
          </p>
        ) : (
          <output aria-label={t("Formelergebnis", "Formula result")}>
            {cellText(preview?.cells[field.id]) || t("Leer", "Empty")}
          </output>
        )}
        {!syntax && !tooLong && error && (
          <small>
            {t("Dieser Eintrag kann noch nicht berechnet werden. Andere Einträge können gültige Ergebnisse liefern.", "This record cannot be calculated yet. Other records may give valid results.")}
          </small>
        )}
      </section>
      <details className="formula-catalog" open>
        <summary>{t("Funktionen und Eigenschaften", "Functions and properties")}</summary>
        <div className="formula-catalog-filters">
          <input
            type="search"
            aria-label={t("Funktionen und Eigenschaften suchen", "Search functions and properties")}
            placeholder={t("Funktion oder Eigenschaft suchen …", "Search function or property …")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            aria-label={t("Formelkategorie", "Formula category")}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="all">{t("Alle Kategorien", "All categories")}</option>
            <option value="properties">{t("Eigenschaften", "Properties")}</option>
            {categories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </div>
        <div className="formula-catalog-items">
          {catalog.map((suggestion) => (
            <article
              key={`${suggestion.kind}-${suggestion.kind === "property" ? suggestion.field.id : suggestion.name}`}
            >
              <button
                type="button"
                disabled={disabled}
                onClick={() => insert(suggestion)}
                aria-label={t(`${suggestion.kind === "property" ? "Eigenschaft" : "Funktion"} ${suggestion.name} einfügen`, `Insert ${suggestion.kind === "property" ? "property" : "function"} ${suggestion.name}`)}
              >
                <strong>
                  {suggestion.kind === "function"
                    ? suggestion.fn.signature
                    : suggestion.name}
                </strong>
                <small>
                  {suggestion.kind === "property"
                    ? t("Eigenschaft einfügen", "Insert property")
                    : suggestion.fn.description}
                </small>
              </button>
              {suggestion.kind === "function" && (
                <button
                  type="button"
                  className="formula-example"
                  disabled={disabled}
                  aria-label={t(`Beispiel für ${suggestion.name} einfügen`, `Insert example for ${suggestion.name}`)}
                  onClick={() => {
                    const from = cursor.start,
                      to = cursor.end,
                      example = suggestion.fn.example;
                    const next =
                      source.slice(0, from) + example + source.slice(to);
                    if (next.length <= FORMULA_MAX_LENGTH)
                      place(next, from + example.length);
                  }}
                >
                  <code>{suggestion.fn.example}</code>
                </button>
              )}
            </article>
          ))}
          {!catalog.length && (
            <p className="muted">
              {t("Keine passenden Funktionen oder Eigenschaften.", "No matching functions or properties.")}
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
