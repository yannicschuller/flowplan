"use client";
import { useState, useEffect } from "react";
import DateInput from "./date-input";
import { cellText } from "@/lib/database";
import type { Field, Row, User } from "@/lib/types";
export function CellInput({
  field: f,
  value,
  members,
  related,
  disabled,
  onChange,
  commit = "blur",
}: {
  commit?: "change" | "blur";
  field: Field;
  value: unknown;
  members: User[];
  related: Record<string, Row[]>;
  disabled?: boolean;
  onChange: (v: unknown) => void | Promise<unknown>;
}) {
  const [draft, setDraft] = useState(cellText(value));
  useEffect(() => setDraft(cellText(value)), [value]);
  if (f.type === "date")
    return (
      <DateInput
        name={f.name}
        value={value}
        disabled={disabled}
        onChange={onChange}
        commit={commit}
      />
    );
  if (f.type === "checkbox")
    return (
      <input
        type="checkbox"
        aria-label={f.name}
        disabled={disabled}
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  if (f.type === "relation") {
    return (
      <RelationPicker
        key={f.id}
        name={f.name}
        rows={related[f.relationPage || ""]}
        value={Array.isArray(value) ? (value as string[]) : []}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }
  if (["select", "person"].includes(f.type)) {
    const options =
      f.type === "person"
        ? members.map((u) => ({ id: u.id, name: u.name }))
        : (f.options || []).map((s) => ({ id: s, name: s }));
    return (
      <select
        aria-label={f.name}
        disabled={disabled}
        value={cellText(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Auswählen …</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  if (f.type === "multiselect")
    return (
      <div className="multi-options">
        {(f.options || []).map((o) => (
          <label className="checkbox-label" key={o}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={Array.isArray(value) && value.includes(o)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...(Array.isArray(value) ? value : []), o]
                    : (Array.isArray(value) ? value : []).filter(
                        (s) => s !== o,
                      ),
                )
              }
            />
            {o}
          </label>
        ))}
      </div>
    );
  if (f.type === "checklist") {
    const items = Array.isArray(value)
      ? (value as { text: string; done: boolean }[])
      : [];
    return (
      <div className="cell-checklist">
        {items.map((item, i) => (
          <label className="checkbox-label" key={i}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={item.done}
              onChange={(e) =>
                onChange(
                  items.map((x, j) =>
                    i === j ? { ...x, done: e.target.checked } : x,
                  ),
                )
              }
            />
            {item.text}
          </label>
        ))}
        {!disabled && (
          <input
            placeholder="Punkt hinzufügen, dann Enter"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.currentTarget.value)
                  onChange([
                    ...items,
                    { text: e.currentTarget.value, done: false },
                  ]);
                e.currentTarget.value = "";
              }
            }}
          />
        )}
      </div>
    );
  }
  return (
    <input
      aria-label={f.name}
      type={
        f.type === "number"
          ? "number"
          : f.type === "email"
            ? "email"
            : f.type === "url"
              ? "url"
              : "text"
      }
      step={f.type === "number" ? "any" : undefined}
      disabled={disabled}
      value={draft}
      placeholder={f.type === "files" ? "Datei-URL" : "Leer"}
      onChange={(e) => {
        setDraft(e.target.value);
        if (commit === "change")
          onChange(
            f.type === "number"
              ? e.target.value === ""
                ? null
                : Number(e.target.value)
              : e.target.value,
          );
      }}
      onBlur={() =>
        commit === "blur" &&
        onChange(
          f.type === "number" ? (draft === "" ? null : Number(draft)) : draft,
        )
      }
    />
  );
}

function RelationPicker({
  name,
  rows,
  value,
  disabled,
  onChange,
}: {
  name: string;
  rows?: Row[];
  value: string[];
  disabled?: boolean;
  onChange: (value: string[]) => void | Promise<unknown>;
}) {
  const [query, setQuery] = useState(""),
    [limit, setLimit] = useState(50);
  const [selection, setSelection] = useState(value),
    [pending, setPending] = useState(false);
  useEffect(() => setSelection(value), [value]);
  async function change(next: string[]) {
    setSelection(next);
    setPending(true);
    try {
      const result = await onChange(next);
      if (result === null || result === false) setSelection(value);
    } catch {
      setSelection(value);
    } finally {
      setPending(false);
    }
  }
  const filtered = (rows || []).filter((r) =>
    cellText(r.cells.title)
      .toLocaleLowerCase("de")
      .includes(query.toLocaleLowerCase("de")),
  );
  return (
    <div className="relation-picker">
      <input
        type="search"
        aria-label={`${name}: Einträge suchen`}
        placeholder="Einträge suchen …"
        value={query}
        disabled={disabled || pending || !rows}
        onChange={(e) => {
          setQuery(e.target.value);
          setLimit(50);
        }}
      />
      <small>
        {selection.length} ausgewählt
        {rows
          ? ` · ${filtered.length} Treffer`
          : " · Datenbank nicht zugänglich"}
      </small>
      <div className="relation-options">
        {filtered.slice(0, limit).map((r) => (
          <label className="checkbox-label" key={r.id}>
            <input
              type="checkbox"
              disabled={disabled || pending}
              checked={selection.includes(r.id)}
              onChange={(e) =>
                change(
                  e.target.checked
                    ? [...selection, r.id]
                    : selection.filter((v) => v !== r.id),
                )
              }
            />
            {cellText(r.cells.title) || "Ohne Titel"}
          </label>
        ))}
        {rows && !filtered.length && (
          <p className="muted">Keine passenden Einträge.</p>
        )}
      </div>
      {filtered.length > limit && (
        <button
          className="button"
          type="button"
          onClick={() => setLimit(limit + 50)}
        >
          Weitere Einträge anzeigen
        </button>
      )}
      {selection.length > 0 && (
        <button
          className="button"
          type="button"
          disabled={disabled || pending || !rows}
          onClick={() => change([])}
        >
          Auswahl leeren
        </button>
      )}
    </div>
  );
}
