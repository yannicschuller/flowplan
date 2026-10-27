"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Columns,
  Funnel,
  MagnifyingGlass,
  Plus,
  Rows,
  SlidersHorizontal,
  SortAscending,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Select } from "./select";
import { ChipPopover } from "./chip-popover";
import {
  FilterConditionFields,
  newFilterCondition,
  useTimeZones,
} from "./database-filter-editor";
import { useFilterClock } from "./use-filter-clock";
import { hasClockFormulas } from "@/lib/formula";
import { queryRows } from "@/lib/database";
import {
  effectiveFilterGroup,
  filterCount,
  filterGroupSchema,
  hasRelativeFilters,
  MAX_FILTER_NODES,
} from "@/lib/database-filters";
import { canGroupField } from "@/lib/database-groups";
import {
  filterChipLabel,
  groupChipLabel,
  hasNestedFilterGroups,
  propertiesChipLabel,
  sortChipLabel,
} from "@/lib/view-toolbar";
import type { Field, Filter, FilterGroup, Row, User, View } from "@/lib/types";

type GroupSettings = NonNullable<View["groupSettings"]>;

// The chips of a database view: filter, sort, group, properties and search.
// Each chip opens a small panel below it that applies changes at once; the
// view settings dialog keeps what does not fit a chip (name, columns, …).
export function DatabaseToolbarChips({
  view,
  fields,
  rows,
  related,
  relatedSchemas,
  members,
  editable,
  groupSettings,
  updateView,
  saveFilters,
  onAdvancedFilters,
  onConfigure,
  query,
  onQuery,
}: {
  view: View;
  fields: Field[];
  rows: Row[];
  related: Record<string, Row[]>;
  relatedSchemas?: Record<string, Field[]>;
  members: Pick<User, "id" | "name">[];
  editable: boolean;
  groupSettings: GroupSettings;
  updateView: (patch: Partial<View>) => Promise<unknown>;
  saveFilters: (group: FilterGroup) => Promise<unknown>;
  onAdvancedFilters: () => void;
  onConfigure: () => void;
  query: string;
  onQuery: (query: string) => void;
}) {
  const t = useT();
  const filter = filterChipLabel(view, t),
    sort = sortChipLabel(view, fields, t),
    group = groupChipLabel(view, fields, t),
    properties = propertiesChipLabel(view, fields, t);
  const groupable = ["table", "list", "board"].includes(view.type);
  const propertiesShown = ["table", "board", "gallery", "list", "calendar", "timeline"].includes(view.type);
  const name = (base: string, chip: { label: string; active: boolean }) =>
    chip.active ? `${base} · ${chip.label}` : base;
  return (
    <>
      <ChipPopover
        icon={<Funnel size={15} />}
        label={filter.label}
        name={name(t("Filtern", "Filter"), filter)}
        active={filter.active}
        panelLabel={t("Filter", "Filters")}
        panelClassName="chip-popover-filter"
      >
        <FilterChipBody
          view={view}
          fields={fields}
          rows={rows}
          related={related}
          relatedSchemas={relatedSchemas}
          members={members}
          editable={editable}
          save={saveFilters}
          onAdvanced={onAdvancedFilters}
        />
      </ChipPopover>
      <ChipPopover
        icon={<SortAscending size={15} />}
        label={sort.label}
        name={name(t("Sortieren", "Sort"), sort)}
        active={sort.active}
        panelLabel={t("Sortierung", "Sorting")}
      >
        <SortChipBody view={view} fields={fields} editable={editable} updateView={updateView} />
      </ChipPopover>
      {groupable && (
        <ChipPopover
          icon={<Rows size={15} />}
          label={group.label}
          name={name(t("Gruppieren", "Group||action"), group)}
          active={group.active}
          panelLabel={t("Gruppierung", "Grouping")}
        >
          <GroupChipBody
            view={view}
            fields={fields}
            editable={editable}
            groupSettings={groupSettings}
            updateView={updateView}
            onConfigure={onConfigure}
          />
        </ChipPopover>
      )}
      {propertiesShown && (
        <ChipPopover
          icon={<Columns size={15} />}
          label={properties.label}
          name={name(t("Eigenschaften", "Properties"), properties)}
          active={properties.active}
          panelLabel={t("Sichtbare Eigenschaften", "Visible properties")}
        >
          <PropertiesChipBody view={view} fields={fields} editable={editable} updateView={updateView} onConfigure={onConfigure} />
        </ChipPopover>
      )}
      <SearchChip query={query} onQuery={onQuery} />
      <button
        type="button"
        className="toolbar-chip toolbar-chip-icon"
        title={t("Ansicht und Eigenschaften", "View and properties")}
        aria-label={t("Ansicht und Eigenschaften", "View and properties")}
        onClick={onConfigure}
      >
        <SlidersHorizontal size={16} />
      </button>
    </>
  );
}

