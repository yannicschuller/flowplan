"use client";
// Which databases the AI read records from (#80): "Daten aus: Server
// (12 Einträge)" under an answer of the writing assistant or above the
// proposed AI actions.
import { Table } from "@phosphor-icons/react";
import { useT } from "./i18n";
import type { DatabaseNote } from "@/lib/ai/database-note";

export function DatabaseNotes({ notes }: { notes: DatabaseNote[] }) {
  const t = useT();
  if (!notes.length) return null;
  const count = (n: DatabaseNote) =>
    n.included < n.total
      ? t(`${n.included} von ${n.total} Einträgen`, `${n.included} of ${n.total} records`)
      : n.total === 1
        ? t("1 Eintrag", "1 record")
        : t(`${n.total} Einträge`, `${n.total} records`);
  return (
    <p className="ai-writer-linked ai-database-notes">
      <Table size={13} aria-hidden /> <span>{t("Daten aus:", "Data from:")}</span>{" "}
      {notes.map((n, i) => (
        <span key={n.pageId}>
          {i > 0 && ", "}
          <strong>{n.title || t("Ohne Titel", "Untitled")}</strong> ({count(n)})
        </span>
      ))}
    </p>
  );
}
