"use client";
// The property bar under a page's title (issue #70): the page's tags as
// coloured chips (a click opens the tag view) and its properties, edited
// with the database cell editors (components/cell-input.tsx). Empty, it is
// one quiet line with "+ Tag" and "+ Eigenschaft" – and gone when the page
// cannot be edited (read mode, viewers).
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  CalendarBlank,
  CheckSquare,
  Clock,
  Hash,
  Link as LinkIcon,
  ListBullets,
  Plus,
  Tag as TagIcon,
  TextT,
  User as UserIcon,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { CellInput } from "./cell-input";
import { LinkValue } from "./link-cell";
import { Modal } from "./ui";
import { Select } from "./select";
import { safeCollisionPadding } from "./safe-area";
import { formatDateValue } from "@/lib/date-values";
import { isLinkField } from "@/lib/cell-links";
import {
  foldName,
  isComputedProperty,
  isEmptyValue,
  PAGE_PROPERTY_TYPES,
  type PageMeta,
  type PagePropertyDef,
  type PagePropertyType,
  type PageTag,
  type WorkspaceTaxonomy,
} from "@/lib/page-properties";
import type { Field, Page, User } from "@/lib/types";

type Act = (b: Record<string, unknown>) => Promise<unknown>;
type Member = Pick<User, "id" | "name"> & Partial<User>;

export const TYPE_ICONS: Record<PagePropertyType, Icon> = {
  text: TextT,
  number: Hash,
  date: CalendarBlank,
  select: ListBullets,
  multiselect: ListBullets,
  checkbox: CheckSquare,
  person: UserIcon,
  url: LinkIcon,
  email: LinkIcon,
  phone: LinkIcon,
  created_at: Clock,
  updated_at: Clock,
  created_by: UserIcon,
  updated_by: UserIcon,
};
export function typeLabel(type: PagePropertyType, t: (de: string, en: string) => string) {
  const labels: Record<PagePropertyType, string> = {
    text: t("Text", "Text"),
    number: t("Zahl", "Number"),
    date: t("Datum", "Date"),
    select: t("Auswahl", "Select"),
    multiselect: t("Mehrfachauswahl", "Multi-select"),
    checkbox: t("Kontrollkästchen", "Checkbox"),
    person: t("Person", "Person"),
    url: t("Webadresse", "URL"),
    email: t("E-Mail", "Email"),
    phone: t("Telefon", "Phone"),
    created_at: t("Erstellt am", "Created at"),
    updated_at: t("Geändert am", "Edited at"),
    created_by: t("Erstellt von", "Created by"),
    updated_by: t("Geändert von", "Edited by"),
  };
  return labels[type];
}

// A tag as a coloured chip; with `onOpen` a button to its view.
export function TagChip({ tag, onOpen, onRemove }: { tag: Pick<PageTag, "name" | "color">; onOpen?: () => void; onRemove?: () => void }) {
  const t = useT();
  return (
    <span className={`page-tag page-tag-${tag.color}`}>
      {onOpen ? (
        <button type="button" className="page-tag-name" onClick={onOpen} title={t(`Alle Seiten mit #${tag.name}`, `All pages with #${tag.name}`)}>
          {tag.name}
        </button>
      ) : (
        <span className="page-tag-name">{tag.name}</span>
      )}
      {onRemove && (
        <button type="button" className="page-tag-remove" aria-label={t(`Tag ${tag.name} entfernen`, `Remove tag ${tag.name}`)} onClick={onRemove}>
          <X size={11} weight="bold" />
        </button>
      )}
    </span>
  );
}

