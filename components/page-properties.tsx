"use client";
// The property bar under a page's title (issue #70): the page's tags as
// coloured chips (a click opens the tag view) and its properties, edited
// with the database cell editors (components/cell-input.tsx). Empty, it is
// one quiet line with "+ Tag" and "+ Eigenschaft" – and gone when the page
// cannot be edited (read mode, viewers).
//
// Collapsible (#83): a chevron folds the bar into one line – a few tags as
// small chips, "+3" for the rest, and "5 Eigenschaften" – that opens it
// again. The person's choice is stored per page in their account
// (lib/page-view-prefs.ts, command page.collapseProperties); without one the
// bar starts collapsed when the page shows more than four properties
// (lib/page-properties.ts isBarCollapsed), decided when the page opens so it
// never folds away while one is filling it in.
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  CalendarBlank,
  CaretRight,
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
import { Modal, api } from "./ui";
import { Select } from "./select";
import { safeCollisionPadding } from "./safe-area";
import { formatDateValue } from "@/lib/date-values";
import { appCache, pageKey } from "@/lib/swr-cache";
import { isLinkField } from "@/lib/cell-links";
import {
  foldName,
  isBarCollapsed,
  isComputedProperty,
  isEmptyValue,
  PAGE_PROPERTY_TYPES,
  propertyCountLabel,
  SUMMARY_TAGS,
  SUMMARY_TAGS_NARROW,
  summaryTags,
  visibleProperties,
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

// Choices made in this tab, ahead of page data that may still be cached
// from before (switching pages back and forth, offline).
const sessionChoices = new Map<string, boolean>();

// Phones get fewer chips in the collapsed line.
const NARROW = "(max-width: 600px)";
function useNarrow() {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia?.(NARROW);
      query?.addEventListener("change", onChange);
      return () => query?.removeEventListener("change", onChange);
    },
    () => !!window.matchMedia?.(NARROW).matches,
    () => false,
  );
}

export function PagePropertyBar({
  page,
  taxonomy,
  meta,
  collapsedChoice,
  members,
  editable,
  act,
}: {
  page: Page;
  taxonomy: WorkspaceTaxonomy | undefined;
  meta: PageMeta | undefined;
  // The person's stored choice (#83); null: none, the default applies.
  collapsedChoice?: boolean | null;
  members: Member[];
  editable: boolean;
  act: Act;
}) {
  const t = useT();
  const bodyId = useId();
  const narrow = useNarrow();
  // Properties picked with "+ Eigenschaft" that have no value yet.
  const [added, setAdded] = useState<string[]>([]);
  const [tagging, setTagging] = useState(false);
  const [creating, setCreating] = useState(false);
  // Collapsed or not, for the open page: decided once when it opens (null
  // until the data is there); `moved` only after a toggle, so opening a
  // page never animates. `choice` is the stored choice it was decided
  // from: page data shown from the kept copy first may carry an older one – the fresh one
  // decides again, unless the person toggled meanwhile.
  const [fold, setFold] = useState<{ pageId: string; collapsed: boolean | null; moved: boolean; choice?: boolean | null }>({
    pageId: page.id,
    collapsed: null,
    moved: false,
  });
  const summaryRef = useRef<HTMLButtonElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<"summary" | "chevron" | null>(null);
  useEffect(() => {
    setAdded([]);
    setTagging(false);
  }, [page.id]);
  useEffect(() => {
    const target = focusAfter.current === "summary" ? summaryRef.current : focusAfter.current === "chevron" ? chevronRef.current : null;
    focusAfter.current = null;
    target?.focus();
  }, [fold.collapsed]);
  const ready = !!taxonomy && !!meta;
  const visibleCount = ready ? visibleProperties(taxonomy.properties, meta.values).length : 0;
  const stored = sessionChoices.get(page.id) ?? collapsedChoice ?? null;
  if (fold.pageId !== page.id) setFold({ pageId: page.id, collapsed: null, moved: false });
  else if (ready && (fold.collapsed === null || (!fold.moved && fold.choice !== stored)))
    setFold({ ...fold, collapsed: isBarCollapsed(stored, visibleCount), choice: stored });
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
  // Only a bar with something in it folds; an empty one is a single line.
  const collapsible = !empty;
  const collapsed = collapsible && fold.pageId === page.id && fold.collapsed === true;
  const toggle = () => {
    const next = !collapsed;
    sessionChoices.set(page.id, next);
    focusAfter.current = next ? "summary" : "chevron";
    setFold({ pageId: page.id, collapsed: next, moved: true, choice: next });
    if (!next) setTagging(false);
    // The kept copy of the page (lib/swr-cache.ts) opens it the same way
    // next time, before the fresh data is there.
    const cache = appCache();
    const kept = cache.get<Record<string, unknown>>(pageKey(page.id));
    if (kept)
      cache.set(pageKey(page.id), { ...kept.value, propertiesCollapsed: next }, { version: kept.version, policy: kept.persist ? "persist" : "memory" });
    // Stored in the account; a failure (offline) keeps it for this tab.
    void api("/api/command", { action: "page.collapseProperties", pageId: page.id, collapsed: next }).catch(() => {});
  };
  const summary = summaryTags(tags, narrow ? SUMMARY_TAGS_NARROW : SUMMARY_TAGS);
  const count = propertyCountLabel(shown.length, t);
  const label = t("Tags und Eigenschaften", "Tags and properties");
  return (
    <section
      className={`page-properties${empty ? " empty" : ""}${collapsible ? " collapsible" : ""}${collapsed ? " collapsed" : ""}${fold.moved ? " animated" : ""}`}
      aria-label={label}
    >
      {collapsed && (
        <button
          ref={summaryRef}
          type="button"
          className="page-properties-summary"
          aria-expanded={false}
          aria-controls={bodyId}
          title={t("Tags und Eigenschaften ausklappen", "Expand tags and properties")}
          onClick={toggle}
        >
          <CaretRight size={13} weight="bold" className="page-properties-caret" aria-hidden />
          <span className="sr-only">{t("Ausklappen:", "Expand:")} </span>
          {summary.shown.map((tag) => (
            <span key={tag.id} className={`page-tag page-tag-small page-tag-${tag.color}`}>
              <span className="page-tag-name">{tag.name}</span>
            </span>
          ))}
          {summary.more > 0 && (
            <span className="page-properties-more">
              <span aria-hidden>+{summary.more}</span>
              <span className="sr-only">{summary.more === 1 ? t("1 weiterer Tag", "1 more tag") : t(`${summary.more} weitere Tags`, `${summary.more} more tags`)}</span>
            </span>
          )}
          {count && (
            <span className="page-properties-count">
              {tags.length > 0 && <span aria-hidden>· </span>}
              {count}
            </span>
          )}
        </button>
      )}
      <div className="page-properties-body" id={bodyId} inert={collapsed}>
        <div className="page-properties-inner">
          {(tags.length > 0 || editable || collapsible) && (
            <div className="page-properties-head">
              {collapsible && (
                <button
                  ref={chevronRef}
                  type="button"
                  className="icon-button page-properties-toggle"
                  aria-expanded={!collapsed}
                  aria-controls={bodyId}
                  aria-label={t("Tags und Eigenschaften einklappen", "Collapse tags and properties")}
                  title={t("Einklappen", "Collapse")}
                  onClick={toggle}
                >
                  <CaretRight size={13} weight="bold" className="page-properties-caret" aria-hidden />
                </button>
              )}
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
        </div>
      </div>
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
