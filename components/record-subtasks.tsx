"use client";
import { useState } from "react";
import { Plus, TreeStructure } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { cellText } from "@/lib/cell-text";
import { pageLocationHash } from "@/lib/page-location";
import { doneRule, isDone } from "@/lib/database-settings-schema";
import type { Database, Field, Row } from "@/lib/types";

// The subtasks of a record (records whose parent it is), with their state
// and a field to add one; plus the record it belongs to.
export function RecordSubtasks({
  pageId,
  row,
  rows,
  database,
  parent,
  editable,
  act,
}: {
  pageId: string;
  row: Row;
  rows: Row[];
  database: Database;
  parent: Field;
  editable: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
}) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const titleField = database.fields[0];
  const rule = doneRule(database.fields, database.settings);
  const parentOf = (r: Row) => (Array.isArray(r.cells[parent.id]) ? (r.cells[parent.id] as string[])[0] : undefined);
  const children = rows.filter((r) => parentOf(r) === row.id);
  const above = rows.find((r) => r.id === parentOf(row));
  const finished = children.filter((c) => isDone(rule, c.cells)).length;
  if (!children.length && !editable && !above) return null;
  const link = (r: Row) => pageLocationHash({ pageId, rowId: r.id });
  return (
    <section className="settings-section record-subtasks" aria-label={t("Unteraufgaben", "Subtasks")}>
      <h3>
        <TreeStructure aria-hidden /> {t("Unteraufgaben", "Subtasks")}
        {children.length > 0 && rule && (
          <span className="muted">
            {" "}
            · {finished}/{children.length} {t("erledigt", "done")}
          </span>
        )}
      </h3>
      {above && (
        <p className="muted">
          {t("Gehört zu", "Belongs to")} <a href={link(above)}>{cellText(above.cells[titleField.id]) || t("Ohne Titel", "Untitled")}</a>
        </p>
      )}
      {children.length > 0 && (
        <ul>
          {children.map((c) => (
            <li key={c.id} data-done={isDone(rule, c.cells)}>
              <a href={link(c)}>{cellText(c.cells[titleField.id]) || t("Ohne Titel", "Untitled")}</a>
              {rule && <span className="muted">{cellText(c.cells[rule.field.id]) || ""}</span>}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <form
          className="subtask-add"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            setBusy(true);
            try {
              if (await act({ action: "row.create", cells: { [titleField.id]: title.trim(), [parent.id]: [row.id] } })) setTitle("");
            } finally {
              setBusy(false);
            }
          }}
        >
          <input
            aria-label={t("Neue Unteraufgabe", "New subtask")}
            placeholder={t("Unteraufgabe hinzufügen …", "Add subtask …")}
            value={title}
            maxLength={500}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="icon-button" aria-label={t("Hinzufügen", "Add")} disabled={busy || !title.trim()}>
            <Plus />
          </button>
        </form>
      )}
    </section>
  );
}
