"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { useEffect, useMemo, useState } from "react";
import {
  isRelativeOperator,
  relativeDateNames,
  relativeWindowLabel,
} from "@/lib/relative-dates";
import { useFilterClock } from "./use-filter-clock";
import { hasClockFormulas } from "@/lib/formula";
import { Plus, Trash } from "@phosphor-icons/react";
import {
  effectiveFilterGroup,
  filterCount,
  filterGroupSchema,
  filterNodeCount,
  hasRelativeFilters,
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  operatorNames,
  operatorsFor,
  multiValueOperators,
  valuelessOperators,
} from "@/lib/database-filters";
import { cellText, queryRows } from "@/lib/database";
import type {
  Field,
  Filter,
  FilterGroup,
  FilterNode,
  Row,
  User,
  View,
} from "@/lib/types";
export default function DatabaseFilterEditor({
  view,
  version,
  fields,
  rows,
  related,
  relatedSchemas,
  members,
  editable,
  onSave,
  onClose,
}: {
  view: View;
  version: number;
  fields: Field[];
  rows: Row[];
  related: Record<string, Row[]>;
  relatedSchemas?: Record<string, Field[]>;
  members: User[];
  editable: boolean;
  onSave: (group: FilterGroup, version: number) => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(() => effectiveFilterGroup(view)),
    [baseVersion, setBaseVersion] = useState(version),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const remote = JSON.stringify(effectiveFilterGroup(view));
  useEffect(() => {
    if (!dirty) {
      setDraft(JSON.parse(remote));
      setBaseVersion(version);
    }
  }, [remote, version, dirty]);
  const stale = dirty && version !== baseVersion;
  const draftValidation = filterGroupSchema.safeParse(draft);
  const count = filterCount(draft),
    nodes = filterNodeCount(draft);
  const filterNow = useFilterClock(
    hasRelativeFilters(draft) || hasClockFormulas(fields, relatedSchemas),
  );
  const zones = useMemo(
    () =>
      [
        ...new Set([
          Intl.DateTimeFormat().resolvedOptions().timeZone,
          "UTC",
          ...Intl.supportedValuesOf("timeZone"),
        ]),
      ].sort(),
    [],
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
  function update(
    path: number[],
    replace: (node: FilterNode) => FilterNode | null,
  ) {
    function walk(node: FilterNode, at: number): FilterNode | null {
      if (at === path.length) return replace(node);
      if (node.kind !== "group") return node;
      return {
        ...node,
        rules: node.rules.flatMap((r, index) =>
          index === path[at]
            ? [walk(r, at + 1)].filter((r): r is FilterNode => r !== null)
            : [r],
        ),
      };
    }
    setDraft((previous) => walk(previous, 0) as FilterGroup);
    setDirty(true);
    setError("");
  }
  function patch(path: number[], values: Partial<Filter>) {
    update(path, (node) => ({ ...node, ...values }));
  }
  function condition(node: Filter & { kind: "condition" }, path: number[]) {
    const field = fields.find((f) => f.id === node.field),
      isEmpty = valuelessOperators.has(node.op),
      multi = multiValueOperators.has(node.op),
      operators = operatorsFor(field);
    const label = t(`Bedingung ${path.map((i) => i + 1).join(".")}`, `Condition ${path.map((i) => i + 1).join(".")}`);
    const choices =
      field?.type === "relation"
        ? (related[field.relationPage || ""] || []).map((r) => ({
            value: r.id,
            name: cellText(r.cells.title) || t("Ohne Titel", "Untitled"),
          }))
        : field && ["select", "multiselect"].includes(field.type)
          ? (field.options || []).map((value) => ({ value, name: value }))
          : field && ["person", "created_by", "updated_by"].includes(field.type)
            ? members.map((m) => ({ value: m.id, name: m.name }))
            : field?.type === "checkbox"
              ? [
                  { value: "true", name: t("Abgehakt", "Checked") },
                  { value: "false", name: t("Nicht abgehakt", "Not checked") },
                ]
              : null;
    return (
      <div
        key={path.join(".")}
        role="group"
        aria-label={label}
        className="advanced-filter-condition"
      >
        <label>
          {t("Eigenschaft", "Property")}
          <Select
            aria-label={t("Filter-Eigenschaft", "Filter property")}
            value={node.field}
            onChange={(e) => {
              const f = fields.find((f) => f.id === e.target.value);
              patch(path, {
                field: e.target.value,
                op: operatorsFor(f)[0],
                value: "",
                timeZone: undefined,
                days: undefined,
                values: undefined,
                to: undefined,
              });
            }}
          >
            {!field && (
              <option value={node.field}>{t("Gelöschte Eigenschaft", "Deleted property")}</option>
            )}
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          {t("Bedingung", "Condition")}
          <Select
            aria-label={t("Filterbedingung", "Filter condition")}
            value={node.op}
            onChange={(e) => {
              const op = e.target.value as Filter["op"];
              patch(path, {
                op,
                values: multiValueOperators.has(op)
                  ? node.values || (node.value ? [node.value] : [])
                  : undefined,
                to: op === "between" ? node.to || "" : undefined,
                ...(isRelativeOperator(op)
                  ? {
                      value: isRelativeOperator(node.op) ? node.value : "today",
                      timeZone:
                        node.timeZone ||
                        Intl.DateTimeFormat().resolvedOptions().timeZone,
                    }
                  : isRelativeOperator(node.op)
                    ? { value: "", timeZone: undefined, days: undefined }
                    : {}),
              });
            }}
          >
            {!operators.includes(node.op) && (
              <option value={node.op}>{t(operatorNames[node.op])}</option>
            )}
            {operators.map((op) => (
              <option key={op} value={op}>
                {t(operatorNames[op])}
              </option>
            ))}
          </Select>
        </label>
        <label>
          {t("Wert", "Value")}
          {isRelativeOperator(node.op) ? (
            <Select
              aria-label={t("Relativer Zeitraum", "Relative period")}
              value={node.value}
              onChange={(e) =>
                patch(path, {
                  value: e.target.value,
                  days: ["past_days", "next_days"].includes(e.target.value)
                    ? node.days || 30
                    : undefined,
                })
              }
            >
              {Object.entries(relativeDateNames).map(([value, name]) => (
                <option key={value} value={value}>
                  {t(name)}
                </option>
              ))}
            </Select>
          ) : multi && choices ? (
            <span
              className="filter-values"
              role="group"
              aria-label={t("Filterwerte", "Filter values")}
            >
              {choices.map((c) => (
                <label className="checkbox-label" key={c.value}>
                  <input
                    type="checkbox"
                    checked={!!node.values?.includes(c.value)}
                    onChange={(e) =>
                      patch(path, {
                        values: e.target.checked
                          ? [...(node.values || []), c.value]
                          : (node.values || []).filter((v) => v !== c.value),
                      })
                    }
                  />
                  {c.name}
                </label>
              ))}
              {!choices.length && <span className="muted">{t("Keine Werte", "No values")}</span>}
            </span>
          ) : choices ? (
            <Select
              aria-label={t("Filterwert", "Filter value")}
              value={node.value}
              disabled={isEmpty}
              onChange={(e) => patch(path, { value: e.target.value })}
            >
              <option value="">{t("Auswählen …", "Select …")}</option>
              {node.value && !choices.some((c) => c.value === node.value) && (
                <option value={node.value}>{t("Nicht verfügbar", "Not available")}</option>
              )}
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.name}
                </option>
              ))}
            </Select>
          ) : (
            <input
              aria-label={t("Filterwert", "Filter value")}
              type={
                (field &&
                  ["date", "created_at", "updated_at"].includes(field.type)) ||
                ["before", "after", "on_or_before", "on_or_after"].includes(
                  node.op,
                )
                  ? "date"
                  : field?.type === "number"
                    ? "number"
                    : "text"
              }
              step="any"
              maxLength={500}
              value={node.value}
              disabled={isEmpty}
              onChange={(e) => patch(path, { value: e.target.value })}
            />
          )}
        </label>
        {node.op === "between" && (
          <label>
            {t("Bis", "To")}
            <input
              aria-label={t("Filterwert bis", "Filter value to")}
              type={
                field &&
                ["date", "created_at", "updated_at"].includes(field.type)
                  ? "date"
                  : "number"
              }
              step="any"
              value={node.to || ""}
              onChange={(e) => patch(path, { to: e.target.value })}
            />
          </label>
        )}
        <button
          className="icon-button"
          type="button"
          aria-label={t(`${label} entfernen`, `Remove ${label}`)}
          onClick={() => update(path, () => null)}
        >
          <Trash size={17} />
        </button>
        {isRelativeOperator(node.op) && (
          <div className="relative-filter-options">
            {["past_days", "next_days"].includes(node.value) && (
              <label>
                {t("Anzahl Tage", "Number of days")}
                <input
                  aria-label={t("Anzahl Tage", "Number of days")}
                  type="number"
                  min={1}
                  max={36600}
                  step={1}
                  value={node.days ?? ""}
                  onChange={(e) =>
                    patch(path, {
                      days: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
              </label>
            )}
            <label>
              {t("Zeitzone", "Time zone")}
              <Select
                aria-label={t("Filter-Zeitzone", "Filter time zone")}
                value={node.timeZone || "UTC"}
                onChange={(e) => patch(path, { timeZone: e.target.value })}
              >
                {[
                  ...new Set([
                    ...(node.timeZone ? [node.timeZone] : []),
                    ...zones,
                  ]),
                ].map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </Select>
            </label>
            <p className="muted">
              {relativeWindowLabel(
                node.value,
                node.timeZone || "UTC",
                node.days,
                new Date(filterNow),
              )}
              {t(". Wochen beginnen montags. Datumswerte ohne Uhrzeit bleiben Kalendertage; Zeitstempel werden in der gewählten Zeitzone ausgewertet.", ". Weeks start on Monday. Dates without a time stay calendar days; timestamps are evaluated in the chosen time zone.")}
            </p>
          </div>
        )}
      </div>
    );
  }
  function group(node: FilterGroup, path: number[] = []): React.ReactNode {
    const depth = path.length + 1,
      label = path.length
        ? t(`Filtergruppe ${path.map((i) => i + 1).join(".")}`, `Filter group ${path.map((i) => i + 1).join(".")}`)
        : t("Alle Filter", "All filters");
    return (
      <fieldset
        className="advanced-filter-group"
        aria-label={label}
        key={path.join(".")}
      >
        <legend>{label}</legend>
        <div className="filter-group-header">
          <label>
            {t("Verknüpfung", "Link")}
            <Select
              aria-label={t(`${label}: Verknüpfung`, `${label}: combination`)}
              value={node.join}
              onChange={(e) =>
                update(path, (n) => ({
                  ...n,
                  join: e.target.value as "and" | "or",
                }))
              }
            >
              <option value="and">{t("UND – alle Bedingungen", "AND – all conditions")}</option>
              <option value="or">{t("ODER – mindestens eine", "OR – at least one")}</option>
            </Select>
          </label>
          {path.length > 0 && (
            <button
              className="icon-button"
              type="button"
              aria-label={t(`${label} entfernen`, `Remove ${label}`)}
              onClick={() => update(path, () => null)}
            >
              <Trash size={17} />
            </button>
          )}
        </div>
        {node.rules.length === 0 && (
          <p className="muted">
            {t("Diese Gruppe enthält noch keine Bedingungen und schränkt die Ergebnisse nicht ein.", "This group has no conditions yet and does not limit the results.")}
          </p>
        )}
        {node.rules.map((rule, index) =>
          rule.kind === "group"
            ? group(rule, [...path, index])
            : condition(rule, [...path, index]),
        )}
        <div className="filter-group-actions">
          <button
            type="button"
            className="button compact"
            disabled={nodes >= MAX_FILTER_NODES}
            onClick={() =>
              update(path, (n) =>
                n.kind === "group"
                  ? {
                      ...n,
                      rules: [
                        ...n.rules,
                        {
                          kind: "condition",
                          field: fields[0].id,
                          op: operatorsFor(fields[0])[0],
                          value: "",
                        },
                      ],
                    }
                  : n,
              )
            }
          >
            <Plus size={15} />
            {t("Bedingung hinzufügen", "Add condition")}
          </button>
          <button
            type="button"
            className="button compact"
            disabled={depth >= MAX_FILTER_DEPTH || nodes + 2 > MAX_FILTER_NODES}
            onClick={() =>
              update(path, (n) =>
                n.kind === "group"
                  ? {
                      ...n,
                      rules: [
                        ...n.rules,
                        {
                          kind: "group",
                          join: node.join === "and" ? "or" : "and",
                          rules: [
                            {
                              kind: "condition",
                              field: fields[0].id,
                              op: operatorsFor(fields[0])[0],
                              value: "",
                            },
                          ],
                        },
                      ],
                    }
                  : n,
              )
            }
          >
            <Plus size={15} />
            {t("Gruppe hinzufügen", "Add group")}
          </button>
        </div>
      </fieldset>
    );
  }
  return (
    <div className="advanced-filter-editor">
      <p className="muted">
        {t("Bedingungen und Gruppen kombinieren. Änderungen werden mit „Anwenden“ gespeichert.", "Combine conditions and groups. Changes are saved with “Apply”.")}
      </p>
      <div className="filter-preview" role="status">
        {preview} {t("von", "of")}{" "}{rows.length} {t("Einträgen passen ·", "records match ·")}{" "}{count} {t("Bedingungen", "Conditions")}
      </div>
      {stale && (
        <div className="filter-conflict" role="alert">
          {t("Die Ansicht wurde inzwischen geändert. Dein Entwurf bleibt erhalten. Lade vor dem Speichern den aktuellen Stand.", "The view was changed in the meantime. Your draft is kept. Load the current state before saving.")}
          <button
            type="button"
            className="button compact"
            onClick={() => {
              setDirty(false);
              setDraft(JSON.parse(remote));
              setBaseVersion(version);
              setError("");
            }}
          >
            {t("Entwurf verwerfen und neu laden", "Discard draft and reload")}
          </button>
        </div>
      )}
      <fieldset className="schema-settings" disabled={!editable || busy}>
        {group(draft)}
      </fieldset>
      {!draftValidation.success && (
        <p role="alert">
          {t("Bitte einen gültigen Zeitraum, eine Zeitzone und 1 bis 36.600 ganze Tage angeben.", "Please enter a valid period, a time zone and 1 to 36,600 whole days.")}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="modal-actions">
        <button
          type="button"
          className="button danger"
          disabled={!editable || busy || nodes === 1}
          onClick={() => {
            setDraft({ kind: "group", join: "and", rules: [] });
            setDirty(true);
          }}
        >
          {t("Alle Filter entfernen", "Remove all filters")}
        </button>
        <button type="button" className="button" onClick={onClose}>
          {editable ? t("Abbrechen", "Cancel") : t("Schließen", "Close")}
        </button>
        {editable && (
          <button
            type="button"
            className="button primary"
            disabled={busy || stale || !dirty || !draftValidation.success}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const result = await onSave(draft, baseVersion);
                if (result) {
                  onClose();
                } else
                  setError(
                    t("Filter wurden nicht gespeichert. Dein Entwurf bleibt erhalten.", "Filters were not saved. Your draft is kept."),
                  );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? t("Wird gespeichert …", "Saving …") : t("Anwenden", "Apply")}
          </button>
        )}
      </div>
    </div>
  );
}
