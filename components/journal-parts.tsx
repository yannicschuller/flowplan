"use client";
// Journal building blocks: settings (template, trackers, calendar, PIN),
// the review of a week or month, the bar above a day page (trackers, place,
// appointments) and the lock screen.
import { useCallback, useEffect, useState } from "react";
import {
  CalendarBlank,
  CaretLeft,
  CaretRight,
  Check,
  Copy,
  Crosshair,
  LockKey,
  MapPin,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { api, Modal } from "./ui";

export const moodFaces = ["😞", "🙁", "😐", "🙂", "😄"];
const moodNames = ["Schlecht", "Mäßig", "Okay", "Gut", "Großartig"];
export type Tracker = {
  id: string;
  name: string;
  kind: "mood" | "scale" | "number" | "check";
  unit?: string;
};
export type JournalSettings = {
  template: string;
  trackers: Tracker[];
  locked: boolean;
  icsUrl?: string;
  options?: { place: boolean; events: boolean };
};
export type DayEntry = {
  values: Record<string, number | boolean>;
  place: string;
  lat: number | null;
  lon: number | null;
};
const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const longDate = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const monthName = new Intl.DateTimeFormat("de-DE", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const shiftDay = (day: string, days: number) => {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const message = (e: unknown) =>
  e instanceof Error ? e.message : "Das hat nicht geklappt.";

export const templatePresets: { name: string; description: string; html: string }[] = [
  {
    name: "Dankbarkeit & Fokus",
    description: "Drei Dinge, für die du dankbar bist, dein Fokus und ein Rückblick am Abend.",
    html: "<h3>Dankbar für</h3><ol><li><p></p></li><li><p></p></li><li><p></p></li></ol><h3>Fokus heute</h3><p></p><h3>Rückblick am Abend</h3><p></p>",
  },
  {
    name: "5-Minuten-Journal",
    description: "Morgens drei Fragen, abends zwei – kurz und regelmäßig.",
    html: "<h3>☀️ Morgens</h3><p><strong>Wofür bin ich dankbar?</strong></p><p></p><p><strong>Was würde heute großartig machen?</strong></p><p></p><p><strong>Mein Satz für heute</strong></p><p></p><h3>🌙 Abends</h3><p><strong>Drei schöne Dinge heute</strong></p><ol><li><p></p></li><li><p></p></li><li><p></p></li></ol><p><strong>Was nehme ich mir für morgen vor?</strong></p><p></p>",
  },
  {
    name: "Arbeitslog",
    description: "Was erledigt ist, was hakt und was morgen kommt.",
    html: "<h3>Erledigt</h3><ul><li><p></p></li></ul><h3>Blockiert</h3><p></p><h3>Morgen</h3><p></p><h3>Notizen</h3><p></p>",
  },
  {
    name: "Tagesrückblick",
    description: "Drei Fragen für den Abend.",
    html: "<h3>Was ist heute passiert?</h3><p></p><h3>Was habe ich gelernt?</h3><p></p><h3>Worauf freue ich mich?</h3><p></p>",
  },
];

// ---- Settings ----

type SettingsTab = "template" | "trackers" | "bar" | "lock";
const trackerSuggestions: Omit<Tracker, "id">[] = [
  { name: "Stimmung", kind: "mood" },
  { name: "Schlaf", kind: "number", unit: "h" },
  { name: "Sport", kind: "check" },
  { name: "Energie", kind: "scale" },
  { name: "Wasser", kind: "number", unit: "Gläser" },
];
const kindNames: Record<Tracker["kind"], string> = {
  mood: "Stimmung 😞–😄",
  scale: "Skala 1–5",
  number: "Zahl",
  check: "Ja / Nein",
};

export function JournalSettingsDialog({
  pageId,
  settings,
  todayId,
  onClose,
  onChanged,
  onError,
}: {
  pageId: string;
  settings: JournalSettings;
  todayId?: string;
  onClose: () => void;
  onChanged: () => Promise<unknown> | void;
  onError: (message: string) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("template");
  const [current, setCurrent] = useState(settings);
  const [trackers, setTrackers] = useState<Tracker[]>(settings.trackers);
  const [ics, setIcs] = useState(settings.icsUrl || "");
  const [pin, setPin] = useState("");
  const [pinAgain, setPinAgain] = useState("");
  const [oldPin, setOldPin] = useState("");
  const [busy, setBusy] = useState(false);
  const options = current.options || { place: true, events: true };
  const trackersChanged = JSON.stringify(trackers) !== JSON.stringify(current.trackers);
  const save = async (body: Record<string, unknown>, done?: string) => {
    setBusy(true);
    try {
      const next = await api<JournalSettings>("/api/command", { action: "journal.settings", pageId, ...body });
      setCurrent(next);
      await onChanged();
      if (done) onError(done);
      return true;
    } catch (e) {
      onError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  // Switches move at once; a failed save puts them back.
  const setOption = async (key: "place" | "events", value: boolean) => {
    const before = current;
    setCurrent({ ...current, options: { ...options, [key]: value } });
    if (!(await save({ options: { [key]: value } }))) setCurrent(before);
  };
  const lock = async (next: string | null) => {
    if (next !== null && next !== pinAgain) return onError("Die PINs stimmen nicht überein.");
    setBusy(true);
    try {
      await api("/api/command", {
        action: "journal.lock",
        pageId,
        pin: next,
        ...(current.locked ? { current: oldPin } : {}),
      });
      setCurrent({ ...current, locked: next !== null });
      setPin("");
      setPinAgain("");
      setOldPin("");
      await onChanged();
      onError(next === null ? "Sperre entfernt." : "Journal ist mit PIN geschützt.");
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const idFor = (name: string) =>
    (name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30) || "tracker") + "-" + Math.random().toString(36).slice(2, 6);
  const tabs: [SettingsTab, string][] = [
    ["template", "Vorlage"],
    ["trackers", "Tracker"],
    ["bar", "Tagesleiste"],
    ["lock", "Sperre"],
  ];
  return (
    <Modal open onClose={onClose} title="Journal einrichten" wide className="journal-settings">
      <div className="js-tabs" role="tablist" aria-label="Bereiche">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
            {key === "lock" && current.locked && <LockKey size={12} weight="fill" />}
          </button>
        ))}
      </div>

      {tab === "template" && (
        <section className="js-panel" role="tabpanel" aria-label="Vorlage">
          <p className="js-intro">Jeder neue Tag beginnt mit diesem Inhalt. Aufgaben aus der Vorlage kommen jeden Tag neu.</p>
          <div className="js-current">
            <div className="js-current-head">
              <strong>Aktuelle Vorlage</strong>
              <span className="js-current-actions">
                {todayId && (
                  <button type="button" className="text-button" disabled={busy} onClick={() => void save({ templateFromDay: todayId }, "Der heutige Tag ist jetzt die Vorlage.")}>
                    Heutigen Tag übernehmen
                  </button>
                )}
                {current.template && (
                  <button type="button" className="text-button" disabled={busy} onClick={() => void save({ template: "" }, "Vorlage entfernt.")}>
                    Entfernen
                  </button>
                )}
              </span>
            </div>
            {current.template ? (
              <div
                className="journal-template-preview"
                // Stored templates are sanitized by the server's document schema.
                dangerouslySetInnerHTML={{ __html: current.template }}
              />
            ) : (
              <p className="journal-template-empty">Keine Vorlage – neue Tage beginnen leer.</p>
            )}
          </div>
          <strong className="js-label">Fertige Vorlagen</strong>
          <div className="journal-presets">
            {templatePresets.map((preset) => (
              <button
                key={preset.name}
                type="button"
                className="journal-preset"
                disabled={busy}
                onClick={() => void save({ template: preset.html }, `Vorlage „${preset.name}“ gesetzt.`)}
              >
                <strong>{preset.name}</strong>
                <span>{preset.description}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {tab === "trackers" && (
        <section className="js-panel" role="tabpanel" aria-label="Tracker">
          <p className="js-intro">Werte, die du jeden Tag festhältst. Der Verlauf erscheint auf der Journalseite.</p>
          {trackers.length ? (
            <ul className="js-trackers">
              {trackers.map((tracker, i) => (
                <li key={tracker.id}>
                  <input
                    aria-label="Name des Trackers"
                    value={tracker.name}
                    maxLength={40}
                    onChange={(e) => setTrackers(trackers.map((t, j) => (j === i ? { ...t, name: e.target.value } : t)))}
                  />
                  <select
                    aria-label="Art"
                    value={tracker.kind}
                    onChange={(e) => setTrackers(trackers.map((t, j) => (j === i ? { ...t, kind: e.target.value as Tracker["kind"] } : t)))}
                  >
                    {(Object.keys(kindNames) as Tracker["kind"][]).map((kind) => (
                      <option key={kind} value={kind}>
                        {kindNames[kind]}
                      </option>
                    ))}
                  </select>
                  {tracker.kind === "number" ? (
                    <input
                      aria-label="Einheit"
                      placeholder="Einheit"
                      value={tracker.unit || ""}
                      maxLength={12}
                      className="js-unit"
                      onChange={(e) => setTrackers(trackers.map((t, j) => (j === i ? { ...t, unit: e.target.value } : t)))}
                    />
                  ) : (
                    <span className="js-unit" aria-hidden="true" />
                  )}
                  <button type="button" className="icon-button" aria-label={`${tracker.name} entfernen`} onClick={() => setTrackers(trackers.filter((_, j) => j !== i))}>
                    <Trash size={16} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="journal-template-empty">Noch keine Tracker.</p>
          )}
          <div className="journal-tracker-add">
            {trackerSuggestions
              .filter((suggestion) => !trackers.some((t) => t.name === suggestion.name))
              .map((suggestion) => (
                <button
                  key={suggestion.name}
                  type="button"
                  className="chip"
                  disabled={trackers.length >= 12}
                  onClick={() => setTrackers([...trackers, { ...suggestion, id: idFor(suggestion.name) }])}
                >
                  <Plus size={12} /> {suggestion.name}
                </button>
              ))}
            <button
              type="button"
              className="chip"
              disabled={trackers.length >= 12}
              onClick={() => setTrackers([...trackers, { id: idFor("tracker"), name: "Neuer Tracker", kind: "scale" }])}
            >
              <Plus size={12} /> Eigener
            </button>
          </div>
          <div className="js-footer">
            {trackersChanged && <span className="muted">Nicht gespeichert</span>}
            <button
              type="button"
              className="button primary"
              disabled={busy || !trackersChanged || trackers.some((t) => !t.name.trim())}
              onClick={() =>
                void save(
                  {
                    trackers: trackers.map((t) => ({
                      ...t,
                      name: t.name.trim(),
                      ...(t.kind === "number" && t.unit?.trim() ? { unit: t.unit.trim() } : { unit: undefined }),
                    })),
                  },
                  "Tracker gespeichert.",
                )
              }
            >
              Tracker speichern
            </button>
          </div>
        </section>
      )}

      {tab === "bar" && (
        <section className="js-panel" role="tabpanel" aria-label="Tagesleiste">
          <p className="js-intro">Die Leiste über jedem Tag. Tracker stehen immer darin, sobald es welche gibt.</p>
          <label className="js-switch">
            <input
              type="checkbox"
              role="switch"
              checked={options.place}
              onChange={(e) => setOption("place", e.target.checked)}
            />
            <span>
              <strong>Ort</strong>
              <small>Ortsangabe und Standort pro Tag</small>
            </span>
          </label>
          <label className="js-switch">
            <input
              type="checkbox"
              role="switch"
              checked={options.events}
              onChange={(e) => setOption("events", e.target.checked)}
            />
            <span>
              <strong>Termine</strong>
              <small>Einträge aus Datenbanken mit Datum und aus einem Kalender</small>
            </span>
          </label>
          {options.events && (
            <div className="js-field">
              <strong className="js-label">Kalender einbinden (optional)</strong>
              <small className="muted">
                iCal-Link, z. B. die „Geheime Adresse im iCal-Format“ aus Google Kalender.
              </small>
              <div className="journal-inline-form">
                <input type="url" placeholder="https://… .ics" value={ics} onChange={(e) => setIcs(e.target.value)} aria-label="iCal-Adresse" />
                <button
                  type="button"
                  className="button"
                  disabled={busy || ics === (current.icsUrl || "")}
                  onClick={() => void save({ icsUrl: ics.trim() }, ics.trim() ? "Kalender verbunden." : "Kalender entfernt.")}
                >
                  Speichern
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {tab === "lock" && (
        <section className="js-panel" role="tabpanel" aria-label="Sperre">
          <p className="js-status">
            <LockKey size={18} weight={current.locked ? "fill" : "regular"} />
            {current.locked ? "Das Journal ist mit einer PIN geschützt." : "Das Journal ist nicht gesperrt."}
          </p>
          <p className="js-intro">
            Mit PIN zeigt das Journal seine Tage erst nach Eingabe – für alle, die es öffnen dürfen. Nach 15 Minuten sperrt es
            sich wieder. Das schützt vor Blicken, ist aber keine Verschlüsselung.
          </p>
          <div className="js-pin">
            {current.locked && (
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                placeholder="Bisherige PIN"
                aria-label="Bisherige PIN"
                value={oldPin}
                onChange={(e) => setOldPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
              />
            )}
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              placeholder={current.locked ? "Neue PIN" : "PIN (4–8 Ziffern)"}
              aria-label="Neue PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            />
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              placeholder="PIN wiederholen"
              aria-label="PIN wiederholen"
              value={pinAgain}
              onChange={(e) => setPinAgain(e.target.value.replace(/\D/g, "").slice(0, 8))}
            />
          </div>
          <div className="js-footer">
            {current.locked && (
              <button type="button" className="button" disabled={busy || oldPin.length < 4} onClick={() => void lock(null)}>
                Sperre entfernen
              </button>
            )}
            <button
              type="button"
              className="button primary"
              disabled={busy || pin.length < 4 || (current.locked && oldPin.length < 4)}
              onClick={() => void lock(pin)}
            >
              {current.locked ? "PIN ändern" : "Sperren"}
            </button>
          </div>
        </section>
      )}
    </Modal>
  );
}

// ---- Review ----

type Review = {
  from: string;
  to: string;
  days: { id: string; date: string; title: string }[];
  words: number;
  done: { text: string; date: string; dayId: string }[];
  open: number;
  images: { src: string; date: string; dayId: string }[];
  places: string[];
  trackers: (Tracker & {
    count: number;
    average: number | null;
    values: { date: string; value: number | boolean }[];
  })[];
};
function period(mode: "week" | "month", anchor: string) {
  if (mode === "week") {
    const from = shiftDay(anchor, -((utc(anchor).getUTCDay() + 6) % 7));
    return { from, to: shiftDay(from, 6) };
  }
  const from = `${anchor.slice(0, 7)}-01`;
  const d = utc(from);
  const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { from, to };
}
export function reviewText(review: Review, label: string) {
  const lines = [`# ${label}`, ""];
  lines.push(`${review.days.length} Tage · ${review.words} Wörter · ${review.done.length} erledigte Aufgaben`, "");
  for (const tracker of review.trackers.filter((t) => t.count))
    lines.push(
      `- ${tracker.name}: ${
        tracker.kind === "check"
          ? `${tracker.values.filter((v) => v.value === true).length} von ${tracker.count} Tagen`
          : `Ø ${(tracker.average ?? 0).toLocaleString("de-DE", { maximumFractionDigits: 1 })}${tracker.unit ? ` ${tracker.unit}` : ""}`
      }`,
    );
  if (review.places.length) lines.push(`- Orte: ${review.places.join(", ")}`);
  if (review.done.length) {
    lines.push("", "## Erledigt");
    for (const task of review.done) lines.push(`- [x] ${task.text}`);
  }
  return lines.join("\n");
}
export function JournalReview({
  pageId,
  today,
  onClose,
  onOpen,
  onError,
}: {
  pageId: string;
  today: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<"week" | "month">("week");
  const [anchor, setAnchor] = useState(today);
  const [review, setReview] = useState<Review | null>(null);
  const range = period(mode, anchor);
  useEffect(() => {
    let live = true;
    setReview(null);
    api<Review>(`/api/journals/${pageId}/review?from=${range.from}&to=${range.to}`)
      .then((r) => live && setReview(r))
      .catch((e) => onError(message(e)));
    return () => {
      live = false;
    };
  }, [pageId, range.from, range.to, onError]);
  const label =
    mode === "week"
      ? `Woche vom ${longDate.format(utc(range.from))} bis ${longDate.format(utc(range.to))}`
      : monthName.format(utc(range.from));
  const move = (n: number) => {
    if (mode === "week") setAnchor(shiftDay(range.from, 7 * n));
    else {
      const d = utc(range.from);
      setAnchor(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10));
    }
  };
  return (
    <Modal open onClose={onClose} title="Rückblick" wide className="journal-review">
      <div className="journal-review-head">
        <div className="journal-layout" role="group" aria-label="Zeitraum">
          <button type="button" className={mode === "week" ? "active" : ""} aria-pressed={mode === "week"} onClick={() => setMode("week")}>
            Woche
          </button>
          <button type="button" className={mode === "month" ? "active" : ""} aria-pressed={mode === "month"} onClick={() => setMode("month")}>
            Monat
          </button>
        </div>
        <button type="button" className="icon-button" aria-label="Früher" onClick={() => move(-1)}>
          <CaretLeft size={16} />
        </button>
        <strong>{label}</strong>
        <button
          type="button"
          className="icon-button"
          aria-label="Später"
          disabled={range.to >= today}
          onClick={() => move(1)}
        >
          <CaretRight size={16} />
        </button>
      </div>
      {!review ? (
        <p className="muted">Wird zusammengestellt …</p>
      ) : !review.days.length ? (
        <p className="journal-empty">
          <CalendarBlank size={18} /> In diesem Zeitraum gibt es keine Einträge.
        </p>
      ) : (
        <div className="journal-review-body">
          <div className="journal-review-numbers">
            <span><strong>{review.days.length}</strong> {review.days.length === 1 ? "Tag" : "Tage"}</span>
            <span><strong>{review.words.toLocaleString("de-DE")}</strong> Wörter</span>
            <span><strong>{review.done.length}</strong> erledigt</span>
            <span><strong>{review.open}</strong> noch offen</span>
          </div>
          {review.trackers.some((t) => t.count) && (
            <div className="journal-review-trackers">
              {review.trackers
                .filter((t) => t.count)
                .map((t) => (
                  <div key={t.id}>
                    <small>{t.name}</small>
                    <strong>
                      {t.kind === "check"
                        ? `${t.values.filter((v) => v.value === true).length} / ${t.count}`
                        : t.kind === "mood"
                          ? `${moodFaces[Math.round(t.average ?? 3) - 1]} ${(t.average ?? 0).toLocaleString("de-DE", { maximumFractionDigits: 1 })}`
                          : `${(t.average ?? 0).toLocaleString("de-DE", { maximumFractionDigits: 1 })}${t.unit ? ` ${t.unit}` : ""}`}
                    </strong>
                    <span>{t.kind === "check" ? "Tage" : "Durchschnitt"}</span>
                  </div>
                ))}
            </div>
          )}
          {review.places.length > 0 && (
            <p className="journal-review-places">
              <MapPin size={14} /> {review.places.join(" · ")}
            </p>
          )}
          {review.images.length > 0 && (
            <div className="journal-review-photos">
              {review.images.map((image) => (
                <button key={image.src} type="button" onClick={() => onOpen(image.dayId)} aria-label={`Tag ${image.date} öffnen`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.src} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
          {review.done.length > 0 && (
            <section>
              <h3>Erledigt</h3>
              <ul className="journal-review-done">
                {review.done.map((task, i) => (
                  <li key={`${task.dayId}-${i}`}>
                    <Check size={14} />
                    <span>{task.text}</span>
                    <button type="button" className="text-button" onClick={() => onOpen(task.dayId)}>
                      {longDate.format(utc(task.date))}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3>Tage</h3>
            <div className="journal-review-days">
              {review.days.map((day) => (
                <button key={day.id} type="button" className="chip" onClick={() => onOpen(day.id)}>
                  {longDate.format(utc(day.date))}
                </button>
              ))}
            </div>
          </section>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(reviewText(review, label));
                  onError("Rückblick als Markdown kopiert.");
                } catch {
                  onError("Kopieren nicht möglich.");
                }
              }}
            >
              <Copy size={16} /> Als Markdown kopieren
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---- Day bar ----

type DayEvent = {
  title: string;
  start: string;
  end: string;
  timed: boolean;
  source: string;
  pageId?: string;
  rowId?: string;
};
const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
export function JournalDayBar({
  pageId,
  trackers,
  entry,
  editable,
  onError,
  options = { place: true, events: true },
}: {
  // Which parts the journal shows (set up in the journal's settings).
  options?: { place: boolean; events: boolean };
  pageId: string;
  trackers: Tracker[];
  entry: DayEntry;
  editable: boolean;
  onError: (message: string) => void;
}) {
  const [values, setValues] = useState(entry.values);
  const [place, setPlace] = useState(entry.place);
  const [coords, setCoords] = useState(
    entry.lat !== null && entry.lon !== null ? { lat: entry.lat, lon: entry.lon } : null,
  );
  const [events, setEvents] = useState<DayEvent[] | null>(null);
  const [calendarError, setCalendarError] = useState("");
  useEffect(() => {
    setValues(entry.values);
    setPlace(entry.place);
    setCoords(entry.lat !== null && entry.lon !== null ? { lat: entry.lat, lon: entry.lon } : null);
  }, [entry]);
  useEffect(() => {
    if (!options.events) return setEvents([]);
    let live = true;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    api<{ events: DayEvent[]; calendarError: string }>(
      `/api/journals/${pageId}/events?zone=${encodeURIComponent(zone)}`,
    )
      .then((r) => {
        if (!live) return;
        setEvents(r.events);
        setCalendarError(r.calendarError);
      })
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [pageId, options.events]);
  const save = useCallback(
    async (patch: Partial<Omit<DayEntry, "values">> & { values?: Record<string, number | boolean | null> }) => {
      try {
        await api("/api/command", { action: "journal.entry", pageId, entry: patch });
      } catch (e) {
        onError(message(e));
      }
    },
    [pageId, onError],
  );
  const setValue = (id: string, value: number | boolean | null) => {
    const next = { ...values };
    if (value === null) delete next[id];
    else next[id] = value;
    setValues(next);
    void save({ values: { [id]: value } });
  };
  const locate = () => {
    if (!navigator.geolocation) return onError("Standort wird nicht unterstützt.");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next = {
          lat: Math.round(position.coords.latitude * 1e5) / 1e5,
          lon: Math.round(position.coords.longitude * 1e5) / 1e5,
        };
        setCoords(next);
        void save(next);
      },
      () => onError("Standort nicht verfügbar."),
      { timeout: 10_000, maximumAge: 300_000 },
    );
  };
  const eventTime = (event: DayEvent) =>
    event.timed ? time.format(new Date(event.start)) : "Ganztägig";
  // Nothing switched on and no appointments: no bar at all.
  if (!trackers.length && !options.place && !(events?.length || calendarError)) return null;
  return (
    <div className="journal-daybar">
      {trackers.length > 0 && (
        <div className="journal-daybar-trackers">
          {trackers.map((tracker) => {
            const value = values[tracker.id];
            if (tracker.kind === "mood" || tracker.kind === "scale")
              return (
                <div className="journal-daybar-tracker" key={tracker.id} role="group" aria-label={tracker.name}>
                  <span>{tracker.name}</span>
                  <div className={`journal-scale ${tracker.kind}`}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        disabled={!editable}
                        aria-pressed={value === n}
                        aria-label={tracker.kind === "mood" ? moodNames[n - 1] : `${n}`}
                        title={tracker.kind === "mood" ? moodNames[n - 1] : `${n}`}
                        onClick={() => setValue(tracker.id, value === n ? null : n)}
                      >
                        {tracker.kind === "mood" ? moodFaces[n - 1] : n}
                      </button>
                    ))}
                  </div>
                </div>
              );
            if (tracker.kind === "check")
              return (
                <label className="journal-daybar-tracker check" key={tracker.id}>
                  <input
                    type="checkbox"
                    disabled={!editable}
                    checked={value === true}
                    onChange={(e) => setValue(tracker.id, e.target.checked ? true : null)}
                  />
                  <span>{tracker.name}</span>
                </label>
              );
            return (
              <label className="journal-daybar-tracker number" key={tracker.id}>
                <span>{tracker.name}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  disabled={!editable}
                  defaultValue={typeof value === "number" ? value : ""}
                  key={`${tracker.id}-${String(value)}`}
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    const next = raw === "" ? null : Number(raw.replace(",", "."));
                    if (next !== null && !Number.isFinite(next)) return;
                    if (next === (typeof value === "number" ? value : null)) return;
                    setValue(tracker.id, next);
                  }}
                />
                {tracker.unit && <small>{tracker.unit}</small>}
              </label>
            );
          })}
        </div>
      )}
      {options.place && (
      <div className="journal-daybar-place">
        <MapPin size={15} />
        <input
          placeholder="Ort"
          aria-label="Ort"
          value={place}
          maxLength={120}
          disabled={!editable}
          onChange={(e) => setPlace(e.target.value)}
          onBlur={() => place !== entry.place && void save({ place })}
        />
        {coords ? (
          <>
            <a
              href={`https://www.openstreetmap.org/?mlat=${coords.lat}&mlon=${coords.lon}#map=15/${coords.lat}/${coords.lon}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              Karte
            </a>
            {editable && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setCoords(null);
                  void save({ lat: null, lon: null });
                }}
              >
                Standort entfernen
              </button>
            )}
          </>
        ) : (
          editable && (
            <button type="button" className="text-button" onClick={locate}>
              <Crosshair size={14} /> Standort
            </button>
          )
        )}
      </div>
      )}
      {(events?.length || calendarError) ? (
        <div className="journal-daybar-events" aria-label="Termine">
          <CalendarBlank size={15} />
          <ul>
            {events?.map((event, i) => (
              <li key={`${event.rowId || event.title}-${i}`}>
                <time>{eventTime(event)}</time>
                {event.pageId && event.rowId ? (
                  <a href={`/#page=${event.pageId}&row=${event.rowId}`}>{event.title}</a>
                ) : (
                  <span>{event.title}</span>
                )}
                <small>{event.source}</small>
              </li>
            ))}
            {calendarError && <li className="muted">{calendarError}</li>}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ---- Lock screen ----

export function JournalLockScreen({
  journalId,
  onUnlocked,
}: {
  journalId: string;
  onUnlocked: () => Promise<unknown> | void;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="journal-lock"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api("/api/command", { action: "journal.unlock", pageId: journalId, pin });
          await onUnlocked();
        } catch (err) {
          setError(message(err));
          setPin("");
        } finally {
          setBusy(false);
        }
      }}
    >
      <LockKey size={36} weight="duotone" />
      <h2>Dieses Journal ist gesperrt</h2>
      <p>Gib die PIN ein, um die Einträge zu sehen.</p>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        autoFocus
        aria-label="PIN"
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
      />
      {error && <p className="journal-lock-error" role="alert">{error}</p>}
      <button type="submit" className="button primary" disabled={busy || pin.length < 4}>
        Entsperren
      </button>
    </form>
  );
}
