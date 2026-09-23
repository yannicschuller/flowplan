"use client";
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
      isEmpty = ["empty", "notempty"].includes(node.op),
      operators = operatorsFor(field);
    const label = `Bedingung ${path.map((i) => i + 1).join(".")}`;
    const choices =
      field?.type === "relation"
        ? (related[field.relationPage || ""] || []).map((r) => ({
            value: r.id,
            name: cellText(r.cells.title) || "Ohne Titel",
          }))
        : field && ["select", "multiselect"].includes(field.type)
          ? (field.options || []).map((value) => ({ value, name: value }))
          : field && ["person", "created_by", "updated_by"].includes(field.type)
            ? members.map((m) => ({ value: m.id, name: m.name }))
            : field?.type === "checkbox"
              ? [
                  { value: "true", name: "Abgehakt" },
                  { value: "false", name: "Nicht abgehakt" },
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
          Eigenschaft
          <select
            aria-label="Filter-Eigenschaft"
            value={node.field}
            onChange={(e) => {
              const f = fields.find((f) => f.id === e.target.value);
              patch(path, {
                field: e.target.value,
                op: operatorsFor(f)[0],
                value: "",
                timeZone: undefined,
                days: undefined,
              });
            }}
          >
            {!field && (
              <option value={node.field}>Gelöschte Eigenschaft</option>
            )}
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Bedingung
          <select
            aria-label="Filterbedingung"
            value={node.op}
            onChange={(e) => {
              const op = e.target.value as Filter["op"];
              patch(path, {
                op,
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
              <option value={node.op}>{operatorNames[node.op]}</option>
            )}
            {operators.map((op) => (
              <option key={op} value={op}>
                {operatorNames[op]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Wert
          {isRelativeOperator(node.op) ? (
            <select
              aria-label="Relativer Zeitraum"
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
                  {name}
                </option>
              ))}
            </select>
          ) : choices ? (
            <select
              aria-label="Filterwert"
              value={node.value}
              disabled={isEmpty}
              onChange={(e) => patch(path, { value: e.target.value })}
            >
              <option value="">Auswählen …</option>
              {node.value && !choices.some((c) => c.value === node.value) && (
                <option value={node.value}>Nicht verfügbar</option>
              )}
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label="Filterwert"
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
        <button
          className="icon-button"
          type="button"
          aria-label={`${label} entfernen`}
          onClick={() => update(path, () => null)}
        >
          <Trash size={17} />
        </button>
        {isRelativeOperator(node.op) && (
          <div className="relative-filter-options">
            {["past_days", "next_days"].includes(node.value) && (
              <label>
                Anzahl Tage
                <input
                  aria-label="Anzahl Tage"
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
              Zeitzone
              <select
                aria-label="Filter-Zeitzone"
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
              </select>
            </label>
            <p className="muted">
              {relativeWindowLabel(
                node.value,
                node.timeZone || "UTC",
                node.days,
                new Date(filterNow),
              )}
              . Wochen beginnen montags. Datumswerte ohne Uhrzeit bleiben
              Kalendertage; Zeitstempel werden in der gewählten Zeitzone
              ausgewertet.
            </p>
          </div>
        )}
      </div>
    );
  }
  function group(node: FilterGroup, path: number[] = []): React.ReactNode {
    const depth = path.length + 1,
      label = path.length
        ? `Filtergruppe ${path.map((i) => i + 1).join(".")}`
        : "Alle Filter";
    return (
      <fieldset
        className="advanced-filter-group"
        aria-label={label}
        key={path.join(".")}
      >
        <legend>{label}</legend>
        <div className="filter-group-header">
          <label>
            Verknüpfung
            <select
              aria-label={`${label}: Verknüpfung`}
              value={node.join}
              onChange={(e) =>
                update(path, (n) => ({
                  ...n,
                  join: e.target.value as "and" | "or",
                }))
              }
            >
              <option value="and">UND – alle Bedingungen</option>
              <option value="or">ODER – mindestens eine</option>
            </select>
          </label>
          {path.length > 0 && (
            <button
              className="icon-button"
              type="button"
              aria-label={`${label} entfernen`}
              onClick={() => update(path, () => null)}
            >
              <Trash size={17} />
            </button>
          )}
        </div>
        {node.rules.length === 0 && (
          <p className="muted">
            Diese Gruppe enthält noch keine Bedingungen und schränkt die
            Ergebnisse nicht ein.
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
            Bedingung hinzufügen
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
            Gruppe hinzufügen
          </button>
        </div>
      </fieldset>
    );
  }
  return (
    <div className="advanced-filter-editor">
      <p className="muted">
        Bedingungen und Gruppen kombinieren. Änderungen werden mit „Anwenden“
        gespeichert.
      </p>
      <div className="filter-preview" role="status">
        {preview} von {rows.length} Einträgen passen · {count} Bedingungen
      </div>
      {stale && (
        <div className="filter-conflict" role="alert">
          Die Ansicht wurde inzwischen geändert. Dein Entwurf bleibt erhalten.
          Lade vor dem Speichern den aktuellen Stand.
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
            Entwurf verwerfen und neu laden
          </button>
        </div>
      )}
      <fieldset className="schema-settings" disabled={!editable || busy}>
        {group(draft)}
      </fieldset>
      {!draftValidation.success && (
        <p role="alert">
          Bitte einen gültigen Zeitraum, eine Zeitzone und 1 bis 36.600 ganze
          Tage angeben.
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
          Alle Filter entfernen
        </button>
        <button type="button" className="button" onClick={onClose}>
          {editable ? "Abbrechen" : "Schließen"}
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
                    "Filter wurden nicht gespeichert. Dein Entwurf bleibt erhalten.",
                  );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Wird gespeichert …" : "Anwenden"}
          </button>
        )}
      </div>
    </div>
  );
}