// The SQLite time of a page ("2026-11-01 09:30:00", UTC) for people.
const sqlTime = (value: string | null) => {
  if (!value) return "";
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

export function PagePropertyBar({
  page,
  taxonomy,
  meta,
  members,
  editable,
  act,
}: {
  page: Page;
  taxonomy: WorkspaceTaxonomy | undefined;
  meta: PageMeta | undefined;
  members: Member[];
  editable: boolean;
  act: Act;
}) {
  const t = useT();
  // Properties picked with "+ Eigenschaft" that have no value yet.
  const [added, setAdded] = useState<string[]>([]);
  const [tagging, setTagging] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    setAdded([]);
    setTagging(false);
  }, [page.id]);
  if (!taxonomy || !meta) return null;
  const tags = meta.tags.map((tid) => taxonomy.tags.find((x) => x.id === tid)).filter((x): x is PageTag => !!x);
  const shown = taxonomy.properties.filter((p) => isComputedProperty(p.type) || !isEmptyValue(meta.values[p.id]) || added.includes(p.id));
  const addable = taxonomy.properties.filter((p) => !shown.includes(p));
  if (!editable && !tags.length && !shown.length) return null;
  const addTag = (ref: string) => act({ action: "page.properties", pageId: page.id, addTags: [ref] });
  const removeTag = (tagId: string) => act({ action: "page.properties", pageId: page.id, removeTags: [tagId] });
  const setValue = (def: PagePropertyDef, value: unknown) => act({ action: "page.properties", pageId: page.id, values: { [def.id]: value } });
  const openTag = (tagId: string) => {
    location.hash = `tags/${tagId}`;
  };
  const empty = !tags.length && !shown.length;
  return (
    <section className={`page-properties${empty ? " empty" : ""}`} aria-label={t("Tags und Eigenschaften", "Tags and properties")}>
      {(tags.length > 0 || editable) && (
        <div className="page-properties-tags" role="group" aria-label={t("Tags", "Tags")}>
          {tags.length > 0 && <TagIcon size={15} className="page-properties-icon" aria-hidden />}
          {tags.map((tag) => (
            <TagChip
              key={tag.id}
              tag={tag}
              onOpen={() => openTag(tag.id)}
              onRemove={editable ? () => void removeTag(tag.id) : undefined}
            />
          ))}
          {editable &&
            (tagging ? (
              <TagPicker
                taxonomy={taxonomy}
                exclude={meta.tags}
                onPick={addTag}
                onClose={() => setTagging(false)}
              />
            ) : (
              <button type="button" className="page-properties-add" onClick={() => setTagging(true)}>
                <Plus size={13} aria-hidden /> {t("Tag", "Tag")}
              </button>
            ))}
          {editable && (addable.length > 0 || taxonomy.manage) && (
            <Dropdown.Root modal={false}>
              <Dropdown.Trigger asChild>
                <button type="button" className="page-properties-add">
                  <Plus size={13} aria-hidden /> {t("Eigenschaft", "Property")}
                </button>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown" align="start" sideOffset={4}>
                  {addable.map((def) => {
                    const TypeIcon = TYPE_ICONS[def.type];
                    return (
                      <Dropdown.Item key={def.id} className="dropdown-item" onSelect={() => setAdded((list) => [...list, def.id])}>
                        <TypeIcon size={15} aria-hidden />
                        {def.name}
                      </Dropdown.Item>
                    );
                  })}
                  {addable.length > 0 && taxonomy.manage && <Dropdown.Separator className="dropdown-separator" />}
                  {taxonomy.manage && (
                    <Dropdown.Item className="dropdown-item" onSelect={() => setCreating(true)}>
                      <Plus size={15} aria-hidden />
                      {t("Neue Eigenschaft …", "New property …")}
                    </Dropdown.Item>
                  )}
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          )}
        </div>
      )}
      {shown.length > 0 && (
        <dl className="page-properties-list">
          {shown.map((def) => (
            <PropertyRow
              key={def.id}
              def={def}
              value={meta.values[def.id]}
              meta={meta}
              members={members}
              editable={editable}
              onChange={(value) => setValue(def, value)}
              onRemove={() => {
                setAdded((list) => list.filter((x) => x !== def.id));
                if (!isEmptyValue(meta.values[def.id])) void setValue(def, null);
              }}
            />
          ))}
        </dl>
      )}
      {creating && (
        <PropertyDialog
          workspaceId={page.workspace_id}
          act={act}
          onClose={() => setCreating(false)}
          onSaved={(propertyId) => setAdded((list) => [...list, propertyId])}
        />
      )}
    </section>
  );
}

