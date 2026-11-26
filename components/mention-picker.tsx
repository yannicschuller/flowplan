"use client";
// The mention dialog of "@" (documents, components/editor.tsx, and
// whiteboard texts, components/whiteboard/board-mention.tsx, #567): the
// day of the journal ("@heute", "@2026-10-27"), pages (by title or alias),
// records (the workspace search, only what the person may read) and
// people. The arrows move the highlight while the focus stays in the
// search field, Enter picks, Escape closes. What is picked goes back to
// the caller, which writes it into its own text.
import { useEffect, useId, useState, type ComponentProps, type ReactNode } from "react";
import { CalendarBlank } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api, Modal, PageIcon } from "./ui";
import { matchedAlias, pageAliases } from "@/lib/aliases";
import { journalDayQuery, localDate as todayLocal } from "@/lib/journal-links";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { shownPageIcon } from "@/lib/page-link-icons";

// A page as the dialog needs it (the person's page list: only what they may read).
export type MentionPage = {
  id: string;
  title: string;
  icon?: string;
  kind?: string;
  journal_date?: string | null;
  aliases?: string | null;
};
export type MentionMember = { id: string; name: string };
export type RecordHit = { id: string; rowId: string; title: string; pageTitle?: string; alias?: string; icon?: string };
export type MentionChoice =
  // `title` is what the link shows: the alias it was found by, else the title.
  | { kind: "page"; page: MentionPage; title: string }
  | { kind: "record"; record: RecordHit; title: string }
  | { kind: "person"; member: MentionMember }
  | { kind: "day"; date: string };
// One hit of the dialog: an option of its list.
export type ReferenceOptionProps = ComponentProps<"button"> & { "data-active": boolean };
type Item = { key: string; pick: () => void };

