"use client";
// The view "Lernen" of a database (docs/specs/flashcards.md §2.4): the deck's
// overview for the person – what is left today (new · learning · due), the
// start of a session (components/study/focus.tsx), "Heute mehr lernen",
// their own limits – and, with write access, the card mapping ("Karten
// einrichten"). The mapping belongs to the database (settings.study); the
// view's filters only pick a subset of its cards, like a sub-deck. Reading
// is enough to study: the learning state is the person's own.
// Also here: the statistics of the deck (components/study/stats.tsx), the
// import of cards from text or a file (components/study/import.tsx, write
// access) and the CSV export of the cards, with the person's own learning
// state on request.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ChartBar, Cards, CaretDown, DownloadSimple, GearSix, Play, SlidersHorizontal, Sparkle, UploadSimple } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal, api, needsConnection } from "./ui";
import { Select } from "./select";
import { useAiAvailability } from "./ai-context";
import { safeCollisionPadding } from "./safe-area";
import { StudyFocus, studyZoneNow, type StudyOverview } from "./study/focus";
import { NotOffline, studyLoad, useStudyPending } from "./study/offline";
import { StudyPendingNote } from "./study/pending";
import { tr } from "@/lib/locale-tag";
import { StudyImport } from "./study/import";
import { StudyStatsPanel } from "./study/stats";
import { deriveCards, needsDocument } from "@/lib/study-content";
import { filterCount, effectiveFilterGroup } from "@/lib/database-filters";
import { STUDY_FIELD_TYPES, cardTypes, suggestStudySettings, studySettingsSchema, typeOfOption, type CardType, type StudySettings } from "@/lib/study-schema";
import type { Database, Page, Row, View } from "@/lib/types";

// From the server, or offline from the device's copy of the deck
// (components/study/offline.ts).
export async function loadStudy(pageId: string, viewId: string | undefined, limit: number, userId?: string) {
  try {
    return await studyLoad<StudyOverview>(pageId, { viewId, limit, zone: studyZoneNow(), userId });
  } catch (error) {
    if (error instanceof NotOffline) throw new Error(tr("Dieser Stapel ist auf diesem Gerät nicht offline verfügbar.", "This deck is not available offline on this device."));
    throw error;
  }
}

