"use client";
// The screen #study, "Lernen" (docs/specs/flashcards.md §2.6, §6.1): every
// deck of the workspace with what is left today – the person's own counts
// from one aggregated query (lib/study-stats.ts studyDue), not a queue per
// deck –, a session per deck, "Alle Stapel lernen" (the decks one after
// the other, each within its own limits), the streak and the statistics
// over all decks – and "Aus Anki importieren" (components/study/anki-import.tsx).
// Also the daily study reminder ("Lernerinnerung", lib/study-reminders.ts):
// on or off and its time, saved with study.reminder for all workspaces.
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { BellRinging, Cards, ChartBar, DownloadSimple, Fire, Play } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { PageIcon, api } from "../ui";
import { Switch } from "../settings-ui";
import { shownPageIcon } from "@/lib/page-link-icons";
import { StudyFocus, studyZoneNow } from "./focus";
import { StudyStatsPanel } from "./stats";
import { useStudyPending } from "./offline";
import { StudyPendingNote } from "./pending";
import type { Space } from "@/lib/types";

const StudyAnkiImport = dynamic(() => import("./anki-import"), { ssr: false });

type DueDeck = { pageId: string; title: string; icon: string; new: number; learning: number; review: number; total: number };
type Due = { day: string; zone: string; decks: DueDeck[]; streak: number; reminder?: string | null };
const left = (d: DueDeck) => d.new + d.learning + d.review;
const DEFAULT_REMINDER = "18:00";

function StudyReminder({ value, onSaved }: { value: string | null; onSaved: (value: string | null) => void }) {
  const t = useT();
  const [draft, setDraft] = useState(value || DEFAULT_REMINDER),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => setDraft(value || DEFAULT_REMINDER), [value]);
  const save = async (next: string | null) => {
    setBusy(true);
    try {
      await api("/api/command", { action: "study.reminder", remindAt: next, zone: studyZoneNow() });
      onSaved(next);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // A new time is saved shortly after it was chosen (phones close their
  // time picker without leaving the field), and when the field is left.
  useEffect(() => {
    if (!value || draft === value || busy) return;
    const timer = setTimeout(() => void save(draft), 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, value]);
  return (
    <section className="study-reminder" aria-labelledby="study-screen-reminder">
      <h3 id="study-screen-reminder">
        <BellRinging aria-hidden /> {t("Lernerinnerung", "Study reminder")}
      </h3>
      <div className="study-reminder-row">
        <Switch checked={!!value} disabled={busy} label={t("Täglich an fällige Karten erinnern", "Remind me daily of due cards")} onChange={(on) => void save(on ? draft : null)} />
        <span>{t("Täglich erinnern um", "Remind me daily at")}</span>
        <input
          type="time"
          step={300}
          value={draft}
          disabled={busy}
          aria-label={t("Uhrzeit der Lernerinnerung", "Time of the study reminder")}
          onChange={(e) => setDraft(e.target.value.slice(0, 5) || DEFAULT_REMINDER)}
          onBlur={() => {
            if (value && draft !== value) void save(draft);
          }}
        />
      </div>
      <p className="muted">
        {t(
          "Nur an Tagen, an denen Karten fällig sind und du noch nicht gelernt hast. Nach 30 Tagen ohne Lernen pausiert die Erinnerung. Wohin sie kommt, stellst du unter Einstellungen → Benachrichtigungen bei „Lernerinnerungen“ ein.",
          "Only on days with cards due that you have not studied yet. After 30 days without studying the reminder pauses. Where it arrives you choose under Settings → Notifications at “Study reminders”.",
        )}
      </p>
      {error && (
        <p className="study-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// New, learning phase, due: coloured numbers with their word, no frame (they
// are no buttons); a zero is quiet. The same three words everywhere.
function StudyCounts({ counts }: { counts: { new: number; learning: number; review: number } }) {
  const t = useT();
  const parts = [
    { key: "new", n: counts.new, label: t("neu", "new") },
    { key: "learning", n: counts.learning, label: t("in der Lernphase", "learning") },
    { key: "review", n: counts.review, label: t("fällig", "due") },
  ];
  return (
    <span className="study-deck-counts">
      {parts.map((p) => (
        <span key={p.key} className={`study-deck-count ${p.key}${p.n ? "" : " zero"}`}>
          <b>{p.n}</b> {p.label}
        </span>
      ))}
    </span>
  );
}

export function StudyScreen({ workspaceId, userId, spaces = [], onOpenPage }: { workspaceId: string; userId?: string; spaces?: Pick<Space, "id" | "name">[]; onOpenPage: (pageId: string) => void }) {
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
  const pending = useStudyPending(userId);
  const decks = due?.decks || [];
  const open = decks.filter((d) => left(d) > 0);
  const total = open.reduce((n, d) => n + left(d), 0);
  const sum = decks.reduce((n, d) => ({ new: n.new + d.new, learning: n.learning + d.learning, review: n.review + d.review }), { new: 0, learning: 0, review: 0 });
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
            <Fire aria-hidden weight="fill" /> {due.streak === 1 ? t("Serie: 1 Tag", "Streak: 1 day") : t(`Serie: ${due.streak} Tage`, `Streak: ${due.streak} days`)}
          </span>
        )}
      </header>
      {error && (
        <p className="study-error" role="alert">
          {error}
        </p>
      )}
      <StudyPendingNote count={pending} />
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
          {/* "Heute dran" counts what a session would show today: new cards,
              cards in the learning phase and due reviews. "Fällig" is only
              the reviews, the same word as in each deck's counts below. */}
          <div className="study-screen-total" aria-live="polite">
            <h3 id="study-screen-today">
              {total === 0
                ? t("Für heute ist alles gelernt.", "Everything is studied for today.")
                : total === 1
                  ? t("Heute dran: 1 Karte", "Today: 1 card")
                  : t(`Heute dran: ${total} Karten`, `Today: ${total} cards`)}
            </h3>
            {total > 0 && <StudyCounts counts={sum} />}
          </div>
          <div className="study-actions">
            <button className="button primary" disabled={!open.length} onClick={() => setSession({ decks: open, index: 0 })}>
              <Play aria-hidden weight="fill" /> {t("Alle Stapel lernen", "Study all decks")}
            </button>
          </div>
          <ul className="study-deck-list">
            {decks.map((d) => (
              <li key={d.pageId} className={left(d) ? "" : "done"}>
                <button type="button" className="study-deck-name" onClick={() => onOpenPage(d.pageId)} title={t("Stapel öffnen", "Open the deck")}>
                  <PageIcon name={shownPageIcon(d.icon, "database")} size={16} />
                  <span>{d.title || t("Ohne Titel", "Untitled")}</span>
                </button>
                <StudyCounts counts={d} />
                <button className="button compact" disabled={!left(d)} onClick={() => setSession({ decks: [d], index: 0 })} aria-label={t(`${d.title || t("Ohne Titel", "Untitled")} lernen`, `Study ${d.title || t("Ohne Titel", "Untitled")}`)}>
                  <Play aria-hidden weight="fill" /> {t("Lernen", "Study")}
                </button>
              </li>
            ))}
          </ul>
          <p className="muted">{t("Die Zahlen gelten für den ganzen Stapel; Ansichten mit Filtern lernen davon nur einen Teil.", "The numbers are for the whole deck; views with filters study only part of it.")}</p>
        </section>
      )}
      {due && decks.length > 0 && <StudyReminder value={due.reminder ?? null} onSaved={(reminder) => setDue((d) => (d ? { ...d, reminder } : d))} />}
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
