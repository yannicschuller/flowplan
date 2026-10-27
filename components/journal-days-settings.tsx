"use client";
// Journal settings → "Tage" (#49): when today's page is created
// (automatically or on the first write) and "Leere Tage entfernen" with a
// preview of what would go to the trash (lib/journal-days.ts).
import { useState } from "react";
import { Broom, Trash } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { api } from "./ui";

// The person's own date (a new day starts at local midnight).
function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
type EmptyDay = { id: string; date: string; title: string };
const longDate = new Intl.DateTimeFormat(LOCALE_TAG, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function JournalDaysPanel({
  pageId,
  mode,
  busy,
  onMode,
  onChanged,
  onError,
}: {
  pageId: string;
  mode: "auto" | "write";
  busy: boolean;
  onMode: (mode: "auto" | "write") => void;
  onChanged: () => Promise<unknown> | void;
  // Errors and confirmations (the dialog shows both as a toast).
  onError: (message: string) => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<EmptyDay[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const find = async () => {
    setWorking(true);
    try {
      const { days } = await api<{ days: EmptyDay[] }>(`/api/journals/${pageId}/empty?today=${localDay()}`);
      setPreview(days);
      setChosen(new Set(days.map((d) => d.id)));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const remove = async () => {
    setWorking(true);
    try {
      const { removed } = await api<{ removed: number }>("/api/command", {
        action: "journal.removeEmpty",
        pageId,
        dayIds: [...chosen],
        today: localDay(),
      });
      onError(
        removed === 1
          ? t("1 leerer Tag liegt jetzt im Papierkorb.", "1 empty day is now in the trash.")
          : t(`${removed} leere Tage liegen jetzt im Papierkorb.`, `${removed} empty days are now in the trash.`),
      );
      setPreview(null);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const choices: ["auto" | "write", string, string][] = [
    [
      "auto",
      t("Automatisch", "Automatically"),
      t(
        "Die Seite für heute entsteht, sobald der Tag beginnt. Ein Tag, an dem nichts geschrieben wurde, verschwindet wieder, wenn der nächste angelegt wird.",
        "Today's page is created as soon as the day starts. A day without anything written disappears again when the next one is created.",
      ),
    ],
    [
      "write",
      t("Beim ersten Schreiben", "On the first write"),
      t(
        "Heute zeigt zuerst einen Entwurf mit Vorlage und übernommenen Aufgaben. Gespeichert wird er erst mit dem ersten Tastendruck, einer abgehakten Aufgabe, einem Wert oder einer Datei.",
        "Today first shows a draft with the template and carried-over tasks. It is saved only with the first keystroke, ticked task, value or file.",
      ),
    ],
  ];
  return (
    <>
      <fieldset className="js-choices">
        <legend className="js-label">{t("Seite des Tages anlegen", "Create the day's page")}</legend>
        {choices.map(([value, label, hint]) => (
          <label key={value} className={`js-choice${mode === value ? " active" : ""}`}>
            <input type="radio" name="journal-create" value={value} checked={mode === value} disabled={busy} onChange={() => onMode(value)} />
            <span>
              <strong>{label}</strong>
              <small>{hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="js-field js-empty">
        <strong className="js-label">{t("Leere Tage entfernen", "Remove empty days")}</strong>
        <small className="muted">
          {t(
            "Tage ohne eigenen Inhalt: nur die Vorlage, keine Werte, Dateien, Kommentare, Unterseiten oder Links darauf, Titel und Symbol unverändert. Sie kommen in den Papierkorb und lassen sich von dort wiederherstellen. Heute bleibt immer.",
            "Days without content of their own: only the template, no values, files, comments, sub-pages or links to them, title and icon unchanged. They go to the trash and can be restored from there. Today always stays.",
          )}
        </small>
        {preview === null ? (
          <div>
            <button type="button" className="button" disabled={working} onClick={() => void find()}>
              <Broom size={16} /> {t("Leere Tage suchen", "Find empty days")}
            </button>
          </div>
        ) : preview.length === 0 ? (
          <p className="journal-template-empty" role="status">
            {t("Keine leeren Tage gefunden.", "No empty days found.")}
          </p>
        ) : (
          <>
            <p className="js-empty-count" role="status">
              {preview.length === 1
                ? t("1 Tag ist leer:", "1 day is empty:")
                : t(`${preview.length} Tage sind leer:`, `${preview.length} days are empty:`)}
            </p>
            <ul className="js-empty-list" aria-label={t("Leere Tage", "Empty days")}>
              {preview.map((day) => (
                <li key={day.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.has(day.id)}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(day.id);
                        else next.delete(day.id);
                        setChosen(next);
                      }}
                    />
                    <span>{day.title || longDate.format(new Date(`${day.date}T00:00:00Z`))}</span>
                    <small className="muted">{day.date}</small>
                  </label>
                </li>
              ))}
            </ul>
            <div className="js-footer">
              <button type="button" className="button" disabled={working} onClick={() => setPreview(null)}>
                {t("Abbrechen", "Cancel")}
              </button>
              <button type="button" className="button danger-solid" disabled={working || !chosen.size} onClick={() => void remove()}>
                <Trash size={16} />
                {chosen.size === 1
                  ? t("1 Tag in den Papierkorb", "Move 1 day to the trash")
                  : t(`${chosen.size} Tage in den Papierkorb`, `Move ${chosen.size} days to the trash`)}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