function PropertyRow({
  def,
  value,
  meta,
  members,
  editable,
  onChange,
  onRemove,
}: {
  def: PagePropertyDef;
  value: unknown;
  meta: PageMeta;
  members: Member[];
  editable: boolean;
  onChange: (value: unknown) => Promise<unknown>;
  onRemove: () => void;
}) {
  const t = useT();
  const TypeIcon = TYPE_ICONS[def.type];
  const labelId = useId();
  const computed = isComputedProperty(def.type);
  const name = (uid: string | null) => members.find((m) => m.id === uid)?.name ?? (uid ? t("Unbekannt", "Unknown") : "");
  const field: Field = { id: def.id, name: def.name, type: def.type, options: def.options };
  let shown: ReactNode;
  if (def.type === "created_at") shown = sqlTime(meta.info.createdAt);
  else if (def.type === "updated_at") shown = sqlTime(meta.info.updatedAt);
  else if (def.type === "created_by") shown = name(meta.info.createdBy);
  else if (def.type === "updated_by") shown = name(meta.info.updatedBy);
  else if (!editable) shown = <PropertyValue def={def} value={value} members={members} />;
  return (
    <div className={`page-property page-property-${def.type}`}>
      <dt id={labelId}>
        <TypeIcon size={14} aria-hidden />
        <span>{def.name}</span>
      </dt>
      <dd aria-labelledby={labelId}>
        {shown !== undefined ? (
          <span className="page-property-value">{shown || <span className="muted">{t("Leer", "Empty")}</span>}</span>
        ) : (
          <CellInput
            field={field}
            value={value ?? (def.type === "multiselect" ? [] : def.type === "checkbox" ? false : "")}
            members={members as User[]}
            related={{}}
            links={isLinkField(def.type)}
            placeholder={t("Leer", "Empty")}
            onChange={(next) => {
              const same = JSON.stringify(next ?? "") === JSON.stringify(value ?? "");
              return same ? undefined : onChange(next === "" ? null : next);
            }}
          />
        )}
        {editable && !computed && (
          <button type="button" className="icon-button page-property-remove" aria-label={t(`${def.name} entfernen`, `Remove ${def.name}`)} title={t("Entfernen", "Remove")} onClick={onRemove}>
            <X size={13} />
          </button>
        )}
      </dd>
    </div>
  );
}

// A value for reading (viewers, read mode).
function PropertyValue({ def, value, members }: { def: PagePropertyDef; value: unknown; members: Member[] }) {
  const t = useT();
  if (isEmptyValue(value)) return null;
  if (def.type === "checkbox") return <>{t("Ja", "Yes")}</>;
  if (def.type === "date") return <>{formatDateValue(value)}</>;
  if (def.type === "person") return <>{members.find((m) => m.id === value)?.name ?? t("Unbekannt", "Unknown")}</>;
  if (isLinkField(def.type)) return <LinkValue type={def.type as "url"} value={value} />;
  if (def.type === "select" || def.type === "multiselect")
    return (
      <span className="tags">
        {(Array.isArray(value) ? value : [value]).map((v) => (
          <span key={String(v)} className="tag">
            {String(v)}
          </span>
        ))}
      </span>
    );
  return <>{String(value)}</>;
}

