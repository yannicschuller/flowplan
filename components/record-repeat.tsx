"use client";
// "Wiederkehrende Aufgabe" in the record view: once the record is done, the
// next one is created with its date moved on (lib/repeat-records.ts).
import { Repeat } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { RecordPropertyValue } from "./record-property-value";
import { Select } from "./select";
import { localDay, nextOccurrence, parseRepeat, type RepeatRule } from "@/lib/recurrence";
import { browserZone, formatDateValue, validDateValue } from "@/lib/date-values";
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
  autoOpen = false,
}: {
  row: Row;
  fields: Field[];
  editable: boolean;
  // Just added from the date's panel (#521): its controls open.
  autoOpen?: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
}) {
  const t = useT();
  const dates = fields.filter((f) => f.type === "date");
  const rule = parseRepeat(row.repeat);
  if (!dates.length) return null;
  // The rule counts days in this person's zone (lib/repeat-records.ts).
  const zone = browserZone();
  const save = (repeat: RepeatRule | null) =>
    void act({ action: "row.repeat", rowId: row.id, version: row.version, repeat: repeat && { ...repeat, timeZone: zone } });
  const base: RepeatRule = rule || { freq: "weekly", interval: 1, field: dates[0].id };
  const current = rule && row.cells[rule.field];
  const next = rule && validDateValue(current) ? nextOccurrence(localDay(current, rule.timeZone || "UTC"), rule) : null;
  const freq = rule && FREQS.find(([key]) => key === rule.freq);
  const unit = freq ? t(freq[3], freq[4]) : "";
  const summary = !rule || !freq ? "" : rule.interval > 1 ? t(`Alle ${rule.interval} ${unit}`, `Every ${rule.interval} ${unit}`) : t(freq[1], freq[2]);
  return (
    <div className="row-property record-repeat">
      <span className="row-property-name">
        <Repeat size={13} aria-hidden />
        <span className="row-property-label">{t("Wiederkehrende Aufgabe", "Repeating task")}</span>
      </span>
      {editable ? (
        // Compact like the properties (#519, #521): the rule as text, its
        // controls on click.
        <span className="row-property-value">
          <RecordPropertyValue
            name={t("Wiederkehrende Aufgabe", "Repeating task")}
            autoOpen={autoOpen}
            text={summary}
            emptyText={t("Nein", "No")}
            display={summary || null}
            editor={() => (
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
                  // One sentence that wraps as a whole: "alle [1] Wochen · [Mo Di …]
                  // · gerechnet ab [Start ▾]".
                  <span className="record-repeat-rule">
                    <label className="record-repeat-every">
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
                    {/* The date property the next record moves on from (the rule's
                        field); the record's other dates move by as many days. Only
                        a choice with more than one date property. */}
                    {dates.length > 1 && (
                      <span
                        className="record-repeat-field"
                        title={t(
                          "Der nächste Eintrag rechnet ab diesem Datum weiter. Andere Datumswerte rücken um gleich viele Tage mit.",
                          "The next record counts on from this date. Other dates move on by the same number of days.",
                        )}
                      >
                        {t("gerechnet ab", "counted from")}
                        <Select
                          aria-label={t("Gerechnet ab Datum", "Counted from date")}
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
                      </span>
                    )}
                  </span>
                )}
                {rule && (
                  <small className="muted">
                    {next
                      ? t(`Wenn erledigt, folgt der nächste Eintrag am ${formatDateValue(next)}.`, `Once done, the next record follows on ${formatDateValue(next)}.`)
                      : t("Wenn erledigt, folgt der nächste Eintrag.", "Once done, the next record follows.")}
                  </small>
                )}
              </span>
            )}
          />
        </span>
      ) : (
        <span className="record-value readonly">{summary || <span className="record-value-empty">{t("Nein", "No")}</span>}</span>
      )}
    </div>
  );
}
