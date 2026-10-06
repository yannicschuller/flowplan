"use client";
import { useCallback, useEffect, useState } from "react";
import { Play, Stop, Trash, Timer } from "@phosphor-icons/react";
import { useT, useLocale } from "./i18n";
import { api } from "./ui";
import { formatDuration, parseMinutes } from "@/lib/durations";
import type { Field, Row } from "@/lib/types";

type Data = {
  total: number;
  running: number | null;
  others: string[];
  entries: { id: string; name: string; mine: boolean; start: number; end: number | null; seconds: number; note: string }[];
};

// Timer and time entries of a record, for one time tracking property.
export function RecordTime({
  pageId,
  row,
  field,
  estimate,
  editable,
  onChanged,
  onError,
}: {
  pageId: string;
  row: Row;
  field: Field;
  estimate: number | null;
  editable: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [data, setData] = useState<Data | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState({ minutes: "", date: new Date().toISOString().slice(0, 10), note: "" });
  const load = useCallback(
    () =>
      api<Data>(`/api/time-entries?page=${pageId}&row=${row.id}&field=${encodeURIComponent(field.id)}`)
        .then(setData)
        .catch(() => setData(null)),
    [pageId, row.id, field.id],
  );
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!data?.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [data?.running]);
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      setData(await api<Data>("/api/command", { pageId, rowId: row.id, fieldId: field.id, ...body }));
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!data) return null;
  const running = data.running ? Math.max(0, Math.round((now - data.running) / 1000)) : 0;
  const clock = `${Math.floor(running / 3600)}:${String(Math.floor((running % 3600) / 60)).padStart(2, "0")}:${String(running % 60).padStart(2, "0")}`;
  const total = data.entries.filter((e) => e.end !== null).reduce((s, e) => s + e.seconds, 0) + running;
  const over = estimate !== null && total > estimate * 3600;
  const day = (ms: number) => new Date(ms).toLocaleDateString(locale === "de" ? "de-DE" : "en-GB", { day: "2-digit", month: "short" });
  return (
    <section className="settings-section record-time" aria-label={field.name}>
      <h3>
        <Timer aria-hidden /> {field.name}
      </h3>
      <div className="record-time-head">
        <strong className={over ? "over" : ""}>{formatDuration(total)}</strong>
        {estimate !== null && (
          <span className="muted">
            {t("von", "of")} {estimate} h {t("geschätzt", "estimated")}
          </span>
        )}
        {editable &&
          (data.running ? (
            <button className="button compact danger" disabled={busy} onClick={() => void send({ action: "time.stop" })}>
              <Stop weight="fill" /> {t("Stopp", "Stop")} <span className="record-time-clock">{clock}</span>
            </button>
          ) : (
            <button className="button compact primary" disabled={busy} onClick={() => void send({ action: "time.start" })}>
              <Play weight="fill" /> {t("Start", "Start")}
            </button>
          ))}
      </div>
      {estimate !== null && (
        <div className="progress-track wide" aria-hidden>
          <span className={over ? "over" : ""} style={{ width: `${Math.min(100, (total / (estimate * 3600 || 1)) * 100)}%` }} />
        </div>
      )}
      {data.others.length > 0 && (
        <p className="muted">
          {t("Läuft gerade bei", "Running for")} {data.others.join(", ")}
        </p>
      )}
      {editable && (
        <form
          className="record-time-add"
          onSubmit={(e) => {
            e.preventDefault();
            const value = parseMinutes(manual.minutes);
            if (!value || value < 1 || value > 24 * 60) return onError(t("Bitte Minuten, h:mm oder z. B. 1,5h eingeben.", "Please enter minutes, h:mm or e.g. 1.5h."));
            void send({ action: "time.add", minutes: value, date: manual.date, note: manual.note }).then(() =>
              setManual({ ...manual, minutes: "", note: "" }),
            );
          }}
        >
          <input
            aria-label={t("Dauer (Minuten, h:mm oder 1,5h)", "Duration (minutes, h:mm or 1.5h)")}
            placeholder={t("z. B. 45 oder 1:30", "e.g. 45 or 1:30")}
            value={manual.minutes}
            inputMode="numeric"
            onChange={(e) => setManual({ ...manual, minutes: e.target.value })}
          />
          <input type="date" aria-label={t("Datum", "Date")} value={manual.date} onChange={(e) => setManual({ ...manual, date: e.target.value })} />
          <input aria-label={t("Notiz", "Note")} placeholder={t("Notiz (optional)", "Note (optional)")} maxLength={300} value={manual.note} onChange={(e) => setManual({ ...manual, note: e.target.value })} />
          <button className="button compact" disabled={busy || !manual.minutes}>
            {t("Nachtragen", "Add")}
          </button>
        </form>
      )}
      {data.entries.length > 0 && (
        <ul className="record-time-entries">
          {data.entries.map((e) => (
            <li key={e.id}>
              <span>{day(e.start)}</span>
              <span>{e.name}</span>
              <span className="muted">{e.note}</span>
              <strong>{e.end === null ? t("läuft", "running") : formatDuration(e.seconds)}</strong>
              {editable && e.mine && e.end !== null && (
                <button className="icon-button" aria-label={t("Zeiteintrag löschen", "Delete time entry")} disabled={busy} onClick={() => void send({ action: "time.delete", entryId: e.id })}>
                  <Trash />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
