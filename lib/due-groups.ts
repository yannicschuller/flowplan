// Groups by due date for "Meine Aufgaben": tasks from documents and records
// from databases (components/my-tasks.tsx, components/my-records.tsx).
import { localToday } from "./task-due-plugin";

const shift = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
// Group names are German keys; shown in the reader's language.
export const dueGroupName = (name: string, t: (de: string, en: string) => string) =>
  ({
    Überfällig: t("Überfällig", "Overdue"),
    Heute: t("Heute", "Today"),
    "Nächste 7 Tage": t("Nächste 7 Tage", "Next 7 days"),
    Später: t("Später", "Later"),
    "Ohne Datum": t("Ohne Datum", "No date"),
    Erledigt: t("Erledigt", "Completed"),
  })[name] ?? name;
export function groupByDue<T extends { checked: boolean; due: string | null }>(items: T[], today = localToday()) {
  const week = shift(today, 7);
  const groups: [string, T[]][] = [
    ["Überfällig", []],
    ["Heute", []],
    ["Nächste 7 Tage", []],
    ["Später", []],
    ["Ohne Datum", []],
    ["Erledigt", []],
  ];
  const at = (name: string) => groups.find(([n]) => n === name)![1];
  for (const item of items) {
    if (item.checked) at("Erledigt").push(item);
    else if (!item.due) at("Ohne Datum").push(item);
    else if (item.due < today) at("Überfällig").push(item);
    else if (item.due === today) at("Heute").push(item);
    else if (item.due <= week) at("Nächste 7 Tage").push(item);
    else at("Später").push(item);
  }
  return groups.filter(([, list]) => list.length);
}
