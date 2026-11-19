"use client";
// "Aufgabe erstellen" of a database rule (#380, lib/automation-task.ts): a
// task in the triggering record's document or a new record in a task
// database – text with placeholders, person, due date relative to the run,
// and for a database the properties it fills.
import { useEffect, useState, type ReactNode } from "react";
import { Trash } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api } from "./ui";
import { Select } from "./select";
import { dueField, type DatabaseSettings, type TaskAction } from "@/lib/database-settings-schema";
import { serverMessage } from "@/lib/i18n-errors";
import type { Database, Field, Page, User } from "@/lib/types";

export type DatabaseRef = { id: string; title: string };
type T = (de: string, en: string) => string;
type TaskSchema = { fields: Field[]; settings?: DatabaseSettings; problem?: string };

const whole = (value: string) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(3650, Math.max(-3650, n)) : 0;
};

// A new task: in the record's document (scheduled rules: into a database),
// for the record's person if there is one, due three days later.
export function taskAction(fields: Field[], scheduled: boolean, t: T): TaskAction {
  const person = fields.find((f) => f.type === "person");
  const title = fields[0]?.name || t("Titel", "Title");
  return {
    type: "task",
    target: scheduled ? "database" : "document",
    text: scheduled ? t("Aufgabe vom {{Heute}}", "Task of {{Today}}") : t(`Nachfassen: {{${title}}}`, `Follow up: {{${title}}}`),
    assignee: !scheduled && person ? `field:${person.id}` : "@actor",
    due: 3,
    heading: "",
    database: "",
    personField: "",
    dueField: "",
    values: {},
    relation: "",
  };
}

// What keeps a task from being saved (shown below the rule).
export function taskProblems(a: TaskAction, t: T) {
  const out: string[] = [];
  if (!a.text.trim()) out.push(t("Die Aufgabe braucht einen Text.", "The task needs a text."));
  if (a.target === "database" && !a.database) out.push(t("Wähle eine Datenbank für die Aufgabe.", "Choose a database for the task."));
  return out;
}

export function taskLabel(a: TaskAction, databases: DatabaseRef[], t: T) {
  const where =
    a.target === "document"
      ? t("im Eintrag", "in the record")
      : t(`in „${databases.find((d) => d.id === a.database)?.title || "?"}“`, `in “${databases.find((d) => d.id === a.database)?.title || "?"}”`);
  const due = a.due === null ? "" : ` · ${t("fällig", "due")} ${a.due >= 0 ? "+" : "−"}${Math.abs(a.due)} ${t("Tage", "days")}`;
  return t(`Aufgabe „${a.text}“ ${where}`, `task “${a.text}” ${where}`) + due;
}

// The task database's properties (and whether the person may write there).
function useTaskSchema(id: string, t: T) {
  const [schema, setSchema] = useState<{ id: string; value: TaskSchema } | null>(null);
  useEffect(() => {
    if (!id) return;
    let active = true;
    api<{ database: Database; page: Page; role: string }>(`/api/pages/${id}`)
      .then((r) => {
        if (!active) return;
        const problem =
          r.page.kind !== "database"
            ? t("Das ist keine Datenbank.", "This is not a database.")
            : r.role === "viewer" || !r.role
              ? t("In dieser Datenbank darfst du keine Einträge anlegen – die Regel handelt mit deinen Rechten.", "You may not create records in this database – the rule acts with your rights.")
              : r.page.locked
                ? t("Diese Datenbank ist gesperrt.", "This database is locked.")
                : undefined;
        setSchema({ id, value: { fields: r.database?.fields || [], settings: r.database?.settings, problem } });
      })
      .catch((e) => active && setSchema({ id, value: { fields: [], problem: serverMessage((e as Error).message) } }));
    return () => {
      active = false;
    };
  }, [id, t]);
  return schema?.id === id ? schema.value : null;
}

