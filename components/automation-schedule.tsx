"use client";
// Scheduled automation rules: when they run ("every Monday at 09:00",
// "monthly on the 1st", "every 3 days") and the record they create from a
// record template, with dates relative to the run ("Due: +3 days").
import { Trash } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Select } from "./select";
import type { AutomationAction, ScheduleTrigger } from "@/lib/database-settings-schema";
import type { Field } from "@/lib/types";

export type RowTemplateRef = { id: string; name: string; is_default?: number };
type CreateAction = Extract<AutomationAction, { type: "create" }>;
type T = (de: string, en: string) => string;

// i18n-table: 1 – [German, English] pairs
const WEEKDAYS: [string, string][] = [
  ["Montag", "Monday"],
  ["Dienstag", "Tuesday"],
  ["Mittwoch", "Wednesday"],
  ["Donnerstag", "Thursday"],
  ["Freitag", "Friday"],
  ["Samstag", "Saturday"],
  ["Sonntag", "Sunday"],
];

export function scheduledTrigger(timeZone: string): ScheduleTrigger {
  return { type: "schedule", freq: "weekly", interval: 1, weekday: 1, day: 1, time: "09:00", timeZone };
}
// A new record from the default (or first) template; a due date, if there
// is one, three days after the run.
export function createAction(templates: RowTemplateRef[], dates: Field[]): CreateAction {
  const template = templates.find((x) => x.is_default) || templates[0];
  const due = dates.find((f) => /fällig|due|deadline|frist/i.test(f.name));
  return { type: "create", template: template?.id || "", cells: {}, dates: due ? { [due.id]: 3 } : {} };
}

export function scheduleLabel(s: ScheduleTrigger, t: T) {
  const [de, en] = WEEKDAYS[s.weekday - 1] || WEEKDAYS[0];
  // The weekday in the reader's language, inserted into either sentence.
  const weekday = t(de, en);
  if (s.freq === "daily")
    return s.interval === 1 ? t(`Täglich um ${s.time}`, `Daily at ${s.time}`) : t(`Alle ${s.interval} Tage um ${s.time}`, `Every ${s.interval} days at ${s.time}`);
  if (s.freq === "weekly")
    return s.interval === 1
      ? t(`Jeden ${weekday} um ${s.time}`, `Every ${weekday} at ${s.time}`)
      : t(`Alle ${s.interval} Wochen am ${weekday} um ${s.time}`, `Every ${s.interval} weeks on ${weekday} at ${s.time}`);
  return s.interval === 1
    ? t(`Monatlich am ${s.day}. um ${s.time}`, `Monthly on day ${s.day} at ${s.time}`)
    : t(`Alle ${s.interval} Monate am ${s.day}. um ${s.time}`, `Every ${s.interval} months on day ${s.day} at ${s.time}`);
}

const whole = (value: string, min: number, max: number) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
};

export function ScheduleFields({ trigger, onChange }: { trigger: ScheduleTrigger; onChange: (next: ScheduleTrigger) => void }) {
  const t = useT();
  return (
    <div className="automation-schedule">
      <Select aria-label={t("Rhythmus", "Frequency")} value={trigger.freq} onChange={(e) => onChange({ ...trigger, freq: e.target.value as ScheduleTrigger["freq"] })}>
        <option value="daily">{t("täglich / alle N Tage", "daily / every N days")}</option>
        <option value="weekly">{t("wöchentlich", "weekly")}</option>
        <option value="monthly">{t("monatlich", "monthly")}</option>
      </Select>
      <label>
        {t("alle", "every")}
        <input
          type="number"
          min={1}
          max={365}
          aria-label={t("Intervall", "Interval")}
          value={trigger.interval}
          onChange={(e) => onChange({ ...trigger, interval: whole(e.target.value, 1, 365) })}
        />
        {trigger.freq === "daily" ? t("Tage", "days") : trigger.freq === "weekly" ? t("Wochen", "weeks") : t("Monate", "months")}
      </label>
      {trigger.freq === "weekly" && (
        <Select aria-label={t("Wochentag", "Weekday")} value={String(trigger.weekday)} onChange={(e) => onChange({ ...trigger, weekday: Number(e.target.value) })}>
          {WEEKDAYS.map(([de, en], i) => (
            <option key={de} value={i + 1}>
              {t(de, en)}
            </option>
          ))}
        </Select>
      )}
      {trigger.freq === "monthly" && (
        <label>
          {t("am", "on day")}
          <input
            type="number"
            min={1}
            max={31}
            aria-label={t("Tag des Monats", "Day of the month")}
            value={trigger.day}
            onChange={(e) => onChange({ ...trigger, day: whole(e.target.value, 1, 31) })}
          />
        </label>
      )}
      <label>
        {t("um", "at")}
        <input type="time" aria-label={t("Uhrzeit", "Time")} value={trigger.time} onChange={(e) => e.target.value && onChange({ ...trigger, time: e.target.value.slice(0, 5) })} />
      </label>
      <p className="muted">
        {t(
          `Zeitzone ${trigger.timeZone}. Läuft einmal je Termin als die Person, die die Regel speichert; verpasste Termine werden nicht nachgeholt.`,
          `Time zone ${trigger.timeZone}. Runs once per date as the person who saves the rule; missed dates are not made up.`,
        )}
      </p>
    </div>
  );
}

export function CreateActionFields({
  action,
  fields,
  templates,
  onChange,
  onRemove,
}: {
  action: CreateAction;
  fields: Field[];
  templates: RowTemplateRef[];
  onChange: (next: CreateAction) => void;
  onRemove?: () => void;
}) {
  const t = useT();
  const dates = fields.filter((f) => f.type === "date");
  return (
    <div className="automation-create">
      <div className="automation-row">
        <span>{t("Datensatz anlegen aus", "Create a record from")}</span>
        <Select aria-label={t("Datensatzvorlage", "Record template")} value={action.template} onChange={(e) => onChange({ ...action, template: e.target.value })}>
          <option value="">{t("leerem Datensatz", "an empty record")}</option>
          {templates.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </Select>
        {onRemove && (
          <button type="button" className="icon-button" aria-label={t("Aktion entfernen", "Remove action")} onClick={onRemove}>
            <Trash />
          </button>
        )}
      </div>
      {!templates.length && (
        <p className="muted">{t("Vorlagen legst du im Menü „…“ unter „Datensatzvorlagen“ an.", "Create templates in the “…” menu under “Record templates”.")}</p>
      )}
      {dates.map((f) => {
        const days = action.dates[f.id];
        return (
          <label key={f.id} className="automation-row">
            <span>{f.name}</span>
            <input
              type="number"
              min={-3650}
              max={3650}
              aria-label={t(`${f.name}: Tage nach der Ausführung`, `${f.name}: days after the run`)}
              placeholder={t("nicht setzen", "leave as is")}
              value={days ?? ""}
              onChange={(e) => {
                const next = { ...action.dates };
                if (e.target.value === "") delete next[f.id];
                else next[f.id] = whole(e.target.value, -3650, 3650);
                onChange({ ...action, dates: next });
              }}
            />
            <small className="muted">{t("Tage nach dem Termin (0 = am Tag selbst)", "days after the run (0 = the same day)")}</small>
          </label>
        );
      })}
    </div>
  );
}
