"use client";
// "Aufgaben in Datenbank verschieben …" (#420, the page's "⋯" menu): the
// task items of the document become records of a task database the person
// may add records to. The dialog maps the task's state, due date and person
// to the database's properties (preset from its done rule, due date and
// person, lib/task-database-fields.ts), shows what moves, and asks what
// happens in the document: a link to each record (default), removed, or
// kept. The command (lib/tasks-to-database.ts) runs through the
// workspace's `act`, so the toast offers "Rückgängig" (lib/undo.ts).
// Loaded on demand.
import { useEffect, useMemo, useState } from "react";
import { useT } from "./i18n";
import { Modal, PageIcon, api } from "./ui";
import { Select } from "./select";
import { useDatabaseEntries } from "./database-picker";
import { taskFields } from "@/lib/task-database-fields";
import { serverMessage } from "@/lib/i18n-errors";
import type { Database, Field, Page } from "@/lib/types";
import type { DocumentMode } from "@/lib/tasks-to-database-schema";

type Plan = {
  tasks: number;
  done: number;
  due: number;
  assigned: number;
  nested: number;
  databases: { id: string; title: string; icon: string; space: string }[];
};
const NONE: Plan["databases"] = [];
type Schema = { id: string; fields: Field[]; problem?: string };
type Mapping = { statusField: string; doneValue: string; openValue: string; dueField: string; personField: string; parentField: string };

