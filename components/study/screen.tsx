"use client";
// The screen #study, "Lernen" (docs/specs/flashcards.md §2.6, §6.1): every
// deck of the workspace with what is left today – the person's own counts
// from one aggregated query (lib/study-stats.ts studyDue), not a queue per
// deck –, a session per deck, "Alle fälligen lernen" (the decks one after
// the other, each within its own limits), the streak and the statistics
// over all decks – and "Aus Anki importieren" (components/study/anki-import.tsx).
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Cards, ChartBar, DownloadSimple, Fire, Play } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { PageIcon, api } from "../ui";
import { shownPageIcon } from "@/lib/page-link-icons";
import { StudyFocus, studyZoneNow } from "./focus";
import { StudyStatsPanel } from "./stats";
import type { Space } from "@/lib/types";

const StudyAnkiImport = dynamic(() => import("./anki-import"), { ssr: false });

type DueDeck = { pageId: string; title: string; icon: string; new: number; learning: number; review: number; total: number };
type Due = { day: string; zone: string; decks: DueDeck[]; streak: number };
const left = (d: DueDeck) => d.new + d.learning + d.review;

export function StudyScreen({ workspaceId, spaces = [], onOpenPage }: { workspaceId: string; spaces?: Pick<Space, "id" | "name">[]; onOpenPage: (pageId: string) => void }) {
  const t = useT();
  const [due, setDue] = useState<Due | null>(null),
    [error, setError] = useState(""),
    // The decks of a running session, and which one is on.
    [session, setSession] = useState<{ decks: DueDeck[]; index: number } | null>(null),
    [version, setVersion] = useState(0),
    [anki, setAnki] = useState(false);
  const load = useCallback(async () => {
    try {
      setDue(await api<Due>(`/api/study/due?${new URLSearchParams({ workspace: workspaceId, zone: studyZoneNow() })}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspaceId]);
  useEffect(() => {
    void load();
  }, [load, version]);
  const decks = due?.decks || [];
  const open = decks.filter((d) => left(d) > 0);
  const total = open.reduce((n, d) => n + left(d), 0);
  const current = session ? session.decks[session.index] : null;
  const following = session && session.index + 1 < session.decks.length ? session.decks[session.index + 1] : null;
  return (
    <div className="study-screen">
      <header className="study-screen-head">
        <h1>
          <Cards aria-hidden /> {t("Lernen", "Study")}
        </h1>
        {spaces.length > 0 && (
          <button type="button" className="button compact study-screen-anki" onClick={() => setAnki(true)}>
            <DownloadSimple aria-hidden /> {t("Aus Anki importieren", "Import from Anki")}
          </button>
        )}
        {due && due.streak > 0 && (
          <span className="study-streak" title={t(`${due.streak} Lerntage in Folge`, `${due.streak} study days in a row`)}>
            <Fire aria-hidden weight="fill" /> {t(`Serie: ${due.streak} Tage`, `Streak: ${due.streak} days`)}
          </span>
        )}
      </header>
      {error && (
        <p className="study-error" role="alert">
          {error}
        </p>
      )}
      {!due && !error && <p className="muted">{t("Stapel werden geladen …", "Loading decks …")}</p>}
      {due && !decks.length && (
        <div className="study-empty">
          <Cards size={32} aria-hidden />
          <h3>{t("Noch keine Lernkarten", "No flashcards yet")}</h3>
          <p className="muted">
            {t(
              "Lege eine neue Datenbank der Art „Lernkarten“ an oder füge einer Datenbank die Ansicht „Lernen“ hinzu – jeder Eintrag wird zur Karte.",
              "Create a database of the kind “Flashcards” or add the view “Study” to a database – every record becomes a card.",
            )}
          </p>
        </div>
      )}
      {decks.length > 0 && (
        <section className="study-today" aria-labelledby="study-screen-today">
          <h3 id="study-screen-today">{t("Heute", "Today")}</h3>
          <p className="study-screen-total" aria-live="polite">
            {total === 0 ? t("Für heute ist alles gelernt.", "Everything is studied for today.") : total === 1 ? t("1 Karte ist fällig.", "1 card is due.") : t(`${total} Karten sind fällig.`, `${total} cards are due.`)}
          </p>
          <div className="study-actions">
            <button className="button primary" disabled={!open.length} onClick={() => setSession({ decks: open, index: 0 })}>
              <Play aria-hidden weight="fill" /> {t("Alle fälligen lernen", "Study all due")}
            </button>
          </div>
          <ul className="study-deck-list">
            {decks.map((d) => (
              <li key={d.pageId} className={left(d) ? "" : "done"}>
                <button type="button" className="study-deck-name" onClick={() => onOpenPage(d.pageId)} title={t("Stapel öffnen", "Open the deck")}>
                  <PageIcon name={shownPageIcon(d.icon, "database")} size={16} />
                  <span>{d.title || t("Ohne Titel", "Untitled")}</span>
                </button>
                <span className="study-deck-counts" aria-label={t(`${d.new} neu, ${d.learning} in Lernschritten, ${d.review} fällig`, `${d.new} new, ${d.learning} learning, ${d.review} due`)}>
                  <span className="study-count-chip new">{t(`neu ${d.new}`, `new ${d.new}`)}</span>
                  <span className="study-count-chip learning">{t(`Lernen ${d.learning}`, `learning ${d.learning}`)}</span>
                  <span className="study-count-chip review">{t(`fällig ${d.review}`, `due ${d.review}`)}</span>
                </span>
                <button className="button compact" disabled={!left(d)} onClick={() => setSession({ decks: [d], index: 0 })} aria-label={t(`${d.title || "Ohne Titel"} lernen`, `Study ${d.title || "Untitled"}`)}>
                  <Play aria-hidden weight="fill" /> {t("Lernen", "Study")}
                </button>
              </li>
            ))}
          </ul>
          <p className="muted">{t("Die Zahlen gelten für den ganzen Stapel; Ansichten mit Filtern lernen davon nur einen Teil.", "The numbers are for the whole deck; views with filters study only part of it.")}</p>
        </section>
      )}
      {decks.length > 0 && (
        <section className="study-stats-panel" aria-labelledby="study-screen-stats">
          <h3 id="study-screen-stats">
            <ChartBar aria-hidden /> {t("Statistik aller Stapel", "Statistics of all decks")}
          </h3>
          <StudyStatsPanel workspaceId={workspaceId} version={version} />
        </section>
      )}
      {anki && (
        <StudyAnkiImport
          open={anki}
          onClose={() => {
            setAnki(false);
            setVersion((v) => v + 1);
          }}
          workspaceId={workspaceId}
          spaces={spaces}
          onOpenPage={onOpenPage}
        />
      )}
      {current && (
        <StudyFocus
          key={current.pageId}
          pageId={current.pageId}
          title={current.title || t("Lernen", "Study")}
          next={following ? { title: following.title || t("Ohne Titel", "Untitled"), start: () => setSession((s) => (s ? { ...s, index: s.index + 1 } : s)) } : undefined}
          onClose={() => {
            setSession(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
export default StudyScreen;
