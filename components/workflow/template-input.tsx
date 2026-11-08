"use client";
// A text with placeholders (docs/specs/workflows.md §7, §10.2): shown and
// typed in the display form – node names, property names, built-ins and
// filters in the reader's language (toDisplay/fromDisplay of
// lib/workflows/placeholders.ts) – and stored with ids. The {} button or
// typing "{{" opens the picker: the outputs of the nodes before this one,
// with the value of the last test where there is one, and the built-ins.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { BracketsCurly } from "@phosphor-icons/react";
import { useLocale } from "../i18n";
import { BUILTIN_ROOTS, formatTemplate, fromDisplay, type PathKey } from "@/lib/workflows/placeholders";
import { upstreamNodes, type WorkflowGraph } from "@/lib/workflows/graph";
import type { OutputField, OutputType } from "@/lib/workflows/catalog";
import { displayContext, orderedNodes, outputTree, showText, type Workspace, useStableT } from "./model";

export type PickerContext = {
  graph: WorkflowGraph;
  nodeId: string;
  ws: Workspace;
  // Outputs of the last test run, per node.
  values: Map<string, unknown>;
};

// i18n-table: 1 – [German, English] pairs (types in the picker)
const TYPE_TEXT: Record<OutputType, [string, string]> = {
  text: ["Text", "Text"],
  number: ["Zahl", "Number"],
  boolean: ["Ja/Nein", "Yes/no"],
  date: ["Datum", "Date"],
  datetime: ["Zeitpunkt", "Date and time"],
  person: ["Person", "Person"],
  page: ["Seite", "Page"],
  record: ["Eintrag", "Record"],
  list: ["Liste", "List"],
  object: ["Gruppe", "Group"],
  file: ["Datei", "File"],
};
type Item = { id: string; group: string; label: string; depth: number; type: OutputType; stored: string; example?: string };

const sample = (v: unknown) => {
  if (v === undefined || v === null || v === "") return undefined;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};
function pick(value: unknown, keys: PathKey[]): unknown {
  let v = value;
  for (const k of keys) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k as string] : undefined;
  return v;
}

export function usePickerItems(ctx: PickerContext | null, query: string) {
  const t = useStableT();
  const locale = useLocale();
  return useMemo(() => {
    if (!ctx) return [] as Item[];
    const items: Item[] = [];
    const before = upstreamNodes(ctx.graph, ctx.nodeId);
    const lang = locale.startsWith("de") ? 0 : locale.startsWith("fr") ? 2 : 1;
    for (const node of orderedNodes(ctx.graph)) {
      if (!before.has(node.id)) continue;
      const last = ctx.values.get(node.id);
      const walk = (fields: OutputField[], keys: PathKey[], depth: number) => {
        for (const f of fields) {
          const path = [...keys, f.key];
          items.push({
            id: `${node.id}:${path.join(".")}`,
            group: node.label,
            label: t(f.label[0], f.label[1]),
            depth,
            type: f.type,
            stored: formatTemplate([{ path: { root: node.id, keys: path }, filters: [] }]),
            example: sample(pick(last, path)),
          });
          if (f.children && depth < 2) walk(f.children, path, depth + 1);
        }
      };
      walk(outputTree(node, ctx.ws), [], 0);
    }
    for (const [root, names] of Object.entries(BUILTIN_ROOTS)) {
      if (root === "$item" || root === "$index") continue;
      items.push({ id: root, group: t("Allgemein", "General"), label: `$${names[lang]}`, depth: 0, type: root === "$today" ? "date" : root === "$now" ? "datetime" : root === "$runner" ? "person" : "object", stored: `{{${root}}}` });
    }
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => `${i.group} ${i.label}`.toLowerCase().includes(q)) : items;
  }, [ctx, query, t, locale]);
}

