"use client";
// The database side of "Meine Aufgaben" (components/my-tasks.tsx, #314):
// records that can be done, from every database, in the same list as the
// tasks from documents. Here are a record's row and the controls that only
// apply to records – the database, a search and the saved views
// (lib/cross-records.ts).
import { useState, type ReactNode } from "react";
import { BookmarkSimple, Database, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Select } from "./select";
import { Avatar, PageIcon } from "./ui";
import { dueLabel, dueState } from "@/lib/task-due";
import type { CrossFilter } from "@/lib/cross-records";

export type TaskRecord = {
  pageId: string;
  database: string;
  icon: string;
  rowId: string;
  key: string;
  title: string;
  rowIcon: string;
  status: string;
  due: string | null;
  done: boolean;
  tracked: boolean;
  people: { id: string; name: string }[];
  // For the board's moves (#564); older servers send neither.
  dueField?: string | null;
  version?: number;
  // In "Alle Arbeitsbereiche" (#564).
  workspaceId?: string;
};
export type RecordView = { id: string; name: string; filter: CrossFilter };
export type RecordsResult = {
  records: TaskRecord[];
  databases: { id: string; title: string }[];
  limited: boolean;
  views: RecordView[];
};

// A status pill tinted like the board's: done green, in progress blue.
const statusTone = (r: TaskRecord) =>
  r.done ? "green" : /^(in arbeit|in progress|doing|in bearbeitung|läuft|en cours|进行中)$/i.test(r.status) ? "blue" : "gray";

// One record among the tasks: the box ticks it off (its status or checkbox,
// as the widgets do), the title opens it; its database, status, due date
// and people follow.
export function RecordRow({
  record: r,
  taskKey,
  checked,
  busy,
  settling,
  onToggle,
  onOpen,
  workspace,
}: {
  record: TaskRecord;
  taskKey: string;
  checked: boolean;
  busy: boolean;
  settling: boolean;
  onToggle: (done: boolean) => void;
  onOpen: () => void;
  // The workspace's label in "Alle Arbeitsbereiche" (#564).
  workspace?: ReactNode;
}) {
  const t = useT();
  const title = r.title || t("Ohne Titel", "Untitled");
  return (
    <li data-task-key={taskKey} className={`my-record${checked ? " checked" : ""}`}>
      <input
        type="checkbox"
        aria-label={t(`${title} erledigt`, `${title} completed`)}
        checked={checked}
        disabled={busy}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <button type="button" className="my-record-main" onClick={onOpen}>
        <span className="my-record-title my-task-text">
          {r.rowIcon && <PageIcon name={r.rowIcon} size={15} className="my-record-icon" />}
          {r.key && (
            <>
              <span className="sprint-row-id">{r.key}</span>{" "}
            </>
          )}
          {title}
        </span>
        {workspace ? (
          <span className="my-record-where">
            <span className="my-record-db">
              <PageIcon name={r.icon} size={13} />
              <span>{r.database || t("Ohne Titel", "Untitled")}</span>
            </span>
            {workspace}
          </span>
        ) : (
          <span className="my-record-db">
            <PageIcon name={r.icon} size={13} />
            <span>{r.database || t("Ohne Titel", "Untitled")}</span>
          </span>
        )}
      </button>
      <span className="my-record-meta">
        {r.status && !settling && <span className={`tag tag-${statusTone(r)} my-record-status`}>{r.status}</span>}
        {r.due && (
          <span className={`task-due task-due-${dueState(r.due, checked)}`}>
            <span className="task-due-icon" aria-hidden="true">📅</span>
            {dueLabel(r.due)}
          </span>
        )}
        {r.people.length > 0 && (
          <span className="my-record-people">
            {r.people.slice(0, 3).map((p) => (
              <Avatar key={p.id} name={p.name} userId={p.id} small />
            ))}
            {r.people.length > 3 && <span className="my-record-more">+{r.people.length - 3}</span>}
          </span>
        )}
      </span>
    </li>
  );
}

// Database, search and "save as view" – labelled as applying to records
// only, since tasks in documents have neither.
export function RecordTools({
  databases,
  database,
  query,
  onDatabase,
  onQuery,
  onSave,
}: {
  databases: { id: string; title: string }[];
  database: string;
  query: string;
  onDatabase: (id: string) => void;
  onQuery: (query: string) => void;
  onSave: (name: string) => Promise<boolean>;
}) {
  const t = useT();
  const [naming, setNaming] = useState<string | null>(null);
  return (
    <div className="record-filters" role="group" aria-label={t("Nur für Einträge aus Datenbanken", "Only for records from databases")}>
      <span className="record-filters-label" aria-hidden="true">
        <Database size={14} />
        {t("Nur Datenbanken:", "Databases only:")}
      </span>
      <Select aria-label={t("Datenbank", "Database")} value={database} onChange={(e) => onDatabase(e.target.value)}>
        <option value="">{t("Alle Datenbanken", "All databases")}</option>
        {databases.map((d) => (
          <option key={d.id} value={d.id}>
            {d.title || t("Ohne Titel", "Untitled")}
          </option>
        ))}
      </Select>
      <span className="record-search">
        <MagnifyingGlass size={14} aria-hidden="true" />
        <input
          type="search"
          aria-label={t("Einträge durchsuchen", "Search records")}
          placeholder={t("Einträge durchsuchen …", "Search records …")}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </span>
      {naming === null ? (
        <button type="button" className="button compact" onClick={() => setNaming("")}>
          <BookmarkSimple /> {t("Als Ansicht speichern", "Save as view")}
        </button>
      ) : (
        <form
          className="record-view-name"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!naming.trim()) return;
            if (await onSave(naming)) setNaming(null);
          }}
        >
          <input
            autoFocus
            aria-label={t("Name der Ansicht", "View name")}
            placeholder={t("z. B. Meine Tickets", "e.g. My tickets")}
            maxLength={80}
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
          />
          <button className="button compact primary">{t("Speichern", "Save")}</button>
          <button type="button" className="icon-button" aria-label={t("Abbrechen", "Cancel")} onClick={() => setNaming(null)}>
            <X />
          </button>
        </form>
      )}
    </div>
  );
}

// The saved views as chips; the one shown is pressed, pressing it again
// leaves it.
export function RecordViews({
  views,
  active,
  onPick,
  onDelete,
}: {
  views: RecordView[];
  active: string;
  onPick: (view: RecordView | null) => void;
  onDelete: (view: RecordView) => void;
}) {
  const t = useT();
  if (!views.length) return null;
  return (
    <div className="record-view-tabs" role="group" aria-label={t("Gespeicherte Ansichten", "Saved views")}>
      {views.map((v) => (
        <span key={v.id} className="chip-group">
          <button
            type="button"
            aria-pressed={active === v.id}
            className="chip-button"
            onClick={() => onPick(active === v.id ? null : v)}
          >
            <BookmarkSimple aria-hidden /> {v.name}
          </button>
          <button
            type="button"
            className="icon-button chip-remove"
            aria-label={t(`Ansicht ${v.name} löschen`, `Delete view ${v.name}`)}
            onClick={() => onDelete(v)}
          >
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}