export default function TasksToDatabase({
  pageId,
  act,
  onClose,
  onDone,
  onError,
}: {
  pageId: string;
  // The workspace's command runner (null when it failed and showed the error).
  act: (b: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
  onDone: (databaseId: string) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [target, setTarget] = useState("");
  const [query, setQuery] = useState("");
  const [schema, setSchema] = useState<Schema | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [mode, setMode] = useState<DocumentMode>("link");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Plan>(`/api/pages/${pageId}/tasks-to-database`)
      .then((p) => {
        setPlan(p);
        if (p.databases.length === 1) setTarget(p.databases[0].id);
      })
      .catch((e) => {
        onError((e as Error).message);
        onClose();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);
  // The chosen database's properties, and what fits where.
  useEffect(() => {
    if (!target) return;
    let active = true;
    api<{ database: Database; page: Page; role: string }>(`/api/pages/${target}`)
      .then((r) => {
        if (!active) return;
        const fields = r.database?.fields || [];
        const found = taskFields(fields, r.database?.settings, target);
        setSchema({
          id: target,
          fields,
          problem: r.page.kind !== "database" ? t("Das ist keine Datenbank.", "This is not a database.") : r.page.locked ? t("Diese Datenbank ist gesperrt.", "This database is locked.") : undefined,
        });
        setMapping({
          statusField: found.status?.id || "",
          doneValue: found.doneValue,
          openValue: found.openValue,
          dueField: found.due?.id || "",
          personField: found.person?.id || "",
          parentField: found.parent?.id || "",
        });
      })
      .catch((e) => active && setSchema({ id: target, fields: [], problem: serverMessage((e as Error).message) }));
    return () => {
      active = false;
    };
  }, [target, t]);
  // Sorted by space, then title; twins named apart (#520).
  const entries = useDatabaseEntries(plan?.databases || NONE);
  const icons = useMemo(() => new Map((plan?.databases || []).map((d) => [d.id, d.icon])), [plan]);
  const shown = useMemo(() => entries.filter((d) => `${d.label} ${d.space}`.toLowerCase().includes(query.trim().toLowerCase())), [entries, query]);
  const current = schema?.id === target ? schema : null;
  const fields = current?.fields || [];
  const statusFields = fields.filter((f) => f.type === "checkbox" || (f.type === "select" && f.options?.length));
  const status = fields.find((f) => f.id === mapping?.statusField);
  const dates = fields.filter((f) => f.type === "date");
  const people = fields.filter((f) => f.type === "person");
  const parent = fields.find((f) => f.type === "relation" && f.parent && f.relationPage === target);
  const name = entries.find((d) => d.id === target)?.fullLabel || t("Ohne Titel", "Untitled");
  const set = (patch: Partial<Mapping>) => setMapping((m) => (m ? { ...m, ...patch } : m));
  const options = (field: Field | undefined) =>
    (field?.options || []).map((o) => (
      <option key={o} value={o}>
        {o}
      </option>
    ));
  const ready = !!plan?.tasks && !!target && !!current && !current.problem && !!mapping;
  return (
    <Modal open onClose={onClose} title={t("Aufgaben in Datenbank verschieben", "Move tasks to a database")}>
      {!plan ? (
        <p className="muted">{t("Wird geladen …", "Loading …")}</p>
      ) : !plan.tasks ? (
        <p className="muted">{t("Dieses Dokument enthält keine Aufgaben.", "This document has no tasks.")}</p>
      ) : !plan.databases.length ? (
        <p className="muted">{t("Es gibt keine Datenbank, in der du Einträge anlegen darfst.", "There is no database you may add records to.")}</p>
      ) : (
        <form
          className="transfer-dialog tasks-to-database"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!ready || !mapping) return;
            setBusy(true);
            try {
              const result = await act({
                action: "page.tasksToDatabase",
                pageId,
                databaseId: target,
                ...mapping,
                statusField: status ? mapping.statusField : "",
                parentField: parent ? mapping.parentField : "",
                document: mode,
              });
              if (result) onDone(target);
            } finally {
              setBusy(false);
            }
          }}
        >
          {plan.databases.length > 6 && (
            <input type="search" aria-label={t("Datenbank suchen", "Search database")} placeholder={t("Datenbank suchen …", "Search database …")} value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
          <div className="transfer-targets" role="radiogroup" aria-label={t("Ziel-Datenbank", "Target database")}>
            {shown.map((d) => (
              <label key={d.id} className="transfer-target" data-active={target === d.id}>
                <input type="radio" name="tasks-target" aria-description={d.space || undefined} checked={target === d.id} onChange={() => setTarget(d.id)} />
                <PageIcon name={icons.get(d.id) || ""} size={16} />
                <span className="transfer-target-name">
                  <span>{d.label}</span>
                  {d.space && <small aria-hidden="true">{d.space}</small>}
                </span>
              </label>
            ))}
            {!shown.length && <p className="muted">{t("Keine Datenbank gefunden.", "No database found.")}</p>}
          </div>
          {target && !current && <p className="muted">{t("Wird geladen …", "Loading …")}</p>}
          {current?.problem && (
            <p className="error" role="alert">
              {current.problem}
            </p>
          )}
          {current && !current.problem && mapping && (
            <fieldset className="tasks-to-database-map">
              <legend>{t("Zuordnung", "Mapping")}</legend>
              <label>
                <span>{t("Titel", "Title")}</span>
                <span className="muted">
                  {t("Text der Aufgabe", "The task's text")} → {fields[0]?.name || t("Titel", "Title")}
                </span>
              </label>
              <label>
                <span>{t("Erledigt", "Done")}</span>
                <Select aria-label={t("Erledigt kommt in", "Done goes into")} value={status ? mapping.statusField : ""} onChange={(e) => {
                  const field = fields.find((f) => f.id === e.target.value);
                  const found = field?.type === "select" ? taskFields([field], undefined) : null;
                  set({ statusField: e.target.value, doneValue: found?.doneValue || field?.options?.at(-1) || "", openValue: found?.openValue || field?.options?.[0] || "" });
                }}>
                  <option value="">{t("nicht übernehmen", "do not map")}</option>
                  {statusFields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </label>
              {status?.type === "select" && (
                <>
                  <label>
                    <span>{t("Erledigte Aufgaben", "Done tasks")}</span>
                    <Select aria-label={t("Option für erledigte Aufgaben", "Option for done tasks")} value={mapping.doneValue} onChange={(e) => set({ doneValue: e.target.value })}>
                      <option value="">{t("leer lassen", "leave empty")}</option>
                      {options(status)}
                    </Select>
                  </label>
                  <label>
                    <span>{t("Offene Aufgaben", "Open tasks")}</span>
                    <Select aria-label={t("Option für offene Aufgaben", "Option for open tasks")} value={mapping.openValue} onChange={(e) => set({ openValue: e.target.value })}>
                      <option value="">{t("leer lassen", "leave empty")}</option>
                      {options(status)}
                    </Select>
                  </label>
                </>
              )}
              {plan.due > 0 && (
                <label>
                  <span>{t("Fällig", "Due")}</span>
                  <Select aria-label={t("Fälligkeit kommt in", "Due date goes into")} value={mapping.dueField} onChange={(e) => set({ dueField: e.target.value })}>
                    <option value="">{t("nicht übernehmen", "do not map")}</option>
                    {dates.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {plan.assigned > 0 && (
                <label>
                  <span>{t("Person", "Person")}</span>
                  <Select aria-label={t("Person kommt in", "Person goes into")} value={mapping.personField} onChange={(e) => set({ personField: e.target.value })}>
                    <option value="">{t("nicht übernehmen", "do not map")}</option>
                    {people.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {plan.nested > 0 && (
                <p className="muted small">
                  {parent
                    ? t("Unteraufgaben werden eigene Einträge, verknüpft mit ihrer übergeordneten Aufgabe.", "Sub-tasks become records of their own, linked to their parent task.")
                    : t("Unteraufgaben werden eigene Einträge neben den anderen (die Datenbank hat keine Eigenschaft für übergeordnete Einträge).", "Sub-tasks become records of their own beside the others (the database has no property for parent records).")}
                </p>
              )}
            </fieldset>
          )}
          <fieldset className="tasks-to-database-mode">
            <legend>{t("Im Dokument", "In the document")}</legend>
            <label className="checkbox-label">
              <input type="radio" name="tasks-mode" checked={mode === "link"} onChange={() => setMode("link")} />
              {t("Durch Links auf die Einträge ersetzen", "Replace with links to the records")}
            </label>
            <label className="checkbox-label">
              <input type="radio" name="tasks-mode" checked={mode === "remove"} onChange={() => setMode("remove")} />
              {t("Entfernen", "Remove")}
            </label>
            <label className="checkbox-label">
              <input type="radio" name="tasks-mode" checked={mode === "keep"} onChange={() => setMode("keep")} />
              {t("Unverändert lassen", "Keep unchanged")}
            </label>
          </fieldset>
          <p className="tasks-to-database-preview" role="status">
            {plan.tasks === 1
              ? t(`1 Aufgabe (${plan.done} erledigt) → ${target ? `„${name}“` : "…"}`, `1 task (${plan.done} done) → ${target ? `“${name}”` : "…"}`)
              : t(`${plan.tasks} Aufgaben (${plan.done} erledigt) → ${target ? `„${name}“` : "…"}`, `${plan.tasks} tasks (${plan.done} done) → ${target ? `“${name}”` : "…"}`)}
          </p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button className="button primary" disabled={busy || !ready}>
              {busy ? t("Wird verschoben …", "Moving …") : t("Verschieben", "Move")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