// Filters: one flat list of conditions, saved shortly after each change.
// Nested groups (AND inside OR) belong to the full editor.
function FilterChipBody({
  view,
  fields,
  rows,
  related,
  relatedSchemas,
  members,
  editable,
  save,
  onAdvanced,
}: {
  view: View;
  fields: Field[];
  rows: Row[];
  related: Record<string, Row[]>;
  relatedSchemas?: Record<string, Field[]>;
  members: Pick<User, "id" | "name">[];
  editable: boolean;
  save: (group: FilterGroup) => Promise<unknown>;
  onAdvanced: () => void;
}) {
  const t = useT();
  const remote = JSON.stringify(effectiveFilterGroup(view));
  const [draft, setDraft] = useState<FilterGroup>(() => JSON.parse(remote));
  const dirty = useRef(false),
    latest = useRef(draft),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    saveRef = useRef(save);
  saveRef.current = save;
  // The view changed elsewhere: shown unless a change of ours is pending.
  useEffect(() => {
    if (!dirty.current) {
      const next = JSON.parse(remote) as FilterGroup;
      latest.current = next;
      setDraft(next);
    }
  }, [remote]);
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    const next = latest.current;
    if (!filterGroupSchema.safeParse(next).success) return;
    dirty.current = false;
    void saveRef.current(next);
  };
  // Closing the panel saves what is still pending.
  useEffect(() => flush, []);
  const change = (next: FilterGroup) => {
    latest.current = next;
    dirty.current = true;
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  };
  const zones = useTimeZones();
  const filterNow = useFilterClock(
    hasRelativeFilters(draft) || hasClockFormulas(fields, relatedSchemas),
  );
  const preview = useMemo(
    () =>
      queryRows(
        rows,
        fields,
        { ...view, filters: [], filterGroup: draft },
        "",
        related,
        relatedSchemas,
        new Date(filterNow),
      ).length,
    [rows, fields, view, draft, related, relatedSchemas, filterNow],
  );
  const conditions = draft.rules.filter(
    (rule): rule is Filter & { kind: "condition" } => rule.kind === "condition",
  );
  const valid = filterGroupSchema.safeParse(draft).success;
  if (hasNestedFilterGroups(draft))
    return (
      <div className="chip-panel">
        <p className="muted">
          {t(`${filterCount(draft)} Bedingungen in verschachtelten Gruppen – diese Ansicht wird im erweiterten Editor gefiltert.`, `${filterCount(draft)} conditions in nested groups – this view is filtered in the advanced editor.`)}
        </p>
        <div className="chip-panel-actions">
          <button type="button" className="button compact" onClick={onAdvanced}>
            {t("Erweitert …", "Advanced …")}
          </button>
          {editable && (
            <button
              type="button"
              className="text-button danger"
              onClick={() => change({ kind: "group", join: "and", rules: [] })}
            >
              {t("Alle Filter entfernen", "Remove all filters")}
            </button>
          )}
        </div>
      </div>
    );
  return (
    <fieldset className="chip-panel" disabled={!editable}>
      {conditions.length > 1 && (
        <Select
          className="chip-join"
          aria-label={t("Verknüpfung", "Link")}
          value={draft.join}
          onChange={(e) => change({ ...draft, join: e.target.value as "and" | "or" })}
        >
          <option value="and">{t("Alle Bedingungen treffen zu (UND)", "All conditions apply (AND)")}</option>
          <option value="or">{t("Mindestens eine trifft zu (ODER)", "At least one applies (OR)")}</option>
        </Select>
      )}
      {conditions.length === 0 && (
        <p className="muted">{t("Noch keine Filter – alle Einträge werden gezeigt.", "No filters yet – all records are shown.")}</p>
      )}
      {conditions.map((node, index) => {
        const label = t(`Bedingung ${index + 1}`, `Condition ${index + 1}`);
        return (
          <div key={index} role="group" aria-label={label} className="chip-condition">
            <FilterConditionFields
              compact
              node={node}
              fields={fields}
              related={related}
              members={members}
              zones={zones}
              filterNow={filterNow}
              patch={(values) =>
                change({
                  ...draft,
                  rules: draft.rules.map((rule, i) => (i === index ? { ...rule, ...values } : rule)),
                })
              }
              remove={
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t(`${label} entfernen`, `Remove ${label}`)}
                  onClick={() => change({ ...draft, rules: draft.rules.filter((_, i) => i !== index) })}
                >
                  <Trash size={16} />
                </button>
              }
            />
          </div>
        );
      })}
      {!valid && (
        <p role="alert" className="chip-panel-alert">
          {t("Bitte einen gültigen Zeitraum, eine Zeitzone und 1 bis 36.600 ganze Tage angeben.", "Please enter a valid period, a time zone and 1 to 36,600 whole days.")}
        </p>
      )}
      <div className="chip-panel-actions">
        <button
          type="button"
          className="button compact"
          disabled={!editable || draft.rules.length + 1 >= MAX_FILTER_NODES}
          onClick={() => change({ ...draft, rules: [...draft.rules, newFilterCondition(fields)] })}
        >
          <Plus size={14} />
          {t("Bedingung hinzufügen", "Add condition")}
        </button>
        <button type="button" className="text-button" onClick={onAdvanced}>
          {t("Erweitert …", "Advanced …")}
        </button>
        {editable && conditions.length > 0 && (
          <button
            type="button"
            className="text-button danger"
            onClick={() => change({ kind: "group", join: "and", rules: [] })}
          >
            {t("Alle entfernen", "Remove all")}
          </button>
        )}
      </div>
      <p className="chip-panel-status muted" role="status">
        {t(`${preview} von ${rows.length} Einträgen`, `${preview} of ${rows.length} records`)}
      </p>
    </fieldset>
  );
}