export function TaskActionFields({
  action,
  fields,
  members,
  databases,
  pageId,
  scheduled,
  typeSelect,
  onChange,
  onRemove,
}: {
  action: TaskAction;
  fields: Field[];
  members: Pick<User, "id" | "name">[];
  databases: DatabaseRef[];
  pageId?: string;
  scheduled: boolean;
  typeSelect: ReactNode;
  onChange: (next: TaskAction) => void;
  onRemove?: () => void;
}) {
  const t = useT();
  const intoDatabase = action.target === "database";
  const schema = useTaskSchema(intoDatabase ? action.database : "", t);
  const people = fields.filter((f) => f.type === "person");
  const taskFields = schema?.fields || [];
  const taskPeople = taskFields.filter((f) => f.type === "person");
  const taskDates = taskFields.filter((f) => f.type === "date");
  const choices = taskFields.filter((f) => (f.type === "select" || f.type === "multiselect") && f.options?.length);
  const backLinks = scheduled ? [] : taskFields.filter((f) => f.type === "relation" && f.relationPage === pageId);
  // A database just chosen: its first person, its due date and the link back.
  useEffect(() => {
    if (!schema || schema.problem || !intoDatabase) return;
    const person = action.personField || taskPeople[0]?.id || "";
    const due = action.dueField || dueField(taskFields, schema.settings)?.id || "";
    const relation = action.relation || backLinks[0]?.id || "";
    if (person !== action.personField || due !== action.dueField || relation !== action.relation) onChange({ ...action, personField: person, dueField: due, relation });
    // Only when the schema arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);
  return (
    <div className="automation-create automation-task">
      <div className="automation-row">
        {typeSelect}
        <Select
          aria-label={t("Wohin kommt die Aufgabe?", "Where does the task go?")}
          value={action.target}
          onChange={(e) =>
            onChange({ ...action, target: e.target.value === "database" ? "database" : "document", ...(e.target.value === "document" ? { database: "", personField: "", dueField: "", values: {}, relation: "" } : {}) })
          }
        >
          <option value="document" disabled={scheduled}>
            {t("ins Dokument des Eintrags", "into the record’s document")}
          </option>
          <option value="database">{t("als Eintrag in einer Datenbank", "as a record in a database")}</option>
        </Select>
        {onRemove && (
          <button type="button" className="icon-button" aria-label={t("Aktion entfernen", "Remove action")} onClick={onRemove}>
            <Trash />
          </button>
        )}
      </div>
      <label className="automation-row">
        <span>{t("Aufgabe", "Task")}</span>
        <input
          aria-label={t("Aufgabe: Text", "Task: text")}
          value={action.text}
          maxLength={300}
          aria-invalid={!action.text.trim() || undefined}
          placeholder={t("z. B. Nachfassen: {{Titel}}", "e.g. Follow up: {{Title}}")}
          onChange={(e) => onChange({ ...action, text: e.target.value })}
        />
      </label>
      <label className="automation-row">
        <span>{t("Person", "Person")}</span>
        <Select aria-label={t("Person der Aufgabe", "Person of the task")} value={action.assignee} onChange={(e) => onChange({ ...action, assignee: e.target.value })}>
          <option value="">{t("niemand", "nobody")}</option>
          {!scheduled &&
            people.map((f) => (
              <option key={f.id} value={`field:${f.id}`}>
                {t(`Person in „${f.name}“`, `Person in “${f.name}”`)}
              </option>
            ))}
          <option value="@actor">{scheduled ? t("Wer die Regel speichert", "Whoever saves the rule") : t("Auslösende Person", "Person who triggered it")}</option>
          {!scheduled && <option value="@creator">{t("Ersteller des Eintrags", "Creator of the record")}</option>}
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </label>
      <label className="automation-row">
        <span>{t("Fällig", "Due")}</span>
        <input
          aria-label={t("Fällig in Tagen", "Due in days")}
          type="number"
          min={-3650}
          max={3650}
          placeholder={t("ohne Fälligkeit", "no due date")}
          value={action.due ?? ""}
          onChange={(e) => onChange({ ...action, due: e.target.value === "" ? null : whole(e.target.value) })}
        />
        <small className="muted">{scheduled ? t("Tage nach dem Termin (0 = am Tag selbst)", "days after the run (0 = the same day)") : t("Tage nach dem Auslösen (0 = am selben Tag)", "days after it triggers (0 = the same day)")}</small>
      </label>
      {!intoDatabase ? (
        <label className="automation-row">
          <span>{t("Unter der Überschrift", "Below the heading")}</span>
          <input aria-label={t("Unter der Überschrift", "Below the heading")} value={action.heading} maxLength={200} placeholder={t("optional, z. B. Aufgaben", "optional, e.g. Tasks")} onChange={(e) => onChange({ ...action, heading: e.target.value })} />
        </label>
      ) : (
        <>
          <label className="automation-row">
            <span>{t("Datenbank", "Database")}</span>
            <Select
              aria-label={t("Datenbank der Aufgabe", "Database of the task")}
              aria-invalid={!action.database || undefined}
              value={action.database}
              onChange={(e) => onChange({ ...action, database: e.target.value, personField: "", dueField: "", values: {}, relation: "" })}
            >
              <option value="">{t("Auswählen …", "Select …")}</option>
              {databases.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title || t("Ohne Titel", "Untitled")}
                </option>
              ))}
            </Select>
          </label>
          {schema?.problem && (
            <p className="error" role="alert">
              {schema.problem}
            </p>
          )}
          {schema && !schema.problem && (
            <>
              {action.assignee && (
                <label className="automation-row">
                  <span>{t("Person kommt in", "Person goes into")}</span>
                  <Select aria-label={t("Person kommt in", "Person goes into")} value={action.personField} onChange={(e) => onChange({ ...action, personField: e.target.value })}>
                    {!taskPeople.length && <option value="">{t("keine Personen-Eigenschaft", "no person property")}</option>}
                    {taskPeople.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {action.due !== null && (
                <label className="automation-row">
                  <span>{t("Fälligkeit kommt in", "Due date goes into")}</span>
                  <Select aria-label={t("Fälligkeit kommt in", "Due date goes into")} value={action.dueField} onChange={(e) => onChange({ ...action, dueField: e.target.value })}>
                    {!taskDates.length && <option value="">{t("keine Datums-Eigenschaft", "no date property")}</option>}
                    {taskDates.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {choices.map((f) => (
                <label key={f.id} className="automation-row">
                  <span>{f.name}</span>
                  <Select
                    aria-label={f.name}
                    value={action.values[f.id] || ""}
                    onChange={(e) => {
                      const values = { ...action.values };
                      if (e.target.value) values[f.id] = e.target.value;
                      else delete values[f.id];
                      onChange({ ...action, values });
                    }}
                  >
                    <option value="">{t("nicht setzen", "leave as is")}</option>
                    {(f.options || []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
              {backLinks.length > 0 && (
                <label className="automation-row">
                  <span>{t("Verknüpfen über", "Link through")}</span>
                  <Select aria-label={t("Verknüpfen über", "Link through")} value={action.relation} onChange={(e) => onChange({ ...action, relation: e.target.value })}>
                    <option value="">{t("nicht verknüpfen", "do not link")}</option>
                    {backLinks.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
            </>
          )}
        </>
      )}
      <p className="muted">
        {scheduled
          ? t("Einmal je Termin, mit deinen Rechten. Platzhalter wie {{Heute}} werden ausgefüllt.", "Once per date, with your rights. Placeholders like {{Today}} are filled in.")
          : t(
              "Einmal je Eintrag, mit den Rechten der Person, die die Regel speichert. Platzhalter wie {{Status}} werden mit den Werten des Eintrags ausgefüllt.",
              "Once per record, with the rights of the person who saves the rule. Placeholders like {{Status}} are filled in with the record’s values.",
            )}
      </p>
    </div>
  );
}
