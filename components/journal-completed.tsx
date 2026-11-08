"use client";
// "An diesem Tag erledigt" (#169): below a journal day, the database records
// that became done that day (lib/journal-completed.ts). Computed on every
// load, nothing is stored in the day; hidden while there is nothing.
// "Alle / Nur meine" in the header: the server filters (mine=1), and the
// choice is the reader's per journal on all devices (journal.completedMine).
import { useEffect, useRef, useState } from "react";
import { CheckCircle } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { api } from "./ui";

type Completed = { pageId: string; rowId: string; title: string; database: string; icon: string; at: number };
type List = { items: Completed[]; more: number; mine: boolean; all: number };
const time = new Intl.DateTimeFormat(LOCALE_TAG, { hour: "2-digit", minute: "2-digit" });

export function JournalCompleted({ pageId, journalId }: { pageId: string; journalId: string }) {
  const t = useT();
  const [list, setList] = useState<List | null>(null);
  // The filter shown; null until the server answered with the reader's choice.
  const mine = useRef<boolean | null>(null);
  const live = useRef(true);
  const load = () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const filter = mine.current === null ? "" : `&mine=${mine.current ? 1 : 0}`;
    api<List>(`/api/journals/${pageId}/completed?zone=${encodeURIComponent(zone)}${filter}`)
      .then((r) => {
        // An answer for the other filter, overtaken by a click meanwhile.
        if (!live.current || (mine.current !== null && r.mine !== mine.current)) return;
        mine.current = r.mine;
        setList(r);
      })
      .catch(() => {});
  };
  useEffect(() => {
    live.current = true;
    load();
    // Ticked off in another tab or window: the list follows on return.
    const onFocus = () => document.visibilityState === "visible" && load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      live.current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);
  const choose = (only: boolean) => {
    if (mine.current === only) return;
    mine.current = only;
    setList((current) => (current ? { ...current, mine: only } : current));
    load();
    void api("/api/command", { action: "journal.completedMine", pageId: journalId, mine: only }).catch(() => {});
  };
  // Hidden while nothing at all was completed that day.
  if (!list?.all) return null;
  const name = `journal-completed-${pageId}`;
  return (
    <section className="journal-completed" aria-label={t("An diesem Tag erledigt", "Completed this day")}>
      <h3>
        <CheckCircle size={15} weight="fill" /> {t("An diesem Tag erledigt", "Completed this day")}
        <span className="journal-completed-count">{list.items.length + list.more}</span>
        <span className="segmented journal-completed-filter" role="radiogroup" aria-label={t("Erledigte Datensätze", "Completed records")}>
          <label data-active={!list.mine}>
            <input type="radio" name={name} checked={!list.mine} onChange={() => choose(false)} />
            {t("Alle", "All")}
          </label>
          <label data-active={list.mine}>
            <input type="radio" name={name} checked={list.mine} onChange={() => choose(true)} />
            {t("Nur meine", "Only mine")}
          </label>
        </span>
      </h3>
      {list.items.length ? (
        <ul>
          {list.items.map((item) => (
            <li key={`${item.pageId}-${item.rowId}`}>
              <time dateTime={new Date(item.at).toISOString()}>{time.format(new Date(item.at))}</time>
              <a href={`/#page=${item.pageId}&row=${item.rowId}`}>{item.title || t("Ohne Titel", "Untitled")}</a>
              <small>{item.database || t("Datenbank", "Database")}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="journal-completed-empty">
          {t("Nichts davon hast du erledigt oder ist dir zugewiesen.", "None of it was done by you or is assigned to you.")}
        </p>
      )}
      {list.more > 0 && (
        <p className="journal-completed-more">
          {t(`und ${list.more} weitere`, `and ${list.more} more`)}
        </p>
      )}
    </section>
  );
}
