"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { useEffect, useRef, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/server-message";
import {
  browserZone,
  dateInZone,
  isTimed,
  fieldValue,
  dateToSave,
  draftDateValue,
  repeatedLocalTime,
  InvalidDateDraft,
  type TimeChoice,
} from "@/lib/date-values";

export default function DateInput({
  name,
  value,
  disabled,
  onChange,
  commit = "blur",
  timeZone,
}: {
  name: string;
  value: unknown;
  disabled?: boolean;
  timeZone?: string;
  onChange: (value: string) => void | Promise<unknown>;
  commit?: "blur" | "change";
}) {
  const t = useT();
  const zone = timeZone || browserZone();
  const [draft, setDraft] = useState(() => fieldValue(value, zone)),
    [timed, setTimed] = useState(isTimed(value)),
    [choice, setChoice] = useState<TimeChoice>("reject"),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null),
    timeInput = useRef<HTMLInputElement>(null),
    changed = useRef(false),
    last = useRef(value);
  useEffect(() => {
    // Keep unsaved/invalid drafts during the regular background refresh.
    if (value !== last.current) {
      last.current = value;
      setDraft(fieldValue(value, zone));
      setTimed(isTimed(value));
      setChoice("reject");
      setError("");
      changed.current = false;
    }
  }, [value, zone]);
  useEffect(() => {
    input.current?.setCustomValidity(error);
  }, [error]);
  // The draft in two parts: the day ("2026-10-25") and, with a time, the
  // time of day ("09:15"). The stored value stays one ISO text.
  const day = draft.slice(0, 10),
    time = timed ? draft.slice(11) : "";
  function resolve(text: string, mode: boolean, occurrence: TimeChoice) {
    try {
      return draftDateValue(text, mode, occurrence, value, zone);
    } catch (e) {
      if (e instanceof InvalidDateDraft)
        throw new Error(t("Bitte ein gültiges Datum eingeben.", "Please enter a valid date."));
      // lib/date-values.ts words its errors in German, like the server.
      if (e instanceof Error) throw new Error(serverMessage(e.message));
      throw e;
    }
  }
  function update(text: string, mode = timed, occurrence = choice) {
    setDraft(text);
    setTimed(mode);
    setChoice(occurrence);
    changed.current = true;
    try {
      const next = resolve(text, mode, occurrence);
      setError("");
      if (commit === "change") void onChange(next);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const failed = () =>
    new Error(t("Datum konnte nicht gespeichert werden. Bitte erneut versuchen.", "The date could not be saved. Please try again."));
  async function save() {
    if (commit !== "blur" || !changed.current) return;
    try {
      const next = dateToSave(resolve(draft, timed, choice), value);
      if (next !== null) {
        const result = await onChange(next);
        if (result === null || result === false) throw failed();
      }
      setError("");
      changed.current = false;
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // "Datum entfernen": saves "" at once. A pending draft is dropped, so the
  // blur that follows cannot bring the old date back. The time goes with
  // the date: the field is all-day again (#314).
  async function clear(keyboard: boolean) {
    const before = draft,
      wasTimed = timed;
    setDraft("");
    setTimed(false);
    setChoice("reject");
    setError("");
    changed.current = false;
    // Keyboard users keep their place; a tap must not focus the date input,
    // that would open the picker again (iOS, Android).
    if (keyboard) input.current?.focus({ preventScroll: true });
    if (dateToSave("", value) === null) return;
    const result = await onChange("");
    if (result === null || result === false) {
      setDraft(before);
      setTimed(wasTimed);
      setError(failed().message);
    }
  }
  // "+ Uhrzeit" / "Uhrzeit entfernen": one button in the same place, so
  // removing keeps the focus on it; adding moves it to the new time field.
  // A new time starts at 09:00 (on today without a date).
  function toggleTime() {
    if (timed) update(day, false, "reject");
    else {
      update(`${day || dateInZone(zone)}T09:00`, true, "reject");
      requestAnimationFrame(() => timeInput.current?.focus({ preventScroll: true }));
    }
  }
  return (
    <div
      className="date-input"
      // iOS shows an empty date field as a blank box; the stylesheet puts
      // this hint in it on touch screens (app/globals.css, .date-input).
      data-placeholder={draft || disabled ? undefined : t("Datum wählen", "Pick a date")}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          void save();
      }}
    >
      <input
        ref={input}
        aria-label={name}
        type="date"
        min="0001-01-01"
        max="9999-12-31"
        disabled={disabled}
        value={day}
        aria-invalid={!!error}
        // Emptied by hand, the field is all-day again (like "Datum entfernen").
        onChange={(e) => {
          const next = e.target.value;
          if (!timed) update(next);
          else if (next) update(`${next}T${time}`);
          else update("", false, "reject");
        }}
      />
      {timed && (
        <input
          ref={timeInput}
          className="date-time"
          aria-label={t(`${name}: Uhrzeit`, `${name}: Time`)}
          type="time"
          // Seconds and milliseconds only for a time that has them ("08:30",
          // not "08:30:00.000"); they are kept as they are.
          step={time.length > 5 ? "0.001" : undefined}
          disabled={disabled}
          value={time}
          aria-invalid={!!error}
          onChange={(e) => update(`${day || dateInZone(zone)}T${e.target.value}`)}
        />
      )}
      {!disabled && (
        <span className="date-actions">
          {draft && (
            <button
              type="button"
              className="date-clear"
              // The accessible name starts with the visible text (WCAG 2.5.3).
              aria-label={t(`Datum entfernen: ${name}`, `Remove date: ${name}`)}
              title={t("Datum entfernen", "Remove date")}
              // A tap must not reach the date input: inside a <label> WebKit
              // hands the click on to it, which opens the picker and keeps the date.
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void clear(e.detail === 0);
              }}
            >
              {t("Datum entfernen", "Remove date")}
            </button>
          )}
          <button
            type="button"
            className={`date-clear date-time-toggle${timed ? "" : " date-time-add"}`}
            aria-label={
              timed
                ? t(`Uhrzeit entfernen: ${name}`, `Remove time: ${name}`)
                : t(`Uhrzeit hinzufügen: ${name}`, `Add time: ${name}`)
            }
            title={
              timed
                ? t("Nur das Datum behalten", "Keep only the date")
                : t("Eine Uhrzeit zum Datum hinzufügen", "Add a time to the date")
            }
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleTime();
            }}
          >
            {timed ? (
              t("Uhrzeit entfernen", "Remove time")
            ) : (
              <>
                <Plus size={11} weight="bold" aria-hidden="true" />
                {t("Uhrzeit", "Time")}
              </>
            )}
          </button>
        </span>
      )}
      {timed && <small>{t("Zeitzone:", "Time zone:")}{" "}{zone}</small>}
      {/* Only for a time the clock change repeats (or one already chosen). */}
      {timed && (choice !== "reject" || repeatedLocalTime(draft, zone)) && (
        <Select
          aria-label={t(`${name}: Zeitumstellung`, `${name}: clock change`)}
          disabled={disabled}
          value={choice}
          onChange={(e) => update(draft, timed, e.target.value as TimeChoice)}
        >
          <option value="reject">{t("Doppelte Uhrzeit: nachfragen", "Repeated time: ask")}</option>
          <option value="earlier">{t("Erstes Vorkommen", "First occurrence")}</option>
          <option value="later">{t("Zweites Vorkommen", "Second occurrence")}</option>
        </Select>
      )}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