const dayFormat = new Intl.DateTimeFormat(LOCALE_TAG, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const dayLabel = (date: string) => dayFormat.format(new Date(`${date}T00:00:00Z`));

// The day of the journal for a "@heute" pick: the server creates today's
// entry when it is missing and answers with the day's page.
export function linkJournalDay(workspaceId: string, fromPageId: string, date: string) {
  return api<{ dayId: string; title: string }>("/api/command", {
    action: "journal.link",
    workspaceId,
    fromPageId,
    date,
    today: todayLocal(),
  });
}

export function MentionPicker({
  open,
  query,
  onQuery,
  onPick,
  onClose,
  onUnmatched,
  onCloseAutoFocus,
  pages,
  members,
  workspaceId,
  excludePageId,
  excludeRowId,
  extra,
}: {
  open: boolean;
  query: string;
  onQuery: (query: string) => void;
  onPick: (choice: MentionChoice) => void;
  onClose: () => void;
  // Escape, or Enter without a hit (opened by "@": the caller types the
  // "@" and the search into the text).
  onUnmatched?: () => void;
  onCloseAutoFocus?: (event: Event) => void;
  pages: MentionPage[];
  members: MentionMember[];
  workspaceId?: string;
  // The page (and record) the text belongs to: not offered.
  excludePageId?: string;
  excludeRowId?: string;
  // More hits after the pages (the document's headings and blocks).
  extra?: { items: Item[]; render: (option: (key: string) => ReferenceOptionProps) => ReactNode };
}) {
  const t = useT();
  const listId = useId();
  const [active, setActive] = useState<string | null>(null);
  const term = query.trim().toLowerCase();
  // Pages match by title or by an alias ("Chauffage · PAC"). Only while the
  // dialog is open: a workspace with years of journal days has thousands.
  const found = !open
    ? []
    : pages
        .flatMap((p): { page: MentionPage; alias?: string }[] => {
          if (p.id === excludePageId) return [];
          if (!term || p.title.toLowerCase().includes(term)) return [{ page: p, alias: undefined }];
          const alias = matchedAlias(p.title, pageAliases(p), term);
          return alias ? [{ page: p, alias }] : [];
        })
        // Journal days after all other pages (a journal has hundreds).
        .sort((a, b) => Number(!!a.page.journal_date) - Number(!!b.page.journal_date));
  // "@heute", "@gestern", "@2026-10-27": a link to that day of the journal.
  const day = journalDayQuery(term);
  const journalDays = new Set(open ? pages.filter((p) => p.journal_date).map((p) => p.journal_date) : []);
  // A day without a journal entry (other than today) cannot be linked.
  const dayOpen = !!day && (day.date === todayLocal() || journalDays.has(day.date));
  const records = useRecordReferences(workspaceId, open ? query : "", excludeRowId);
  const people = open ? members.filter((u) => !term || u.name.toLowerCase().includes(term)) : [];
  const untitled = t("Ohne Titel", "Untitled");
  const items: Item[] = [
    ...(day && dayOpen ? [{ key: "day", pick: () => onPick({ kind: "day", date: day.date }) }] : []),
    ...found.map(({ page, alias }) => ({
      key: `page:${page.id}`,
      // Found by an alias: the alias is the link text.
      pick: () => onPick({ kind: "page", page, title: alias || page.title || untitled }),
    })),
    ...(extra?.items || []),
    ...records.map((record) => ({
      key: `record:${record.rowId}`,
      pick: () => onPick({ kind: "record", record, title: record.alias || record.title || untitled }),
    })),
    ...people.map((member) => ({ key: `member:${member.id}`, pick: () => onPick({ kind: "person", member }) })),
  ];
  // The highlight follows its hit, not its place: records and blocks that
  // arrive later from the server do not move it. It starts at the first hit
  // when the dialog opens or the search changes, and goes back there when
  // its hit is gone. It stays in view; the field names it
  // (aria-activedescendant).
  const activeFound = items.findIndex((item) => item.key === active);
  const index = Math.max(0, activeFound);
  const optionId = (i: number) => `${listId}-option-${i}`;
  useEffect(() => {
    setActive(null);
  }, [open, query]);
  const gone = active !== null && activeFound < 0;
  useEffect(() => {
    if (gone) setActive(null);
  }, [gone]);
  useEffect(() => {
    if (open) document.getElementById(optionId(index))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index]);
  const indexes = new Map(items.map((item, i) => [item.key, i]));
  const option = (key: string): ReferenceOptionProps => {
    const i = indexes.get(key) ?? -1;
    return {
      type: "button",
      role: "option",
      id: optionId(i),
      "aria-selected": i === index,
      "data-active": i === index,
      onMouseMove: () => i !== index && setActive(key),
      onClick: () => items[i]?.pick(),
    };
  };
  return (
    <Modal
      onCloseAutoFocus={onCloseAutoFocus}
      open={open}
      onEscapeKeyDown={() => onUnmatched?.()}
      onClose={onClose}
      title={t("Seite, Eintrag oder Person erwähnen", "Mention a page, record or person")}
    >
      <div className="reference-list">
        <input
          className="input"
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={`${listId}-list`}
          aria-autocomplete="list"
          aria-activedescendant={items.length ? optionId(index) : undefined}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            // The arrows move the highlight while the focus stays here.
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const count = items.length;
              if (count) setActive(items[(index + (e.key === "ArrowDown" ? 1 : count - 1)) % count].key);
            } else if (e.key === "Enter") {
              e.preventDefault();
              const item = items[index];
              if (item) item.pick();
              else onUnmatched?.();
            }
          }}
          placeholder={t("Suchen …", "Search …")}
          aria-label={t("Seiten, Einträge und Personen suchen", "Search pages, records and people")}
        />
        <div id={`${listId}-list`} role="listbox" aria-label={t("Seite, Eintrag oder Person erwähnen", "Mention a page, record or person")}>
          {day && (
            <div role="group" aria-labelledby={`${listId}-day`}>
              <h3 id={`${listId}-day`} role="presentation">{t("Journal", "Journal")}</h3>
              <button
                className="reference-day"
                disabled={!dayOpen}
                {...(dayOpen ? option("day") : { role: "option", "aria-selected": false, "aria-disabled": true })}
              >
                <CalendarBlank />
                <span>
                  {day.label === "today" ? t("Heute", "Today") : day.label === "yesterday" ? t("Gestern", "Yesterday") : day.date}
                  <small className="muted"> · {dayLabel(day.date)}</small>
                  {!dayOpen && <small className="muted"> · {t("kein Eintrag", "no entry")}</small>}
                </span>
              </button>
            </div>
          )}
          {found.length > 0 && (
            <div role="group" aria-labelledby={`${listId}-pages`}>
              <h3 id={`${listId}-pages`} role="presentation">{t("Seiten", "Pages")}</h3>
              {found.map(({ page: p, alias }) => (
                <button key={p.id} {...option(`page:${p.id}`)}>
                  <PageIcon name={shownPageIcon(p.icon || "", p.kind || "document")} />
                  {p.title}
                  {alias && <span className="alias-hit"> · {alias}</span>}
                </button>
              ))}
            </div>
          )}
          {extra?.render(option)}
          <RecordReferences hits={records} query={query} labelId={`${listId}-records`} option={option} />
          {people.length > 0 && (
            <div role="group" aria-labelledby={`${listId}-people`}>
              <h3 id={`${listId}-people`} role="presentation">{t("Personen", "People")}</h3>
              {people.map((u) => (
                <button key={u.id} {...option(`member:${u.id}`)}>
                  @{u.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Records for the mention dialog: the workspace search (kind "row") finds
// them and leaves out what the person may not read.
function useRecordReferences(workspaceId: string | undefined, query: string, exclude?: string) {
  const [hits, setHits] = useState<RecordHit[]>([]);
  const term = query.trim();
  useEffect(() => {
    if (!workspaceId || !term) {
      setHits([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      api<(RecordHit & { rowId?: string })[]>(`/api/search?workspace=${workspaceId}&kind=row&q=${encodeURIComponent(term)}`)
        .then((found) => {
          if (!active) return;
          const seen = new Set<string>();
          setHits(
            found
              .filter((hit): hit is RecordHit => {
                if (!hit.rowId || hit.rowId === exclude || seen.has(hit.rowId)) return false;
                seen.add(hit.rowId);
                return true;
              })
              .slice(0, 20),
          );
        })
        .catch(() => active && setHits([]));
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [workspaceId, term, exclude]);
  return hits;
}
function RecordReferences({
  hits,
  query,
  labelId,
  option,
}: {
  hits: RecordHit[];
  query: string;
  labelId: string;
  option: (key: string) => ReferenceOptionProps;
}) {
  const t = useT();
  return (
    <div role="group" aria-labelledby={labelId}>
      <h3 id={labelId} role="presentation">{t("Einträge", "Records")}</h3>
      {!query.trim() && <p className="muted reference-hint">{t("Tippe, um Einträge aus Datenbanken zu finden.", "Type to find records in databases.")}</p>}
      {hits.map((hit) => (
        <button key={hit.rowId} {...option(`record:${hit.rowId}`)}>
          <PageIcon name={shownPageIcon(hit.icon, "record")} />
          <span>
            {hit.title || t("Ohne Titel", "Untitled")}
            {hit.alias && <span className="alias-hit"> · {hit.alias}</span>}
            {hit.pageTitle && <small className="muted"> · {hit.pageTitle}</small>}
          </span>
        </button>
      ))}
    </div>
  );
}
