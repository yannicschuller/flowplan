"use client";
import { choiceChipClass, optionColor } from "@/lib/option-colors";
import { useT } from "./i18n";
import { Select } from "./select";
import { useState, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { InlineText } from "./inline-text";
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
import { useSprints } from "./sprint-context";
import { aliasList } from "@/lib/aliases";
import { isLinkField } from "@/lib/cell-links";
import { LinkInput } from "./link-cell";
import { TagCellInput } from "./tag-cell-input";
import { PageIcon } from "./ui";
export type CellFile = { url: string; name: string; mime: string };
// The editor of formatted text (#126) loads with the first text cell that
// is edited (TipTap is shared with the comment composer's chunk). Without a
// connection it may not load (no offline copy on this device): the cell then
// takes the plain text field instead of taking the whole view down, and the
// next edit tries again.
const loadRichTextEditor = () => import("./rich-text-editor");
let richTextEditor: Awaited<ReturnType<typeof loadRichTextEditor>>["default"] | null = null;
function useRichTextEditor(wanted: boolean) {
  const [editor, setEditor] = useState(() => richTextEditor);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!wanted || editor) return;
    let live = true;
    loadRichTextEditor().then(
      (m) => {
        richTextEditor = m.default;
        if (live) setEditor(() => m.default);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [wanted, editor]);
  return { editor, failed };
}
// The label around a CellInput – or, for a date, a group that looks the same:
// a <label> passes taps on the date's buttons ("Datum entfernen", the time
// switch) to the date input in WebKit, which opens the picker instead.
// Tag-backed multi-selects (chips with remove buttons) are no <label> either:
// a tap on "+ Tag" would remove the first tag.
export function FieldLabel({ field, children }: { field: Pick<Field, "type" | "tagOptions">; children: ReactNode }) {
  return field.type === "date" || (field.type === "multiselect" && field.tagOptions) ? <div className="field-group">{children}</div> : <label>{children}</label>;
}
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
  placeholder,
  links = false,
  editing,
  onCancel,
  formatted,
  multiline = false,
}: {
  // A formatted text property (#126, lib/inline-markdown.ts) edited with
  // its formatting. Left out for the title, page properties and forms
  // (answers are plain text; the server escapes them).
  formatted?: boolean;
  // Rich text: Enter makes a line break (the record) instead of ending the
  // edit (a table cell).
  multiline?: boolean;
  // Link properties (url, email, phone) as links with a pencil to edit
  // (records, list editors, table cells); forms keep the plain input.
  links?: boolean;
  // With links: open in the input, focused (a table cell that was clicked).
  editing?: boolean;
  // With links: the edit ended without a change (Escape and the like).
  onCancel?: () => void;
  // Uploads a file to the database page and returns its URL.
  upload?: (file: File) => Promise<string>;
  files?: CellFile[];
  // Text fields: what an empty field says (default "Empty", as in a table).
  placeholder?: string;
  commit?: "change" | "blur";
  field: Field;
  value: unknown;
  members: User[];
  related: Record<string, Row[]>;
  disabled?: boolean;
  onChange: (v: unknown) => void | Promise<unknown>;
}) {
  const t = useT();
  const sprints = useSprints();
  const rich = useRichTextEditor(f.type === "text" && !!formatted);
  const [draft, setDraft] = useState(cellText(value));
  // What was typed into a plain field (commit "blur") and not saved yet.
  const unsaved = useRef<{ value: unknown } | null>(null);
  useEffect(() => {
    setDraft(cellText(value));
    unsaved.current = null;
  }, [value]);
  // Plain fields saved on blur: Enter saves too and, without a change, ends
  // the edit (a table cell closes) – as in the other cell editors.
  const enterSaves = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || commit !== "blur" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.currentTarget.blur();
    if (draft === cellText(value)) onCancel?.();
  };
  // They also save when they unmount: a record closed with Escape or a
  // click outside removes the field without a blur.
  const latestChange = useRef(onChange);
  useEffect(() => {
    latestChange.current = onChange;
  });
  useEffect(
    () => () => {
      if (unsaved.current) void latestChange.current(unsaved.current.value);
    },
    [],
  );
  const blurred = (v: unknown) => {
    unsaved.current = null;
    if (commit === "blur") onChange(v);
  };
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
            aria-label={n === 1 ? t("1 Stern", "1 star") : t(`${n} Sterne`, `${n} stars`)}
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
        single={!!f.parent}
        onChange={onChange}
      />
    );
  }
  if (f.type === "sprint")
    return (
      <Select aria-label={f.name} disabled={disabled} value={cellText(value)} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("Backlog (kein Sprint)", "Backlog (no sprint)")}</option>
        {sprints
          .filter((s) => s.state !== "closed" || s.id === value)
          .map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.state === "active" ? t(" (läuft)", " (active)") : ""}
            </option>
          ))}
      </Select>
    );
  if (["select", "person"].includes(f.type)) {
    const options =
      f.type === "person"
        ? members.map((u) => ({ id: u.id, name: u.name }))
        : (f.options || []).map((s) => ({ id: s, name: s }));
    return (
      <Select
        aria-label={f.name}
        disabled={disabled}
        value={cellText(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t("Auswählen …", "Select …")}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
    );
  }
  // The workspace's tags as options (#79).
  if (f.type === "multiselect" && f.tagOptions)
    return <TagCellInput field={f} value={value} disabled={disabled} onChange={onChange} />;
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
            {/* A coloured option as its chip (#242). */}
            {optionColor(f, o) ? <span className={choiceChipClass(f, o)}>{o}</span> : o}
          </label>
        ))}
      </div>
    );
  // Aliases: other names, separated by commas.
  if (f.type === "aliases")
    return (
      <input
        aria-label={f.name}
        disabled={disabled}
        value={draft}
        placeholder={placeholder ?? t("z. B. PAC, Pompe à chaleur", "e.g. PAC, heat pump")}
        title={t("Andere Namen, durch Kommas getrennt – @-Erwähnungen und die Suche finden den Eintrag auch darüber.", "Other names, separated by commas – @ mentions and search find the record by them too.")}
        onChange={(e) => {
          setDraft(e.target.value);
          if (commit === "change") onChange(aliasList(e.target.value));
          else unsaved.current = { value: aliasList(e.target.value) };
        }}
        onKeyDown={enterSaves}
        onBlur={() => blurred(aliasList(draft))}
      />
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
            placeholder={t("Punkt hinzufügen, dann Enter", "Add an item, then Enter")}
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
  if (f.type === "text" && formatted && !rich.failed)
    return rich.editor ? (
      <rich.editor
        value={typeof value === "string" ? value : cellText(value)}
        label={f.name}
        placeholder={placeholder ?? t("Leer", "Empty")}
        disabled={disabled}
        commit={commit}
        multiline={multiline}
        autoFocus={!!editing}
        onChange={onChange}
        onCancel={onCancel}
      />
    ) : (
      <span className="rich-text-input loading">
        <InlineText value={value} links={false} />
      </span>
    );
  if (links && isLinkField(f.type))
    return (
      <LinkInput
        type={f.type}
        name={f.name}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        editing={editing}
        onChange={onChange}
        onCancel={onCancel}
      />
    );
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
              : f.type === "phone"
                ? "tel"
                : "text"
      }
      step={f.type === "number" ? "any" : undefined}
      disabled={disabled}
      value={draft}
      placeholder={placeholder ?? t("Leer", "Empty")}
      onChange={(e) => {
        setDraft(e.target.value);
        const next =
          f.type === "number"
            ? e.target.value === ""
              ? null
              : Number(e.target.value)
            : e.target.value;
        if (commit === "change") onChange(next);
        else unsaved.current = { value: next };
      }}
      onKeyDown={enterSaves}
      onBlur={() =>
        blurred(
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
  single = false,
  onChange,
}: {
  name: string;
  rows?: Row[];
  value: string[];
  disabled?: boolean;
  // One record only (parent record of subtasks).
  single?: boolean;
  onChange: (value: string[]) => void | Promise<unknown>;
}) {
  const t = useT();
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
        aria-label={t(`${name}: Einträge suchen`, `${name}: search records`)}
        placeholder={t("Einträge suchen …", "Search records …")}
        value={query}
        disabled={disabled || pending || !rows}
        onChange={(e) => {
          setQuery(e.target.value);
          setLimit(50);
        }}
      />
      <small>
        {selection.length} {t("ausgewählt", "selected")}
        {rows
          ? ` · ${filtered.length} ${t("Treffer", filtered.length === 1 ? "match" : "matches")}`
          : t(" · Datenbank nicht zugänglich", " · database not accessible")}
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
                    ? single
                      ? [r.id]
                      : [...selection, r.id]
                    : selection.filter((v) => v !== r.id),
                )
              }
            />
            {/* The record's own icon, as in the relation cell (#190). */}
            {r.icon && <PageIcon name={r.icon} size={15} className="relation-icon" />}
            {cellText(r.cells.title) || t("Ohne Titel", "Untitled")}
          </label>
        ))}
        {rows && !filtered.length && (
          <p className="muted">{t("Keine passenden Einträge.", "No matching records.")}</p>
        )}
      </div>
      {filtered.length > limit && (
        <button
          className="button"
          type="button"
          onClick={() => setLimit(limit + 50)}
        >
          {t("Weitere Einträge anzeigen", "Show more records")}
        </button>
      )}
      {selection.length > 0 && (
        <button
          className="button"
          type="button"
          disabled={disabled || pending || !rows}
          onClick={() => change([])}
        >
          {t("Auswahl leeren", "Clear selection")}
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
  const t = useT();
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
      setError(t("Bitte einen vollständigen http(s)-Link eingeben.", "Please enter a complete http(s) link."));
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
                  aria-label={t(`${fileLabel(url, names)} entfernen`, `Remove ${fileLabel(url, names)}`)}
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
              {busy ? t("Wird hochgeladen …", "Uploading …") : t("Datei hochladen", "Upload file")}
              <input
                type="file"
                multiple
                hidden
                disabled={busy}
                aria-label={t(`${name}: Datei hochladen`, `${name}: upload file`)}
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
            aria-label={t(`${name}: Link einfügen`, `${name}: insert link`)}
            placeholder={t("Link einfügen (https://…)", "Insert link (https://…)")}
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
            {t("Hinzufügen", "Add")}
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