// Sorting: property and direction per rule, several rules in order.
function SortChipBody({
  view,
  fields,
  editable,
  updateView,
}: {
  view: View;
  fields: Field[];
  editable: boolean;
  updateView: (patch: Partial<View>) => Promise<unknown>;
}) {
  const t = useT();
  const unused = fields.find((f) => !view.sorts.some((s) => s.field === f.id)) || fields[0];
  return (
    <fieldset className="chip-panel" disabled={!editable}>
      {view.sorts.length === 0 && (
        <p className="muted">{t("Noch keine Sortierung – die Einträge stehen in ihrer Reihenfolge.", "No sorting yet – the records keep their order.")}</p>
      )}
      {view.sorts.map((s, i) => (
        <div className="chip-condition" role="group" aria-label={t(`Sortierung ${i + 1}`, `Sorting ${i + 1}`)} key={i}>
          <Select
            value={s.field}
            aria-label={t("Sortier-Eigenschaft", "Sort property")}
            onChange={(e) =>
              updateView({
                sorts: view.sorts.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)),
              })
            }
          >
            {!fields.some((f) => f.id === s.field) && (
              <option value={s.field}>{t("Gelöschte Eigenschaft", "Deleted property")}</option>
            )}
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
          <Select
            value={s.direction}
            aria-label={t("Sortierrichtung", "Sort direction")}
            onChange={(e) =>
              updateView({
                sorts: view.sorts.map((x, j) =>
                  j === i ? { ...x, direction: e.target.value as "asc" | "desc" } : x,
                ),
              })
            }
          >
            <option value="asc">{t("Aufsteigend", "Ascending")}</option>
            <option value="desc">{t("Absteigend", "Descending")}</option>
          </Select>
          <button
            type="button"
            className="icon-button"
            aria-label={t("Sortierung entfernen", "Remove sorting")}
            onClick={() => updateView({ sorts: view.sorts.filter((_, j) => i !== j) })}
          >
            <Trash size={16} />
          </button>
        </div>
      ))}
      <div className="chip-panel-actions">
        <button
          type="button"
          className="button compact"
          disabled={view.sorts.length >= 20}
          onClick={() =>
            updateView({ sorts: [...view.sorts, { field: unused.id, direction: "asc" }] })
          }
        >
          <Plus size={14} />
          {t("Sortierung hinzufügen", "Add sorting")}
        </button>
        {view.sorts.length > 0 && (
          <button type="button" className="text-button danger" onClick={() => updateView({ sorts: [] })}>
            {t("Alle entfernen", "Remove all")}
          </button>
        )}
      </div>
    </fieldset>
  );
}

