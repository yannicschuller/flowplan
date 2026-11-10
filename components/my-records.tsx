"use client";
import { useCallback, useEffect, useState } from "react";
import { BookmarkSimple, CheckCircle, Circle, CircleDashed, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Select } from "./select";
import { api, Avatar, PageIcon } from "./ui";
import { ListSkeleton } from "./skeleton";
import { dueLabel, dueState } from "@/lib/task-due-plugin";
import { dueGroupName, groupByDue } from "@/lib/due-groups";
import type { CrossFilter } from "@/lib/cross-records";

type Record_ = {
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
};
type Result = { records: Record_[]; databases: { id: string; title: string }[]; limited: boolean; views: { id: string; name: string; filter: CrossFilter }[] };
const initial: CrossFilter = { mine: true, open: true, due: "any", databases: [], query: "" };

// Records from every database in one list, with filters that can be saved
// as named views ("All my open tickets in all projects").
export function MyRecords({
  workspaceId,
  onOpen,
  onError,
}: {
  workspaceId: string;
  onOpen: (pageId: string, rowId: string) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState<CrossFilter>(initial);
  const [active, setActive] = useState<string>("");
  const [result, setResult] = useState<Result | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setResult(await api<Result>(`/api/records?workspace=${workspaceId}&filter=${encodeURIComponent(JSON.stringify(filter))}`));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [workspaceId, filter, onError]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), filter.query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, filter.query]);
  const set = (patch: Partial<CrossFilter>) => {
    setActive("");
    setFilter({ ...filter, ...patch });
  };
  // A status pill tinted like the board's: done green, in progress blue.
  const statusTone = (r: Record_) =>
    r.done ? "green" : /^(in arbeit|in progress|doing|in bearbeitung|läuft)$/i.test(r.status) ? "blue" : "gray";
  const row = (r: Record_) => (
    <li key={r.rowId} className="my-record" data-done={r.done}>
      {r.tracked ? (
        <span className="my-record-state" role="img" aria-label={r.done ? t("Erledigt", "Completed") : t("Offen", "Open")} title={r.done ? t("Erledigt", "Completed") : t("Offen", "Open")}>
          {r.done ? <CheckCircle size={18} weight="fill" /> : <Circle size={18} />}
        </span>
      ) : (
        <span className="my-record-state none" aria-hidden="true">
          <CircleDashed size={18} />
        </span>
      )}
      <button type="button" className="my-record-main" onClick={() => onOpen(r.pageId, r.rowId)}>
        <span className="my-record-title">
          {r.rowIcon && <PageIcon name={r.rowIcon} size={15} className="my-record-icon" />}
          {r.key && (
            <>
              <span className="sprint-row-id">{r.key}</span>{" "}
            </>
          )}
          {r.title || t("Ohne Titel", "Untitled")}
        </span>
        <span className="my-record-db">
          <PageIcon name={r.icon} size={13} />
          <span>{r.database || t("Ohne Titel", "Untitled")}</span>
        </span>
      </button>
      <span className="my-record-meta">
        {r.status && <span className={`tag tag-${statusTone(r)} my-record-status`}>{r.status}</span>}
        {r.due && (
          <span className={`task-due task-due-${dueState(r.due, r.done)}`}>
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
  return (
    <div className="my-records">
      {result && (
        <div className="record-view-tabs" role="tablist" aria-label={t("Gespeicherte Ansichten", "Saved views")}>
          <button role="tab" aria-selected={!active} className="chip-button" onClick={() => (setActive(""), setFilter(initial))}>
            {t("Meine offenen", "My open ones")}
          </button>
          {result.views.map((v) => (
            <span key={v.id} className="chip-group">
              <button role="tab" aria-selected={active === v.id} className="chip-button" onClick={() => (setActive(v.id), setFilter(v.filter))}>
                <BookmarkSimple aria-hidden /> {v.name}
              </button>
              <button
                className="icon-button chip-remove"
                aria-label={t(`Ansicht ${v.name} löschen`, `Delete view ${v.name}`)}
                onClick={async () => {
                  await api("/api/command", { action: "recordView.delete", viewId: v.id }).catch((e) => onError((e as Error).message));
                  if (active === v.id) setActive("");
                  void load();
                }}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="record-filters">
        <label className="record-toggle">
          <input type="checkbox" checked={filter.mine} onChange={(e) => set({ mine: e.target.checked })} />
          {t("Mir zugewiesen", "Assigned to me")}
        </label>
        <label className="record-toggle">
          <input type="checkbox" checked={filter.open} onChange={(e) => set({ open: e.target.checked })} />
          {t("Nur offene", "Open only")}
        </label>
        <Select aria-label={t("Fälligkeit", "Due")} value={filter.due} onChange={(e) => set({ due: e.target.value as CrossFilter["due"] })}>
          <option value="any">{t("Alle Termine", "Any date")}</option>
          <option value="overdue">{t("Überfällig", "Overdue")}</option>
          <option value="week">{t("Bis in 7 Tagen", "Within 7 days")}</option>
          <option value="dated">{t("Mit Datum", "With a date")}</option>
        </Select>
        <Select
          aria-label={t("Datenbank", "Database")}
          value={filter.databases[0] || ""}
          onChange={(e) => set({ databases: e.target.value ? [e.target.value] : [] })}
        >
          <option value="">{t("Alle Datenbanken", "All databases")}</option>
          {result?.databases.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </Select>
        <span className="record-search">
          <MagnifyingGlass size={14} aria-hidden="true" />
          <input type="search" aria-label={t("Einträge durchsuchen", "Search records")} placeholder={t("Suchen …", "Search …")} value={filter.query} onChange={(e) => set({ query: e.target.value })} />
        </span>
        {naming === null ? (
          <button className="button compact" onClick={() => setNaming("")}>
            <BookmarkSimple /> {t("Als Ansicht speichern", "Save as view")}
          </button>
        ) : (
          <form
            className="record-view-name"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!naming.trim()) return;
              try {
                const saved = await api<{ id: string }>("/api/command", { action: "recordView.save", workspaceId, name: naming, filter });
                setNaming(null);
                await load();
                setActive(saved.id);
              } catch (err) {
                onError((err as Error).message);
              }
            }}
          >
            <input autoFocus aria-label={t("Name der Ansicht", "View name")} placeholder={t("z. B. Meine Tickets", "e.g. My tickets")} maxLength={80} value={naming} onChange={(e) => setNaming(e.target.value)} />
            <button className="button compact primary">{t("Speichern", "Save")}</button>
            <button type="button" className="icon-button" aria-label={t("Abbrechen", "Cancel")} onClick={() => setNaming(null)}>
              <X />
            </button>
          </form>
        )}
      </div>
      {!result ? (
        <ListSkeleton rows={4} />
      ) : !result.records.length ? (
        <p className="muted empty-state">
          {filter.mine
            ? t("Keine passenden Einträge. Einträge gehören dir, wenn du in einer Personen-Eigenschaft stehst.", "No matching records. Records are yours when you are in a person property.")
            : t("Keine passenden Einträge.", "No matching records.")}
        </p>
      ) : (
        groupByDue(result.records.map((r) => ({ ...r, checked: r.done }))).map(([name, list]) => (
          <section key={name} className={`my-records-group ${name === "Überfällig" ? "overdue" : ""}`}>
            <h2>
              {dueGroupName(name, t)} <small>{list.length}</small>
            </h2>
            <ul className="my-records-list">{list.map(row)}</ul>
          </section>
        ))
      )}
      {result?.limited && <p className="muted">{t("Die ersten 500 Einträge – grenze die Suche ein.", "The first 500 records – narrow the search.")}</p>}
    </div>
  );
}