export function TemplateInput({
  value,
  onChange,
  label,
  picker,
  multiline = false,
  placeholder,
  disabled = false,
  id,
}: {
  value: string;
  onChange: (stored: string) => void;
  label: string;
  picker: PickerContext | null;
  multiline?: boolean;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}) {
  const t = useStableT();
  const locale = useLocale();
  const own = useId();
  const inputId = id || own;
  const ctx = useMemo(() => (picker ? displayContext(picker.graph, locale, picker.ws) : null), [picker, locale]);
  const shown = useMemo(() => (ctx ? showText(value, ctx) : value), [value, ctx]);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const focused = useRef(false);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // From outside (another person, undo): shown again unless typing here.
  useEffect(() => {
    if (!focused.current) {
      setText(shown);
      setError(null);
    }
  }, [shown]);
  const commit = (next: string) => {
    setText(next);
    try {
      const stored = ctx ? fromDisplay(next, ctx) : next;
      setError(null);
      if (stored !== value) onChange(stored);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const insert = (stored: string) => {
    const el = field.current;
    const token = ctx ? showText(stored, ctx) : stored;
    const start = el?.selectionStart ?? text.length,
      end = el?.selectionEnd ?? text.length;
    // A "{{" typed just before is replaced by the whole placeholder.
    const from = text.slice(Math.max(0, start - 2), start) === "{{" ? start - 2 : start;
    const next = text.slice(0, from) + token + text.slice(end);
    commit(next);
    setOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      const at = from + token.length;
      el?.setSelectionRange(at, at);
    });
  };
  const props = {
    id: inputId,
    ref: field,
    value: text,
    placeholder,
    disabled,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${inputId}-error` : undefined,
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      if (!error) setText(shown);
    },
    onChange: (e: { target: { value: string; selectionStart: number | null } }) => {
      const next = e.target.value;
      commit(next);
      const at = e.target.selectionStart ?? next.length;
      if (picker && next.slice(at - 2, at) === "{{" && text.slice(at - 3, at - 1) !== "{{") setOpen(true);
    },
  };
  return (
    <div className="wf-template">
      <label className="wf-field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="wf-template-row">
        {multiline ? <textarea {...props} rows={3} /> : <input {...props} type="text" autoComplete="off" />}
        {picker && !disabled && (
          <button type="button" className="icon-button" aria-label={t(`Platzhalter einfügen in „${label}“`, `Insert a placeholder into “${label}”`)} aria-expanded={open} onClick={() => setOpen(!open)}>
            <BracketsCurly />
          </button>
        )}
      </div>
      {error && (
        <small className="wf-field-error" id={`${inputId}-error`}>
          {error}
        </small>
      )}
      {open && picker && <PlaceholderPicker ctx={picker} onPick={insert} onClose={() => (setOpen(false), field.current?.focus())} />}
    </div>
  );
}

// The picker: a search field and a list box (arrows, Enter, Esc).
export function PlaceholderPicker({ ctx, onPick, onClose }: { ctx: PickerContext; onPick: (stored: string) => void; onClose: () => void }) {
  const t = useStableT();
  const [query, setQuery] = useState("");
  const items = usePickerItems(ctx, query);
  const [active, setActive] = useState(0);
  const list = useId();
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => search.current?.focus(), []);
  useEffect(() => setActive(0), [query]);
  useEffect(() => document.getElementById(`${list}-${active}`)?.scrollIntoView({ block: "nearest" }), [active, list]);
  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((a) => Math.min(items.length - 1, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Enter" && items[active]) onPick(items[active].stored);
    else if (e.key === "Escape") onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  let group = "";
  return (
    <div className="wf-picker" role="dialog" aria-label={t("Platzhalter wählen", "Choose a placeholder")}>
      <input
        ref={search}
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls={list}
        aria-activedescendant={items[active] ? `${list}-${active}` : undefined}
        aria-label={t("Platzhalter suchen", "Search placeholders")}
        placeholder={t("Suchen …", "Search …")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={key}
      />
      <ul id={list} role="listbox" aria-label={t("Platzhalter", "Placeholders")}>
        {items.map((item, i) => {
          const head = item.group !== group;
          group = item.group;
          return (
            <li key={item.id} role="presentation">
              {head && (
                <div className="wf-picker-group" aria-hidden>
                  {item.group}
                </div>
              )}
              <div
                id={`${list}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "active" : ""}
                style={{ paddingInlineStart: 10 + item.depth * 14 }}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(item.stored)}
              >
                <span className="wf-picker-label">{item.label}</span>
                <span className="wf-picker-type">{t(TYPE_TEXT[item.type][0], TYPE_TEXT[item.type][1])}</span>
                {item.example && <span className="wf-picker-example">{item.example}</span>}
                <span className="sr-only">{` – ${item.group}`}</span>
              </div>
            </li>
          );
        })}
        {!items.length && (
          <li role="presentation" className="muted wf-picker-empty">
            {t("Nichts gefunden. Platzhalter gibt es von Knoten vor diesem.", "Nothing found. Placeholders come from the nodes before this one.")}
          </li>
        )}
      </ul>
      <p className="wf-picker-hint muted">{t("Filter hinter |, z. B. „| kürzen: 140“ oder „| datum: \"dd.MM.yyyy\"“", "Filters after |, e.g. “| truncate: 140” or “| date: \"yyyy-MM-dd\"”")}</p>
    </div>
  );
}
