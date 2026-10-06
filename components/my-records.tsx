"use client";
import { useCallback, useEffect, useState } from "react";
import { BookmarkSimple, X } from "@phosphor-icons/react";
import { useT, useLocale } from "./i18n";
import { Select } from "./select";
import { api, PageIcon } from "./ui";
import type { CrossFilter } from "@/lib/cross-records";

type Record_ = { pageId: string; database: string; icon: string; rowId: string; key: string; title: string; status: string; due: string | null; done: boolean };
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
  const locale = useLocale();
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
  const today = new Date().toISOString().slice(0, 10);
  const date = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(locale === "de" ? "de-DE" : "en-GB", { day: "2-digit", month: "short" });
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
        <label className="checkbox-label">
          <input type="checkbox" checked={filter.mine} onChange={(e) => set({ mine: e.target.checked })} />
          {t("Mir zugewiesen", "Assigned to me")}
        </label>
        <label className="checkbox-label">
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
        <input type="search" aria-label={t("Einträge durchsuchen", "Search records")} placeholder={t("Suchen …", "Search …")} value={filter.query} onChange={(e) => set({ query: e.target.value })} />
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
        <p className="muted">{t("Wird geladen …", "Loading …")}</p>
      ) : !result.records.length ? (
        <p className="muted empty-state">
          {filter.mine
            ? t("Keine passenden Einträge. Einträge gehören dir, wenn du in einer Personen-Eigenschaft stehst.", "No matching records. Records are yours when you are in a person property.")
            : t("Keine passenden Einträge.", "No matching records.")}
        </p>
      ) : (
        <ul className="my-records-list">
          {result.records.map((r) => (
            <li key={r.rowId} data-done={r.done}>
              <button type="button" onClick={() => onOpen(r.pageId, r.rowId)}>
                {r.key && <span className="sprint-row-id">{r.key}</span>}
                <span className="my-record-title">{r.title || t("Ohne Titel", "Untitled")}</span>
              </button>
              <span className="my-record-db">
                <PageIcon name={r.icon} size={13} /> {r.database}
              </span>
              {r.status && <span className="muted">{r.status}</span>}
              {r.due && <span className={`task-due ${!r.done && r.due < today ? "task-due-overdue" : ""}`}>📅 {date(r.due)}</span>}
            </li>
          ))}
        </ul>
      )}
      {result?.limited && <p className="muted">{t("Die ersten 500 Einträge – grenze die Suche ein.", "The first 500 records – narrow the search.")}</p>}
    </div>
  );
}
