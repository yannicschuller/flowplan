"use client";
import { useState, useEffect } from "react";
import { ratingMax } from "@/lib/field-format";
import DateInput from "./date-input";
import { cellText } from "@/lib/database";
import {
  fileIdOf,
  fileLabel,
  fileRefSchema,
  fileUrls,
  MAX_CELL_FILES,
} from "@/lib/file-cells";
import type { Field, Row, User } from "@/lib/types";
export type CellFile = { url: string; name: string; mime: string };
export function CellInput({
  field: f,
  value,
  members,
  related,
  disabled,
  onChange,
  commit = "blur",
  upload,
  files = [],
}: {
  // Uploads a file to the database page and returns its URL.
  upload?: (file: File) => Promise<string>;
  files?: CellFile[];
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
  if (f.type === "number" && f.rollupDisplay === "rating") {
    const max = ratingMax(f),
      current = typeof value === "number" ? value : 0;
    return (
      <span className="rating-input" role="radiogroup" aria-label={f.name}>
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={current === n}
            aria-label={`${n} ${n === 1 ? "Stern" : "Sterne"}`}
            className={n <= current ? "on" : ""}
            disabled={disabled}
            // Choosing the current rating again clears it.
            onClick={() => void onChange(current === n ? null : n)}
          >
            ★
          </button>
        ))}
      </span>
    );
  }
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
  if (f.type === "files")
    return (
      <FilesInput
        name={f.name}
        value={value}
        disabled={disabled}
        upload={upload}
        files={files}
        onChange={onChange}
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
      placeholder="Leer"
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

function FilesInput({
  name,
  value,
  disabled,
  upload,
  files,
  onChange,
}: {
  name: string;
  value: unknown;
  disabled?: boolean;
  upload?: (file: File) => Promise<string>;
  files: CellFile[];
  onChange: (v: unknown) => void | Promise<unknown>;
}) {
  const urls = fileUrls(value);
  const [link, setLink] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const names = new Map(files.map((file) => [file.url, file.name]));
  const image = (url: string) =>
    files.find((file) => file.url === url)?.mime.startsWith("image/") ||
    (!fileIdOf(url) && /\.(png|jpe?g|gif|webp|avif)$/i.test(url));
  const full = urls.length >= MAX_CELL_FILES;
  async function add() {
    const parsed = fileRefSchema.safeParse(link.trim());
    if (!parsed.success) {
      setError("Bitte einen vollständigen http(s)-Link eingeben.");
      return;
    }
    setError("");
    setLink("");
    if (!urls.includes(parsed.data)) await onChange([...urls, parsed.data]);
  }
  return (
    <div className="files-input" role="group" aria-label={name}>
      {urls.length > 0 && (
        <ul>
          {urls.map((url) => (
            <li key={url}>
              {image(url) && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt="" className="file-thumb" />
              )}
              <a href={url} target="_blank" rel="noreferrer noopener">
                {fileLabel(url, names)}
              </a>
              {!disabled && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`${fileLabel(url, names)} entfernen`}
                  onClick={() => onChange(urls.filter((u) => u !== url))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && !full && (
        <div className="files-actions">
          {upload && (
            <label className="button compact">
              {busy ? "Wird hochgeladen …" : "Datei hochladen"}
              <input
                type="file"
                multiple
                hidden
                disabled={busy}
                aria-label={`${name}: Datei hochladen`}
                onChange={async (event) => {
                  const chosen = [...(event.target.files || [])].slice(
                    0,
                    MAX_CELL_FILES - urls.length,
                  );
                  event.target.value = "";
                  if (!chosen.length) return;
                  setBusy(true);
                  setError("");
                  const added: string[] = [];
                  try {
                    for (const file of chosen) added.push(await upload(file));
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                  if (added.length) await onChange([...urls, ...added]);
                }}
              />
            </label>
          )}
          <input
            type="url"
            aria-label={`${name}: Link einfügen`}
            placeholder="Link einfügen (https://…)"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
          />
          <button
            type="button"
            className="button compact"
            disabled={!link.trim()}
            onClick={() => void add()}
          >
            Hinzufügen
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