// Grouping: the property, sub-groups, empty groups and their order. Deeper
// levels live in the view settings.
function GroupChipBody({
  view,
  fields,
  editable,
  groupSettings,
  updateView,
  onConfigure,
}: {
  view: View;
  fields: Field[];
  editable: boolean;
  groupSettings: GroupSettings;
  updateView: (patch: Partial<View>) => Promise<unknown>;
  onConfigure: () => void;
}) {
  const t = useT();
  const groupField = fields.find((f) => f.id === view.groupBy);
  const subField = fields.find((f) => f.id === view.subGroupBy);
  return (
    <fieldset className="chip-panel" disabled={!editable}>
      <label>
        {t("Gruppieren nach", "Group by")}
        <Select
          aria-label={t("Gruppieren nach", "Group by")}
          value={view.groupBy || ""}
          onChange={(e) =>
            updateView({
              groupBy: e.target.value,
              ...(view.subGroupBy === e.target.value || !e.target.value
                ? { subGroupBy: undefined, groupLevels: undefined }
                : {}),
              // A grouped table is no tree any more.
              ...(e.target.value && view.tree ? { tree: undefined } : {}),
              groupSettings: { ...groupSettings, collapsed: [], order: [] },
            })
          }
        >
          <option value="">
            {view.type === "board" ? t("Automatisch", "Automatic") : t("Keine Gruppierung", "No grouping")}
          </option>
          {fields.filter(canGroupField).map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
      </label>
      {groupField && (
        <>
          <label>
            {view.type === "board" ? t("Swimlanes nach", "Swimlanes by") : t("Untergruppen nach", "Sub-groups by")}
            <Select
              aria-label={view.type === "board" ? t("Swimlanes nach", "Swimlanes by") : t("Untergruppen nach", "Sub-groups by")}
              value={subField?.id || ""}
              onChange={(e) =>
                updateView({
                  subGroupBy: e.target.value || undefined,
                  ...(!e.target.value || view.groupLevels?.includes(e.target.value)
                    ? { groupLevels: undefined }
                    : {}),
                  groupSettings: {
                    ...groupSettings,
                    // Subgroup collapse keys are only meaningful per field.
                    collapsed: groupSettings.collapsed.filter((key) => !key.startsWith('["sub"')),
                  },
                })
              }
            >
              <option value="">
                {view.type === "board" ? t("Keine Swimlanes", "No swimlanes") : t("Keine Untergruppen", "No sub-groups")}
              </option>
              {fields
                .filter((f) => canGroupField(f) && f.id !== groupField.id)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </Select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={groupSettings.hideEmpty}
              onChange={(e) => updateView({ groupSettings: { ...groupSettings, hideEmpty: e.target.checked } })}
            />
            {t("Leere Gruppen ausblenden", "Hide empty groups")}
          </label>
          <label>
            {t("Gruppen sortieren", "Sort groups")}
            <Select
              aria-label={t("Gruppen sortieren", "Sort groups")}
              value={groupSettings.sort}
              onChange={(e) =>
                updateView({
                  groupSettings: { ...groupSettings, sort: e.target.value as "manual" | "asc" | "desc" },
                })
              }
            >
              <option value="manual">
                {groupSettings.order?.length ? t("Eigene Reihenfolge", "Custom order") : t("Eigenschaftsreihenfolge", "Property order")}
              </option>
              <option value="asc">{t("Bezeichnung aufsteigend", "Label ascending")}</option>
              <option value="desc">{t("Bezeichnung absteigend", "Label descending")}</option>
            </Select>
          </label>
          <div className="chip-panel-actions">
            {!!groupSettings.order?.length && (
              <button
                type="button"
                className="text-button"
                onClick={() => updateView({ groupSettings: { ...groupSettings, order: [] } })}
              >
                {t("Gruppenreihenfolge zurücksetzen", "Reset group order")}
              </button>
            )}
            {subField && (
              <button type="button" className="text-button" onClick={onConfigure}>
                {t("Weitere Ebenen …", "More levels …")}
              </button>
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}

// Visible properties of the view; order and widths stay in the settings.
function PropertiesChipBody({
  view,
  fields,
  editable,
  updateView,
  onConfigure,
}: {
  view: View;
  fields: Field[];
  editable: boolean;
  updateView: (patch: Partial<View>) => Promise<unknown>;
  onConfigure: () => void;
}) {
  const t = useT();
  const hidden = view.hiddenFields || [];
  const ordered = [...fields].sort((a, b) => {
    const order = view.fieldOrder || fields.map((f) => f.id);
    return (
      (order.includes(a.id) ? order.indexOf(a.id) : 999) -
      (order.includes(b.id) ? order.indexOf(b.id) : 999)
    );
  });
  return (
    <fieldset className="chip-panel" disabled={!editable}>
      <div className="chip-property-list">
        {ordered.map((f) => (
          <label className="checkbox-label" key={f.id}>
            <input
              type="checkbox"
              checked={!hidden.includes(f.id)}
              onChange={(e) =>
                updateView({
                  hiddenFields: e.target.checked ? hidden.filter((x) => x !== f.id) : [...hidden, f.id],
                })
              }
            />
            {f.name}
          </label>
        ))}
      </div>
      <div className="chip-panel-actions">
        {hidden.length > 0 && (
          <button type="button" className="text-button" onClick={() => updateView({ hiddenFields: [] })}>
            {t("Alle anzeigen", "Show all")}
          </button>
        )}
        <button type="button" className="text-button" onClick={onConfigure}>
          {t("Reihenfolge und Breiten …", "Order and widths …")}
        </button>
      </div>
    </fieldset>
  );
}

// Search within the view: a chip that turns into the search field.
function SearchChip({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(!!query);
  const input = useRef<HTMLInputElement>(null);
  const expanded = open || !!query;
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  if (!expanded)
    return (
      <button type="button" className="toolbar-chip" onClick={() => setOpen(true)}>
        <MagnifyingGlass size={15} />
        <span className="toolbar-chip-text">{t("Suchen", "Search")}</span>
      </button>
    );
  return (
    <div className={`toolbar-chip toolbar-chip-search${query ? " active" : ""}`}>
      <MagnifyingGlass size={15} />
      <input
        ref={input}
        aria-label={t("Datenbank durchsuchen", "Search database")}
        placeholder={t("Suchen …", "Search …")}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onBlur={() => {
          if (!query) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onQuery("");
            setOpen(false);
          }
        }}
      />
      <button
        type="button"
        className="toolbar-chip-clear"
        aria-label={t("Suche leeren", "Clear search")}
        onClick={() => {
          onQuery("");
          setOpen(false);
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}
