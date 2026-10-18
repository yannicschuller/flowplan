"use client";
// What a new database starts as: tasks, documents, only a title, or one of
// the saved database templates. The last choice is remembered per device.
import { useEffect, useState } from "react";
import { CheckSquare, Files, Rows, Star } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api } from "./ui";

export const DATABASE_KIND_KEY = "flowplan-database-kind";
export type DatabaseChoice = "tasks" | "documents" | "empty" | `template:${string}`;
type Template = { id: string; name: string; kind: string };

export function rememberedDatabaseKind(): DatabaseChoice {
  try {
    const stored = localStorage.getItem(DATABASE_KIND_KEY) || "";
    if (["tasks", "documents", "empty"].includes(stored) || stored.startsWith("template:")) return stored as DatabaseChoice;
  } catch {}
  return "tasks";
}
export function rememberDatabaseKind(choice: DatabaseChoice) {
  try {
    localStorage.setItem(DATABASE_KIND_KEY, choice);
  } catch {}
}
// The fields of page.create for a choice.
export function databaseChoicePayload(choice: DatabaseChoice) {
  return choice.startsWith("template:") ? { templateId: choice.slice(9) } : { databaseKind: choice };
}

export function DatabaseKindPicker({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string;
  value: DatabaseChoice;
  onChange: (choice: DatabaseChoice, template?: Template) => void;
}) {
  const t = useT();
  const [templates, setTemplates] = useState<Template[]>([]);
  useEffect(() => {
    let current = true;
    api<Template[]>(`/api/templates?workspace=${workspaceId}`)
      .then((list) => {
        if (!current) return;
        const databases = list.filter((x) => x.kind === "database");
        setTemplates(databases);
        // A remembered template that is gone falls back to tasks.
        if (value.startsWith("template:") && !databases.some((x) => `template:${x.id}` === value)) onChange("tasks");
      })
      .catch(() => {
        if (current && value.startsWith("template:")) onChange("tasks");
      });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
  const kinds = [
    { id: "tasks" as const, icon: CheckSquare, label: t("Aufgaben", "Tasks"), hint: t("Status, Priorität, Fälligkeit, Verantwortlich", "Status, priority, due date, assignee") },
    { id: "documents" as const, icon: Files, label: t("Dokumente", "Documents"), hint: t("Titel, Tags, Erstellt, Bearbeitet – Einträge öffnen als ganze Seite", "Title, tags, created, edited – records open as a full page") },
    { id: "empty" as const, icon: Rows, label: t("Leer", "Empty"), hint: t("Nur ein Titel", "Only a title") },
  ];
  return (
    <fieldset className="database-kinds">
      <legend>{t("Art der Datenbank", "Kind of database")}</legend>
      {kinds.map((kind) => (
        <label key={kind.id} data-active={value === kind.id}>
          <input type="radio" name="database-kind" checked={value === kind.id} onChange={() => onChange(kind.id)} />
          <kind.icon size={18} />
          <span>
            <strong>{kind.label}</strong>
            <small>{kind.hint}</small>
          </span>
        </label>
      ))}
      {templates.length > 0 && (
        <>
          <p className="database-kinds-heading">{t("Deine Vorlagen", "Your templates")}</p>
          {templates.map((template) => (
            <label key={template.id} data-active={value === `template:${template.id}`}>
              <input
                type="radio"
                name="database-kind"
                checked={value === `template:${template.id}`}
                onChange={() => onChange(`template:${template.id}`, template)}
              />
              <Star size={18} />
              <span>
                <strong>{template.name}</strong>
              </span>
            </label>
          ))}
        </>
      )}
    </fieldset>
  );
}