// "+ Tag": an input that suggests the workspace's tags as one types; Enter
// picks the highlighted one or creates the typed tag (when allowed).
export function TagPicker({
  taxonomy,
  exclude,
  onPick,
  onClose,
}: {
  taxonomy: Pick<WorkspaceTaxonomy, "tags" | "createTags">;
  exclude: string[];
  onPick: (ref: string) => Promise<unknown> | unknown;
  onClose: () => void;
}) {
  const t = useT();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  useEffect(() => input.current?.focus(), []);
  const typed = query.replace(/^#+/, "").trim();
  const matches = useMemo(
    () => taxonomy.tags.filter((tag) => !exclude.includes(tag.id) && foldName(tag.name).includes(foldName(typed))).slice(0, 8),
    [taxonomy.tags, exclude, typed],
  );
  const exact = taxonomy.tags.some((tag) => foldName(tag.name) === foldName(typed));
  const options: { key: string; label: string; ref: string; tag?: PageTag }[] = [
    ...matches.map((tag) => ({ key: tag.id, label: tag.name, ref: tag.id, tag })),
    ...(typed && !exact && taxonomy.createTags ? [{ key: "new", label: t(`„${typed}“ anlegen`, `Create “${typed}”`), ref: typed }] : []),
  ];
  const pick = async (ref: string) => {
    setQuery("");
    setActive(0);
    await onPick(ref);
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = options[active];
      if (option) void pick(option.ref);
      else if (!typed) onClose();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Backspace" && !query) onClose();
  };
  return (
    <span className="tag-picker">
      <input
        ref={input}
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={options[active] ? `${listId}-${options[active].key}` : undefined}
        aria-label={t("Tag hinzufügen", "Add tag")}
        placeholder={taxonomy.createTags ? t("Tag suchen oder anlegen", "Find or create a tag") : t("Tag suchen", "Find a tag")}
        value={query}
        maxLength={60}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKey}
        onBlur={(e) => {
          // Clicks into the list keep it open (they come back to the input).
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setTimeout(onClose, 120);
        }}
      />
      {options.length > 0 && (
        <ul className="tag-picker-list" role="listbox" id={listId} aria-label={t("Tags", "Tags")}>
          {options.map((option, i) => (
            <li
              key={option.key}
              id={`${listId}-${option.key}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => void pick(option.ref)}
            >
              {option.tag ? <TagChip tag={option.tag} /> : <span className="tag-picker-new"><Plus size={13} aria-hidden /> {option.label}</span>}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

// A new or changed property definition (workspace owners).
export function PropertyDialog({
  workspaceId,
  def,
  act,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  def?: PagePropertyDef;
  act: Act;
  onClose: () => void;
  onSaved?: (propertyId: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(def?.name ?? ""),
    [type, setType] = useState<PagePropertyType>(def?.type ?? "text"),
    [options, setOptions] = useState((def?.options ?? []).join("\n")),
    [busy, setBusy] = useState(false);
  const choices = type === "select" || type === "multiselect";
  const save = async () => {
    setBusy(true);
    try {
      const result = (await act({
        action: "property.save",
        workspaceId,
        ...(def ? { propertyId: def.id } : {}),
        name,
        type,
        ...(choices ? { options: options.split(/\n|,/).map((o) => o.trim()).filter(Boolean) } : {}),
      })) as { id?: string } | null;
      if (result?.id) {
        onSaved?.(result.id);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open sheet title={def ? t("Eigenschaft bearbeiten", "Edit property") : t("Neue Eigenschaft", "New property")} onClose={onClose}>
      <form
        className="property-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="muted">
          {t(
            "Eigenschaften gelten für den ganzen Arbeitsbereich: Jede Seite kann einen Wert dafür haben.",
            "Properties apply to the whole workspace: every page can have a value for them.",
          )}
        </p>
        <label>
          <span>{t("Name", "Name")}</span>
          <input value={name} maxLength={80} required autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>{t("Typ", "Type")}</span>
          <Select aria-label={t("Typ", "Type")} value={type} onChange={(e) => setType(e.target.value as PagePropertyType)}>
            {PAGE_PROPERTY_TYPES.map((value) => (
              <option key={value} value={value}>
                {typeLabel(value, t)}
              </option>
            ))}
          </Select>
        </label>
        {def && def.type !== type && (
          <p className="muted" role="note">
            {t("Werte, die nicht zum neuen Typ passen, werden entfernt.", "Values that do not fit the new type are removed.")}
          </p>
        )}
        {choices && (
          <label>
            <span>{t("Optionen (eine je Zeile)", "Options (one per line)")}</span>
            <textarea rows={5} value={options} onChange={(e) => setOptions(e.target.value)} />
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {t("Speichern", "Save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
