"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { useEffect, useRef, useState } from "react";
import {
  browserZone,
  dateInZone,
  isTimed,
  localValue,
  localToInstant,
  instantOf,
  validDateValue,
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
  const [draft, setDraft] = useState(() => localValue(value, zone)),
    [timed, setTimed] = useState(isTimed(value)),
    [choice, setChoice] = useState<TimeChoice>("reject"),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null),
    changed = useRef(false),
    last = useRef(value);
  useEffect(() => {
    // Keep unsaved/invalid drafts during the regular background refresh.
    if (value !== last.current) {
      last.current = value;
      setDraft(localValue(value, zone));
      setTimed(isTimed(value));
      setChoice("reject");
      setError("");
      changed.current = false;
    }
  }, [value, zone]);
  useEffect(() => {
    input.current?.setCustomValidity(error);
  }, [error]);
  function resolve(text: string, mode: boolean, occurrence: TimeChoice) {
    if (!text) return "";
    if (!mode) {
      if (!validDateValue(text))
        throw new Error(t("Bitte ein gültiges Datum eingeben.", "Please enter a valid date."));
      return text;
    }
    // An unchanged local value retains the exact offset of an existing fold occurrence.
    if (
      isTimed(value) &&
      text === localValue(value, zone) &&
      occurrence === "reject"
    )
      return instantOf(value, zone).toString();
    return localToInstant(text, zone, occurrence);
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
  async function save() {
    if (commit !== "blur" || !changed.current) return;
    try {
      const next = resolve(draft, timed, choice);
      if (next !== value) {
        const result = await onChange(next);
        if (result === null || result === false)
          throw new Error(
            t("Datum konnte nicht gespeichert werden. Bitte erneut versuchen.", "The date could not be saved. Please try again."),
          );
      }
      setError("");
      changed.current = false;
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div
      className="date-input"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          void save();
      }}
    >
      <input
        ref={input}
        aria-label={name}
        type={timed ? "datetime-local" : "date"}
        step={timed ? "0.001" : undefined}
        min={timed ? "0001-01-01T00:00" : "0001-01-01"}
        max={timed ? "9999-12-31T23:59:59.999" : "9999-12-31"}
        disabled={disabled}
        value={draft}
        aria-invalid={!!error}
        onChange={(e) => update(e.target.value)}
      />
      {draft && !disabled && (
        <button
          type="button"
          className="date-clear"
          aria-label={t(`${name} entfernen`, `Remove ${name}`)}
          title={t("Datum entfernen", "Remove date")}
          onClick={async () => {
            setDraft("");
            setError("");
            changed.current = false;
            if (value) await onChange("");
          }}
        >
          {t("Datum entfernen", "Remove date")}
        </button>
      )}
      <label className="checkbox-label">
        <input
          type="checkbox"
          disabled={disabled}
          checked={timed}
          onChange={(e) =>
            update(
              e.target.checked
                ? `${draft.slice(0, 10) || dateInZone(zone)}T09:00`
                : draft.slice(0, 10),
              e.target.checked,
              "reject",
            )
          }
        />
        {name}: Uhrzeit
      </label>
      {timed && <small>{t("Zeitzone:", "Time zone:")}{" "}{zone}</small>}
      {timed && (
        <Select
          aria-label={`${name}: Zeitumstellung`}
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
