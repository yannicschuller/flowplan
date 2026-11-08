"use client";
// "An diesem Tag erledigt" (#169): below a journal day, the database records
// that became done that day (lib/journal-completed.ts). Computed on every
// load, nothing is stored in the day; hidden while there is nothing.
import { useEffect, useState } from "react";
import { CheckCircle } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { api } from "./ui";

type Completed = { pageId: string; rowId: string; title: string; database: string; icon: string; at: number };
const time = new Intl.DateTimeFormat(LOCALE_TAG, { hour: "2-digit", minute: "2-digit" });

export function JournalCompleted({ pageId }: { pageId: string }) {
  const t = useT();
  const [list, setList] = useState<{ items: Completed[]; more: number } | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      api<{ items: Completed[]; more: number }>(`/api/journals/${pageId}/completed?zone=${encodeURIComponent(zone)}`)
        .then((r) => live && setList(r))
        .catch(() => {});
    };
    load();
    // Ticked off in another tab or window: the list follows on return.
    const onFocus = () => document.visibilityState === "visible" && load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [pageId]);
  if (!list?.items.length) return null;
  return (
    <section className="journal-completed" aria-label={t("An diesem Tag erledigt", "Completed this day")}>
      <h3>
        <CheckCircle size={15} weight="fill" /> {t("An diesem Tag erledigt", "Completed this day")}
        <span className="journal-completed-count">{list.items.length + list.more}</span>
      </h3>
      <ul>
        {list.items.map((item) => (
          <li key={`${item.pageId}-${item.rowId}`}>
            <time dateTime={new Date(item.at).toISOString()}>{time.format(new Date(item.at))}</time>
            <a href={`/#page=${item.pageId}&row=${item.rowId}`}>{item.title || t("Ohne Titel", "Untitled")}</a>
            <small>{item.database || t("Datenbank", "Database")}</small>
          </li>
        ))}
      </ul>
      {list.more > 0 && (
        <p className="journal-completed-more">
          {t(`und ${list.more} weitere`, `and ${list.more} more`)}
        </p>
      )}
    </section>
  );
}