export default function DatabaseStudy({
  page,
  database,
  view,
  rows,
  editable,
  act,
}: {
  page: Page;
  database: Database;
  view: View;
  rows: Row[];
  editable: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
  onOpenRow?: (rowId: string) => void;
}) {
  const t = useT();
  const mapping = database.settings?.study;
  // "Mit KI erstellen" (components/study/ai-cards.tsx, opened by workspace-app).
  const aiCards = useAiAvailability("flashcards", null);
  const [overview, setOverview] = useState<StudyOverview | null>(null),
    [error, setError] = useState(""),
    [setup, setSetup] = useState(false),
    [prefs, setPrefs] = useState(false),
    [session, setSession] = useState(false),
    [importing, setImporting] = useState(false),
    [stats, setStats] = useState(false),
    [statsVersion, setStatsVersion] = useState(0),
    [notice, setNotice] = useState("");
  // Ratings made offline that wait on this device (components/study/offline.ts).
  const userRef = useRef<string | undefined>(undefined);
  const pending = useStudyPending(overview?.userId, page.id);
  const reload = useCallback(async () => {
    try {
      const next = await loadStudy(page.id, view.id, 0, userRef.current);
      userRef.current = next.userId ?? userRef.current;
      setOverview(next);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page.id, view.id]);
  // Sent meanwhile: the counts again.
  const sentRef = useRef(pending);
  useEffect(() => {
    if (sentRef.current > pending) void reload();
    sentRef.current = pending;
  }, [pending, reload]);
  const mappingKey = JSON.stringify(mapping || null);
  const filterKey = JSON.stringify(effectiveFilterGroup(view));
  useEffect(() => {
    void reload();
  }, [reload, mappingKey, filterKey, database.version]);
  // Cards added elsewhere (the AI dialog, components/study/ai-cards.tsx).
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === page.id) void reload();
    };
    window.addEventListener("flowplan:study-changed", changed);
    return () => window.removeEventListener("flowplan:study-changed", changed);
  }, [reload, page.id]);
  // A new study view of a database without a mapping opens the setup.
  useEffect(() => {
    if (!mapping && editable) setSetup(true);
  }, [mapping, editable]);
  const more = async (b: { new?: number; review?: number }) => {
    try {
      setOverview(await api<StudyOverview>("/api/command", { action: "study.prefs", pageId: page.id, zone: studyZoneNow(), more: b }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const setupDialog = (
    <StudySetup
      open={setup}
      onClose={() => setSetup(false)}
      database={database}
      rows={rows}
      onSave={async (settings) => {
        const done = await act({ action: "study.settings", settings });
        if (done) {
          setSetup(false);
          await reload();
        }
      }}
    />
  );
  if (!mapping || (overview && !overview.configured))
    return (
      <div className="study-overview study-empty">
        <Cards size={32} aria-hidden />
        <h3>{t("Lernkarten aus dieser Datenbank", "Flashcards from this database")}</h3>
        <p className="muted">
          {t(
            "Jeder Eintrag wird zur Karte: Wähle, was auf die Vorderseite und was auf die Rückseite kommt. Flowplan plant die Wiederholungen für jede Person einzeln.",
            "Every record becomes a card: choose what goes on the front and what on the back. Flowplan schedules the reviews for each person on their own.",
          )}
        </p>
        {editable ? (
          <button className="button primary" onClick={() => setSetup(true)}>
            <GearSix aria-hidden /> {t("Karten einrichten", "Set up cards")}
          </button>
        ) : (
          <p className="muted">{t("Jemand mit Schreibrecht muss die Karten zuerst einrichten.", "Someone with write access has to set up the cards first.")}</p>
        )}
        {setupDialog}
      </div>
    );
  const counts = overview?.counts;
  const left = counts ? counts.new + counts.learning + counts.review : 0;
  const filters = filterCount(effectiveFilterGroup(view));
  return (
    <div className="study-overview">
      <section className="study-today" aria-labelledby={`study-today-${view.id}`}>
        <h3 id={`study-today-${view.id}`}>{t("Heute", "Today")}</h3>
        {error && <p className="study-error" role="alert">{error}</p>}
        <StudyPendingNote count={pending} />
        {overview?.blocked === "hidden" && (
          <p className="muted">{t("Eine Kartenseite ist eine Eigenschaft, die du nicht sehen darfst – hier gibt es für dich keine Karten.", "A side of the cards is a property you may not see – there are no cards for you here.")}</p>
        )}
        <ul className="study-counts" aria-live="polite">
          <li className="study-count new">
            <strong>{counts?.new ?? "–"}</strong> {t("neu", "new")}
          </li>
          <li className="study-count learning">
            <strong>{counts?.learning ?? "–"}</strong> {t("in Lernschritten", "in learning steps")}
          </li>
          <li className="study-count review">
            <strong>{counts?.review ?? "–"}</strong> {t("fällig", "due")}
          </li>
        </ul>
        <div className="study-actions">
          <button className="button primary" disabled={!overview || left === 0} onClick={() => setSession(true)}>
            <Play aria-hidden weight="fill" /> {t("Lernen starten", "Start studying")}
          </button>
          <Dropdown.Root>
            <Dropdown.Trigger asChild>
              <button className="button" disabled={!overview}>
                {t("Heute mehr lernen", "Study more today")} <CaretDown aria-hidden />
              </button>
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown" align="start" sideOffset={4}>
                <Dropdown.Item className="dropdown-item" onSelect={() => void more({ new: 10 })}>
                  <span>{t("+10 neue Karten", "+10 new cards")}</span>
                </Dropdown.Item>
                <Dropdown.Item className="dropdown-item" onSelect={() => void more({ review: 50 })}>
                  <span>{t("+50 Wiederholungen", "+50 reviews")}</span>
                </Dropdown.Item>
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        </div>
        {notice && (
          <p className="study-notice" role="status">
            {notice}
          </p>
        )}
        {overview && left === 0 && overview.total > 0 && (
          <p className="muted study-done-line">
            {overview.nextDue
              ? t(`Für jetzt geschafft – die nächste Karte ist um ${new Date(overview.nextDue).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} dran.`, `Done for now – the next card is up at ${new Date(overview.nextDue).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`)
              : t("Für heute geschafft.", "Done for today.")}
          </p>
        )}
        {overview && overview.total === 0 && overview.blocked !== "hidden" && (
          <p className="muted study-done-line">
            {t("Noch keine Karten: Lege Einträge mit Vorder- und Rückseite an.", "No cards yet: add records with a front and a back.")}
          </p>
        )}
      </section>
      {overview?.configured && (
        <section className="study-deck" aria-label={t("Stapel", "Deck")}>
          <p className="muted">
            {t(`${overview.total} Karten`, `${overview.total} cards`)} · {t(`${overview.states.new} neu`, `${overview.states.new} new`)} ·{" "}
            {t(`${overview.states.learning} in Lernschritten`, `${overview.states.learning} in learning steps`)} · {t(`${overview.states.review} in Wiederholung`, `${overview.states.review} in review`)}
          </p>
          <p className="muted">
            {t(
              `Pro Tag: ${overview.limits.new} neue, ${overview.limits.review} Wiederholungen · Behaltensrate ${Math.round(overview.params.retention * 100)} %`,
              `Per day: ${overview.limits.new} new, ${overview.limits.review} reviews · retention ${Math.round(overview.params.retention * 100)} %`,
            )}
          </p>
          {filters > 0 && <p className="muted">{t(`Diese Ansicht lernt nur Karten, die zu ihren ${filters} Filtern passen.`, `This view studies only cards that match its ${filters} filters.`)}</p>}
          <div className="study-deck-buttons">
            <button className="button compact" aria-expanded={stats} onClick={() => setStats((s) => !s)}>
              <ChartBar aria-hidden /> {t("Statistik", "Statistics")}
            </button>
            <button className="button compact" onClick={() => setPrefs(true)}>
              <SlidersHorizontal aria-hidden /> {t("Meine Einstellungen", "My settings")}
            </button>
            {editable && (
              <button className="button compact" onClick={() => setImporting(true)}>
                <UploadSimple aria-hidden /> {t("Karten importieren", "Import cards")}
              </button>
            )}
            {editable && aiCards !== "hidden" && (
              <button className="button compact" onClick={() => window.dispatchEvent(new CustomEvent("flowplan:flashcards-ai", { detail: { deckId: page.id } }))}>
                <Sparkle aria-hidden /> {t("Mit KI erstellen", "Create with AI")}
              </button>
            )}
            <Dropdown.Root>
              <Dropdown.Trigger asChild>
                <button className="button compact">
                  <DownloadSimple aria-hidden /> {t("Exportieren", "Export")} <CaretDown aria-hidden />
                </button>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown" align="start" sideOffset={4}>
                  <Dropdown.Item asChild className="dropdown-item">
                    <a href={`/api/pages/${page.id}/study/export?${new URLSearchParams({ zone: studyZoneNow(), view: view.id })}`} download onClick={(e) => needsConnection() && e.preventDefault()}>
                      <span>{t("Karten als CSV", "Cards as CSV")}</span>
                    </a>
                  </Dropdown.Item>
                  <Dropdown.Item asChild className="dropdown-item">
                    <a href={`/api/pages/${page.id}/study/export?${new URLSearchParams({ zone: studyZoneNow(), view: view.id, state: "1" })}`} download onClick={(e) => needsConnection() && e.preventDefault()}>
                      <span>{t("Karten mit meinem Lernstand als CSV", "Cards with my learning state as CSV")}</span>
                    </a>
                  </Dropdown.Item>
                  <Dropdown.Item asChild className="dropdown-item">
                    <a href={`/api/pages/${page.id}/study/export?${new URLSearchParams({ zone: studyZoneNow(), view: view.id, format: "apkg" })}`} download onClick={(e) => needsConnection() && e.preventDefault()}>
                      <span>{t("Als Anki-Paket (.apkg, ohne Lernstand)", "As an Anki package (.apkg, without learning state)")}</span>
                    </a>
                  </Dropdown.Item>
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
            {editable && (
              <button className="button compact" onClick={() => setSetup(true)}>
                <GearSix aria-hidden /> {t("Karten einrichten", "Set up cards")}
              </button>
            )}
          </div>
        </section>
      )}
      {overview?.configured && stats && (
        <section className="study-stats-panel" aria-label={t("Statistik", "Statistics")}>
          <h3>{t("Statistik", "Statistics")}</h3>
          <StudyStatsPanel pageId={page.id} version={statsVersion} />
        </section>
      )}
      {mapping && editable && (
        <StudyImport
          open={importing}
          onClose={() => setImporting(false)}
          database={database}
          settings={mapping}
          act={act}
          onDone={(count) => {
            setImporting(false);
            setNotice(count === 1 ? t("1 Eintrag importiert.", "1 record imported.") : t(`${count} Einträge importiert.`, `${count} records imported.`));
            void reload();
          }}
        />
      )}
      {setupDialog}
      {overview?.configured && (
        <StudyPrefs
          open={prefs}
          onClose={() => setPrefs(false)}
          overview={overview}
          onSave={async (b) => {
            try {
              setOverview(await api<StudyOverview>("/api/command", { action: "study.prefs", pageId: page.id, zone: studyZoneNow(), ...b }));
              setPrefs(false);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      )}
      {session && (
        <StudyFocus
          pageId={page.id}
          viewId={view.id}
          title={page.title || t("Lernen", "Study")}
          onClose={() => {
            setSession(false);
            setStatsVersion((v) => v + 1);
            void reload();
          }}
        />
      )}
    </div>
  );
}

type SideChoice = string;
// A side as the value of a choice: "field:<id>" or "document:<part>".
const sideValue = (side: StudySettings["front"] | StudySettings["back"]) => ("field" in side ? `field:${side.field}` : `document:${side.document}`);
const sideOf = (value: SideChoice) => (value.startsWith("field:") ? { field: value.slice(6) } : { document: value.slice(9) });

// "Karten einrichten" (§2.2): front and back from properties or the record's
// document, hint and extra, the reverse card and the deck's defaults.
export function StudySetup({
  open,
  onClose,
  database,
  rows,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  database: Database;
  rows: Row[];
  onSave: (settings: StudySettings) => Promise<void>;
}) {
  const t = useT();
  const fields = database.fields.filter((f) => STUDY_FIELD_TYPES.has(f.type));
  const initial = database.settings?.study || suggestStudySettings(database.fields);
  const [draft, setDraft] = useState<StudySettings>(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setDraft(database.settings?.study || suggestStudySettings(database.fields));
  }, [open, database.settings?.study, database.fields]);
  const same = sideValue(draft.front) === sideValue(draft.back);
  // The preview counts cards of properties; document sides are counted by
  // the server (the documents are not loaded here).
  const preview = useMemo(() => {
    if (!("field" in draft.front && "field" in draft.back)) return null;
    try {
      const settings = studySettingsSchema.parse(draft);
      // Image occlusion records count by their documents' masks.
      if (rows.some((r) => needsDocument(settings, r.cells))) return null;
      return rows.reduce((n, r) => n + deriveCards(settings, database.fields, r.cells, null).length, 0);
    } catch {
      return null;
    }
  }, [draft, rows, database.fields]);
  const number = (value: string, min: number, max: number, fallback: number) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return (
    <Modal open={open} onClose={onClose} title={t("Karten einrichten", "Set up cards")} wide sheet className="study-setup">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (same) return;
          setBusy(true);
          try {
            await onSave(studySettingsSchema.parse(draft));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted">
          {t(
            "Jeder Eintrag wird zur Karte. Mit einer Linie im Dokument (--- tippen) teilst du es in Frage oben und Antwort unten.",
            "Every record becomes a card. A line in the document (type ---) splits it into the question above and the answer below.",
          )}
        </p>
        <div className="form-row">
          <label>
            {t("Vorderseite", "Front")}
            <Select aria-label={t("Vorderseite", "Front")} value={sideValue(draft.front)} onChange={(e) => setDraft({ ...draft, front: sideOf(e.target.value) as StudySettings["front"] })}>
              {fields.map((f) => (
                <option key={f.id} value={`field:${f.id}`}>
                  {f.name}
                </option>
              ))}
              <option value="document:above">{t("Dokument oberhalb der Linie (---)", "Document above the line (---)")}</option>
            </Select>
          </label>
          <label>
            {t("Rückseite", "Back")}
            <Select aria-label={t("Rückseite", "Back")} value={sideValue(draft.back)} onChange={(e) => setDraft({ ...draft, back: sideOf(e.target.value) as StudySettings["back"] })}>
              {fields.map((f) => (
                <option key={f.id} value={`field:${f.id}`}>
                  {f.name}
                </option>
              ))}
              <option value="document:all">{t("Dokument des Eintrags", "The record's document")}</option>
              <option value="document:below">{t("Dokument unterhalb der Linie (---)", "Document below the line (---)")}</option>
            </Select>
          </label>
        </div>
        {same && <p className="study-error" role="alert">{t("Vorder- und Rückseite brauchen verschiedene Inhalte.", "Front and back need different content.")}</p>}
        <div className="form-row">
          {(["hint", "extra"] as const).map((key) => (
            <label key={key}>
              {key === "hint" ? t("Hinweis (vor dem Aufdecken)", "Hint (before revealing)") : t("Zusatz (nach dem Aufdecken)", "Extra (after revealing)")}
              <Select
                aria-label={key === "hint" ? t("Hinweis (vor dem Aufdecken)", "Hint (before revealing)") : t("Zusatz (nach dem Aufdecken)", "Extra (after revealing)")}
                value={draft[key]?.field || ""}
                onChange={(e) => {
                  const next = { ...draft };
                  if (e.target.value) next[key] = { field: e.target.value };
                  else delete next[key];
                  setDraft(next);
                }}
              >
                <option value="">{t("— keiner —", "— none —")}</option>
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </label>
          ))}
        </div>
        <CardTypeSetting draft={draft} setDraft={setDraft} database={database} />
        <div className="form-row">
          <label>
            {t("Antwortoptionen (Multiple Choice)", "Answer options (multiple choice)")}
            <Select
              aria-label={t("Antwortoptionen (Multiple Choice)", "Answer options (multiple choice)")}
              value={draft.choices?.field || ""}
              onChange={(e) => {
                const next = { ...draft };
                if (e.target.value) next.choices = { field: e.target.value };
                else delete next.choices;
                setDraft(next);
              }}
            >
              <option value="">{t("— keine: aus anderen Karten —", "— none: from other cards —")}</option>
              {fields
                .filter((f) => f.type === "text" || f.type === "multiselect")
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </Select>
          </label>
          <label>
            Tags
            <Select
              aria-label="Tags"
              value={draft.tags?.field || ""}
              onChange={(e) => {
                const next = { ...draft };
                if (e.target.value) next.tags = { field: e.target.value };
                else delete next.tags;
                setDraft(next);
              }}
            >
              <option value="">{t("— keine —", "— none —")}</option>
              {fields
                .filter((f) => f.type === "multiselect" || f.type === "select")
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </Select>
          </label>
        </div>
        <fieldset className="study-typed-settings">
          <legend>{t("Antwort eintippen: beim Vergleich ignorieren", "Typed answers: ignore when comparing")}</legend>
          {(
            [
              ["ignoreCase", t("Groß- und Kleinschreibung", "Upper and lower case")],
              ["ignoreAccents", t("Akzente (é = e)", "Accents (é = e)")],
              ["ignorePunctuation", t("Satzzeichen", "Punctuation")],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="checkbox-label">
              <input
                type="checkbox"
                checked={draft.typedCompare?.[key] ?? key !== "ignoreAccents"}
                onChange={(e) => setDraft({ ...draft, typedCompare: { ...studySettingsSchema.shape.typedCompare.parse(draft.typedCompare), [key]: e.target.checked } })}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <label className="checkbox-label">
          <input type="checkbox" checked={draft.reverse} onChange={(e) => setDraft({ ...draft, reverse: e.target.checked })} />
          {t("Auch umgekehrt lernen (Rückseite → Vorderseite)", "Also study in reverse (back → front)")}
        </label>
        <p className="muted">
          {t(
            "Lücken: {{c1::Antwort}} in einem Textfeld oder Text im Dokument markieren → „Als Lücke“ (⌘⌥G). Jede Nummer wird eine eigene Karte.",
            "Clozes: {{c1::answer}} in a text property, or select text in the document → “As cloze” (⌘⌥G). Every number becomes a card of its own.",
          )}
        </p>
        <div className="form-row study-limits">
          <label>
            {t("Neue Karten pro Tag", "New cards per day")}
            <input type="number" min={0} max={9999} value={draft.newPerDay} onChange={(e) => setDraft({ ...draft, newPerDay: number(e.target.value, 0, 9999, 20) })} />
          </label>
          <label>
            {t("Wiederholungen pro Tag", "Reviews per day")}
            <input type="number" min={0} max={99999} value={draft.reviewsPerDay} onChange={(e) => setDraft({ ...draft, reviewsPerDay: number(e.target.value, 0, 99999, 200) })} />
          </label>
          <label>
            {t("Behaltensrate (%)", "Retention (%)")}
            <input type="number" min={70} max={99} value={Math.round(draft.retention * 100)} onChange={(e) => setDraft({ ...draft, retention: number(e.target.value, 70, 99, 90) / 100 })} />
          </label>
        </div>
        <p className="muted">
          {preview !== null
            ? t(`Vorschau: ${rows.length} Einträge → ${preview} Karten`, `Preview: ${rows.length} records → ${preview} cards`)
            : t("Karten aus Dokumenten zählt Flowplan nach dem Speichern.", "Flowplan counts cards from documents after saving.")}
          {" · "}
          {t("Dein Lernstand und der aller anderen bleibt erhalten.", "Your learning state and everyone else's is kept.")}
        </p>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={busy || same || !fields.length}>
            {t("Speichern", "Save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// The card type: the same for all records, or from a select property –
// its options mapped to types (suggested by their names).
function CardTypeSetting({ draft, setDraft, database }: { draft: StudySettings; setDraft: (s: StudySettings) => void; database: Database }) {
  const t = useT();
  const names: Record<CardType, string> = {
    basic: t("Vorder-/Rückseite", "Front/back"),
    cloze: t("Lückentext", "Cloze"),
    typed: t("Antwort eintippen", "Type the answer"),
    choice: t("Multiple Choice", "Multiple choice"),
    occlusion: t("Bildverdeckung", "Image occlusion"),
  };
  const selects = database.fields.filter((f) => f.type === "select");
  const fromField = "field" in draft.type ? draft.type : null;
  const field = fromField ? selects.find((f) => f.id === fromField.field) : undefined;
  const shown = cardTypes;
  const occlusion = (draft.type && "fixed" in draft.type && draft.type.fixed === "occlusion") || (!!field && (field.options || []).some((o) => typeOfOption(o, fromField?.map) === "occlusion"));
  return (
    <div className="study-type-setting">
      <div className="form-row">
        <label>
          {t("Kartentyp", "Card type")}
          <Select
            aria-label={t("Kartentyp", "Card type")}
            value={fromField ? `field:${fromField.field}` : draft.type && "fixed" in draft.type ? draft.type.fixed : "basic"}
            onChange={(e) => {
              const value = e.target.value;
              setDraft({ ...draft, type: value.startsWith("field:") ? { field: value.slice(6) } : { fixed: value as CardType } });
            }}
          >
            {shown.map((c) => (
              <option key={c} value={c}>
                {t(`Für alle: ${names[c]}`, `For all: ${names[c]}`)}
              </option>
            ))}
            {selects.map((f) => (
              <option key={f.id} value={`field:${f.id}`}>
                {t(`Aus der Spalte „${f.name}“`, `From the property “${f.name}”`)}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {fromField && field && (field.options || []).length > 0 && (
        <div className="study-type-map" role="group" aria-label={t("Optionen zuordnen", "Map the options")}>
          {(field.options || []).map((option) => (
            <label key={option}>
              <span>{option}</span>
              <Select
                aria-label={t(`Kartentyp für „${option}“`, `Card type for “${option}”`)}
                value={typeOfOption(option, fromField.map)}
                onChange={(e) => setDraft({ ...draft, type: { field: fromField.field, map: { ...(fromField.map || {}), [option]: e.target.value as CardType } } })}
              >
                {shown.map((c) => (
                  <option key={c} value={c}>
                    {names[c]}
                  </option>
                ))}
              </Select>
            </label>
          ))}
        </div>
      )}
      {((draft.type && "fixed" in draft.type && draft.type.fixed === "choice") || fromField) && (
        <p className="muted">
          {t(
            "Multiple Choice ist leichter als freies Erinnern – gut für den Einstieg, für das Behalten besser Vorder-/Rückseite oder Eintippen.",
            "Multiple choice is easier than free recall – good to start with; for remembering, front/back or typing works better.",
          )}
        </p>
      )}
      {occlusion && (
        <p className="muted study-occlusion-hint">
          {t(
            "Bildverdeckung: Füge im Dokument des Eintrags ein Bild ein und wähle bei den Bildwerkzeugen unter „…“ „Bildverdeckung bearbeiten“. Jede Maske oder Gruppe wird eine eigene Karte; die Vorderseite steht über dem Bild, die Rückseite kommt beim Aufdecken. Gib dem Bild einen Alternativtext, damit Screenreader es beschreiben.",
            "Image occlusion: add a picture to the record's document and choose “Edit image occlusion” under “…” in the image tools. Every mask or group becomes a card of its own; the front shows above the picture, the back when revealing. Give the picture an alternative text so screen readers can describe it.",
          )}
        </p>
      )}
    </div>
  );
}

// "Meine Einstellungen": the person's own limits and retention for this
// deck; empty keeps the deck's.
function StudyPrefs({
  open,
  onClose,
  overview,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  overview: Extract<StudyOverview, { configured: true }>;
  onSave: (b: { newPerDay: number | null; reviewsPerDay: number | null; retention: number | null }) => Promise<void>;
}) {
  const t = useT();
  const own = overview.prefs,
    deck = overview.deckDefaults;
  const [draft, setDraft] = useState({ newPerDay: "", reviewsPerDay: "", retention: "" });
  useEffect(() => {
    if (open)
      setDraft({
        newPerDay: own.newPerDay === null ? "" : String(own.newPerDay),
        reviewsPerDay: own.reviewsPerDay === null ? "" : String(own.reviewsPerDay),
        retention: own.retention === null ? "" : String(Math.round(own.retention * 100)),
      });
  }, [open, own.newPerDay, own.reviewsPerDay, own.retention]);
  const parsed = (value: string, min: number, max: number) => {
    if (!value.trim()) return null;
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  };
  return (
    <Modal open={open} onClose={onClose} title={t("Meine Einstellungen", "My settings")} sheet>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const retention = parsed(draft.retention, 70, 99);
          void onSave({
            newPerDay: parsed(draft.newPerDay, 0, 9999),
            reviewsPerDay: parsed(draft.reviewsPerDay, 0, 99999),
            retention: retention === null ? null : retention / 100,
          });
        }}
      >
        <p className="muted">{t("Nur für dich. Leer lassen übernimmt die Vorgabe des Stapels.", "Only for you. Leave empty to use the deck's default.")}</p>
        <label>
          {t("Neue Karten pro Tag", "New cards per day")}
          <input type="number" min={0} max={9999} placeholder={String(deck.newPerDay)} value={draft.newPerDay} onChange={(e) => setDraft({ ...draft, newPerDay: e.target.value })} />
        </label>
        <label>
          {t("Wiederholungen pro Tag", "Reviews per day")}
          <input type="number" min={0} max={99999} placeholder={String(deck.reviewsPerDay)} value={draft.reviewsPerDay} onChange={(e) => setDraft({ ...draft, reviewsPerDay: e.target.value })} />
        </label>
        <label>
          {t("Behaltensrate (%)", "Retention (%)")}
          <input type="number" min={70} max={99} placeholder={String(Math.round(deck.retention * 100))} value={draft.retention} onChange={(e) => setDraft({ ...draft, retention: e.target.value })} />
        </label>
        <p className="muted">
          {t(
            "Eine höhere Behaltensrate heißt: öfter wiederholen, dafür seltener vergessen. 90 % passt für die meisten.",
            "A higher retention means reviewing more often and forgetting less. 90 % suits most people.",
          )}
        </p>
        <div className="modal-actions">
          <button type="button" className="button" onClick={() => setDraft({ newPerDay: "", reviewsPerDay: "", retention: "" })}>
            {t("Vorgaben des Stapels", "Deck defaults")}
          </button>
          <button className="button primary">{t("Speichern", "Save")}</button>
        </div>
      </form>
    </Modal>
  );
}
