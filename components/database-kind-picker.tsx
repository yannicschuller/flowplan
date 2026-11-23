"use client";
// What a new database starts as: tasks, documents, contacts, only a title, or one of
// the saved database templates. The last choice is remembered per device.
import { useEffect, useId, useState } from "react";
import { useT } from "./i18n";
import { api } from "./ui";
import { Select } from "./select";
import { moduleShown, useHiddenModules } from "@/lib/feature-modules-client";

export const DATABASE_KIND_KEY = "flowplan-database-kind";
export type DatabaseChoice = "tasks" | "documents" | "contacts" | "flashcards" | "empty" | `template:${string}`;
type Template = { id: string; name: string; kind: string };

export function rememberedDatabaseKind(): DatabaseChoice {
  try {
    const stored = localStorage.getItem(DATABASE_KIND_KEY) || "";
    // Flashcards switched off since (#378): the default kind instead.
    if (stored === "flashcards" && !moduleShown("flashcards")) return "tasks";
    if (["tasks", "documents", "contacts", "flashcards", "empty"].includes(stored) || stored.startsWith("template:")) return stored as DatabaseChoice;
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
  const hiddenModules = useHiddenModules();
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
    { id: "tasks" as const, label: t("Aufgaben", "Tasks"), hint: t("Status, Priorität, Fälligkeit, Verantwortlich", "Status, priority, due date, assignee") },
    { id: "documents" as const, label: t("Dokumente", "Documents"), hint: t("Titel, Tags, Erstellt, Bearbeitet – Einträge öffnen als ganze Seite", "Title, tags, created, edited – records open as a full page") },
    {
      id: "contacts" as const,
      label: t("Kontakte", "Contacts"),
      hint: t("Name, Firma, E-Mail, Telefon, Adresse, Geburtstag – mit Profilseite, vCard und LDAP", "Name, company, e-mail, phone, address, birthday – with a profile page, vCard and LDAP"),
    },
    {
      id: "flashcards" as const,
      label: t("Lernkarten", "Flashcards"),
      hint: t("Vorderseite, Rückseite, Tags – mit der Ansicht „Lernen“ und Wiederholung in Abständen", "Front, back, tags – with the view “Study” and spaced repetition"),
    },
    { id: "empty" as const, label: t("Leer", "Empty"), hint: t("Nur ein Titel", "Only a title") },
    // Flashcards switched off (#378): no such kind, unless it is chosen.
  ].filter((kind) => kind.id !== "flashcards" || value === "flashcards" || !hiddenModules.includes("flashcards"));
  const hint = kinds.find((kind) => kind.id === value)?.hint || (value.startsWith("template:") ? t("Eine deiner gespeicherten Datenbank-Vorlagen", "One of your saved database templates") : undefined);
  const hintId = useId();
  // "Art" as one select – the kinds, then the saved database templates –
  // with the chosen one's fields as a line below (design review: five
  // segments wrapped into a centred 3 + 2). The "New page" dialog,
  // app/new-page-dialog.css.
  return (
    <div className="np-kind">
      <label className="np-row-label" htmlFor={`${hintId}-select`}>
        {t("Art", "Kind")}
      </label>
      <Select
        id={`${hintId}-select`}
        className="np-kind-select"
        aria-label={t("Art der Datenbank", "Kind of database")}
        aria-describedby={hint ? hintId : undefined}
        value={value}
        onChange={(e) => {
          const next = e.target.value as DatabaseChoice;
          onChange(next, templates.find((template) => `template:${template.id}` === next));
        }}
      >
        {kinds.map((kind) => (
          <option key={kind.id} value={kind.id}>
            {kind.label}
          </option>
        ))}
        {templates.length > 0 && (
          <optgroup label={t("Deine Vorlagen", "Your templates")}>
            {templates.map((template) => (
              <option key={template.id} value={`template:${template.id}`}>
                {template.name}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
      {hint && (
        <small id={hintId} className="np-kind-hint">
          {hint}
        </small>
      )}
    </div>
  );
}
