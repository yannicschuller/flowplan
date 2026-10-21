"use client";
// "Wiederkehrende Aufgabe" in the record view: once the record is done, the
// next one is created with its date moved on (lib/repeat-records.ts).
import { useT } from "./i18n";
import { Select } from "./select";
import { nextOccurrence, parseRepeat, type RepeatRule } from "@/lib/recurrence";
import { validDateValue } from "@/lib/date-values";
import type { Field, Row } from "@/lib/types";

// i18n-table: 2 4 – [key, German, English, German unit, English unit]
const FREQS: [RepeatRule["freq"], string, string, string, string][] = [
  ["daily", "Täglich", "Daily", "Tage", "days"],
  ["weekly", "Wöchentlich", "Weekly", "Wochen", "weeks"],
  ["monthly", "Monatlich", "Monthly", "Monate", "months"],
  ["yearly", "Jährlich", "Yearly", "Jahre", "years"],
];
// i18n-table: 1 – [German, English] pairs
const DAYS: [string, string][] = [
  ["Mo", "Mo"],
  ["Di", "Tu"],
  ["Mi", "We"],
  ["Do", "Th"],
  ["Fr", "Fr"],
  ["Sa", "Sa"],
  ["So", "Su"],
];

export function RecordRepeat({
  row,
  fields,
  editable,
  act,
}: {
  row: Row;
  fields: Field[];
  editable: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
}) {
  const t = useT();
  const dates = fields.filter((f) => f.type === "date");
  const rule = parseRepeat(row.repeat);
  if (!dates.length) return null;
  const save = (repeat: RepeatRule | null) => void act({ action: "row.repeat", rowId: row.id, version: row.version, repeat });
  const base: RepeatRule = rule || { freq: "weekly", interval: 1, field: dates[0].id };
  const current = rule && row.cells[rule.field];
  const next = rule && validDateValue(current) ? nextOccurrence(current, rule) : null;
  return (
    <div className="row-property record-repeat">
      <span>{t("Wiederkehrende Aufgabe", "Repeating task")}</span>
      <span className="record-repeat-choice">
        <Select
          aria-label={t("Wiederkehrende Aufgabe", "Repeating task")}
          disabled={!editable}
          value={rule?.freq || ""}
          onChange={(e) =>
            save(e.target.value ? { ...base, freq: e.target.value as RepeatRule["freq"], day: undefined } : null)
          }
        >
          <option value="">{t("Nein", "No")}</option>
          {FREQS.map(([key, de, en]) => (
            <option key={key} value={key}>
              {t(de, en)}
            </option>
          ))}
        </Select>
        {rule && (
          <>
            <label>
              {t("alle", "every")}
              <input
                key={`${row.id}-${row.version}`}
                type="number"
                min={1}
                max={99}
                aria-label={t("Intervall der Wiederholung", "Repeat interval")}
                disabled={!editable}
                defaultValue={rule.interval}
                onBlur={(e) => {
                  const interval = Math.min(99, Math.max(1, Math.round(Number(e.target.value) || 1)));
                  if (interval !== rule.interval) save({ ...rule, interval });
                }}
              />
              {(() => {
                const f = FREQS.find(([key]) => key === rule.freq)!;
                return t(f[3], f[4]);
              })()}
            </label>
            {rule.freq === "weekly" && (
              <span className="record-repeat-days" role="group" aria-label={t("Wochentage", "Weekdays")}>
                {DAYS.map(([de, en], i) => {
                  const on = rule.weekdays?.includes(i + 1) || false;
                  return (
                    <button
                      key={de}
                      type="button"
                      className="chip"
                      aria-pressed={on}
                      disabled={!editable}
                      onClick={() =>
                        save({
                          ...rule,
                          weekdays: on ? (rule.weekdays || []).filter((d) => d !== i + 1) : [...(rule.weekdays || []), i + 1].sort(),
                        })
                      }
                    >
                      {t(de, en)}
                    </button>
                  );
                })}
              </span>
            )}
            {dates.length > 1 && (
              <Select
                aria-label={t("Verschobenes Datum", "Date that moves on")}
                disabled={!editable}
                value={rule.field}
                onChange={(e) => save({ ...rule, field: e.target.value, day: undefined })}
              >
                {dates.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            )}
            <small className="muted">
              {next
                ? t(`Wenn erledigt, folgt der nächste Eintrag am ${next}.`, `Once done, the next record follows on ${next}.`)
                : t("Wenn erledigt, folgt der nächste Eintrag.", "Once done, the next record follows.")}
            </small>
          </>
        )}
      </span>
    </div>
  );
}
