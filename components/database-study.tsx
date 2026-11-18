"use client";
// The view "Lernen" of a database (docs/specs/flashcards.md §2.4): the deck's
// overview for the person – what is left today (new · learning · due), the
// start of a session (components/study/focus.tsx), "Heute mehr lernen",
// their own limits – and, with write access, the card mapping ("Karten
// einrichten"). The mapping belongs to the database (settings.study); the
// view's filters only pick a subset of its cards, like a sub-deck. Reading
// is enough to study: the learning state is the person's own.
import { useCallback, useEffect, useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Cards, CaretDown, GearSix, Play, SlidersHorizontal } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal, api } from "./ui";
import { Select } from "./select";
import { safeCollisionPadding } from "./safe-area";
import { StudyFocus, studyZoneNow, type StudyOverview } from "./study/focus";
import { cellText } from "@/lib/cell-text";
import { filterCount, effectiveFilterGroup } from "@/lib/database-filters";
import { STUDY_FIELD_TYPES, suggestStudySettings, studySettingsSchema, type StudySettings } from "@/lib/study-schema";
import type { Database, Page, Row, View } from "@/lib/types";

export async function loadStudy(pageId: string, viewId: string | undefined, limit: number) {
  const query = new URLSearchParams({ zone: studyZoneNow(), limit: String(limit) });
  if (viewId) query.set("view", viewId);
  return await api<StudyOverview>(`/api/pages/${pageId}/study?${query}`);
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
  const [overview, setOverview] = useState<StudyOverview | null>(null),
    [error, setError] = useState(""),
    [setup, setSetup] = useState(false),
    [prefs, setPrefs] = useState(false),
    [session, setSession] = useState(false);
  const reload = useCallback(async () => {
    try {
      setOverview(await loadStudy(page.id, view.id, 0));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page.id, view.id]);
  const mappingKey = JSON.stringify(mapping || null);
  const filterKey = JSON.stringify(effectiveFilterGroup(view));
  useEffect(() => {
    void reload();
  }, [reload, mappingKey, filterKey, database.version]);
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
            <button className="button compact" onClick={() => setPrefs(true)}>
              <SlidersHorizontal aria-hidden /> {t("Meine Einstellungen", "My settings")}
            </button>
            {editable && (
              <button className="button compact" onClick={() => setSetup(true)}>
                <GearSix aria-hidden /> {t("Karten einrichten", "Set up cards")}
              </button>
            )}
          </div>
        </section>
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
  const preview = "field" in draft.front && "field" in draft.back
    ? rows.filter((r) => cellText(r.cells[(draft.front as { field: string }).field]).trim() && cellText(r.cells[(draft.back as { field: string }).field]).trim()).length
    : null;
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
        <label className="checkbox-label">
          <input type="checkbox" checked={draft.reverse} onChange={(e) => setDraft({ ...draft, reverse: e.target.checked })} />
          {t("Auch umgekehrt lernen (Rückseite → Vorderseite)", "Also study in reverse (back → front)")}
        </label>
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
            ? t(`Vorschau: ${rows.length} Einträge → ${preview * (draft.reverse ? 2 : 1)} Karten`, `Preview: ${rows.length} records → ${preview * (draft.reverse ? 2 : 1)} cards`)
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
