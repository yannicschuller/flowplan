"use client";
// Administration → Wartung & Hinweise: the notice everyone sees above every
// page (instance setting "announcement") and a maintenance window with start
// and end (lib/admin-ops.ts, shown as a banner until it has ended).
import { useEffect, useRef, useState } from "react";
import { Megaphone } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { OpsOverview } from "@/lib/admin-ops";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { EmptyState, SaveState, SettingGroup, SettingRow, StatusBadge, useSaveState } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, InstanceText, type StatusItem } from "./parts";

type Notice = OpsOverview["maintenance"];
const when = (ms: number) =>
  new Date(ms).toLocaleString(LOCALE_TAG, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
// "2026-10-22T14:30" for datetime-local fields, in local time.
const localInput = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export default function MaintenanceSection() {
  const t = useT();
  const { data, onError } = useAdminData();
  // undefined while loading the stored notice.
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    api<OpsOverview>("/api/admin/operations")
      .then((r) => setNotice(r.maintenance))
      .catch((e: Error) => report.current(e.message));
  }, []);
  if (!data || notice === undefined) return <AdminLoading />;
  const now = Date.now();
  const phase = !notice ? "none" : notice.end <= now ? "past" : notice.start > now ? "planned" : "now";
  const banner = data.settings.announcement.trim();
  const items: StatusItem[] = [
    banner ? { tone: "info", label: t("Hinweis wird angezeigt", "Notice shown") } : { tone: "off", label: t("Kein Hinweis", "No notice") },
    phase === "now"
      ? { tone: "warn", label: t("Wartung läuft", "Maintenance running") }
      : phase === "planned"
        ? { tone: "info", label: t("Wartung geplant", "Maintenance planned") }
        : {
            tone: "off",
            label: t("Keine Wartung geplant", "No maintenance planned"),
          },
  ];
  return (
    <>
      <AdminStatus items={items}>
        {phase === "planned" || phase === "now"
          ? t(`Wartung ${when(notice!.start)} – ${when(notice!.end)}.`, `Maintenance ${when(notice!.start)} – ${when(notice!.end)}.`)
          : t("Beides erscheint als Banner über jeder Seite, für alle angemeldeten Personen.", "Both appear as a banner above every page, for everyone signed in.")}
      </AdminStatus>
      <SettingGroup
        id="notice"
        title={t("Hinweis für alle", "Notice for everyone")}
        description={t("Ein dauerhafter Banner, bis du ihn leerst – etwa für Umzüge oder neue Regeln.", "A lasting banner until you clear it – e.g. for moves or new rules.")}
      >
        <InstanceText
          field="announcement"
          multiline
          maxLength={500}
          label={t("Hinweis für alle Personen", "Notice for everyone")}
          description={t("Leer = kein Hinweis.", "Empty = no notice.")}
          placeholder={t("z. B. Ab Montag gilt die neue Ablage", "e.g. The new filing applies from Monday")}
        />
      </SettingGroup>
      <MaintenanceWindow notice={notice} phase={phase} onSaved={setNotice} />
    </>
  );
}

function MaintenanceWindow({ notice, phase, onSaved }: { notice: Notice; phase: string; onSaved: (n: Notice) => void }) {
  const t = useT();
  const [message, setMessage] = useState(notice?.message || "");
  const [start, setStart] = useState(notice ? localInput(notice.start) : "");
  const [end, setEnd] = useState(notice ? localInput(notice.end) : "");
  const [editing, setEditing] = useState(!!notice);
  const [status, run] = useSaveState();
  const send = (next: { message: string; start: number; end: number } | null) =>
    run(async () => {
      const answer = await api<OpsOverview>("/api/admin/operations", {
        action: "maintenance.save",
        notice: next,
      });
      onSaved(answer.maintenance);
      return true;
    });
  const badge =
    phase === "now" ? (
      <StatusBadge tone="warn">{t("Wird angezeigt", "Shown")}</StatusBadge>
    ) : phase === "planned" ? (
      <StatusBadge tone="info">{t("Geplant", "Planned")}</StatusBadge>
    ) : phase === "past" ? (
      <StatusBadge tone="off">{t("Abgelaufen", "Expired")}</StatusBadge>
    ) : null;
  return (
    <SettingGroup
      id="maintenance-window"
      title={t("Wartungshinweis", "Maintenance notice")}
      description={t(
        "Mit Beginn und Ende: Alle angemeldeten Personen sehen ihn ab dem Speichern, nach dem Ende verschwindet er von selbst.",
        "With start and end: everyone signed in sees it from saving on; it disappears by itself after the end.",
      )}
      actions={badge}
    >
      {!editing ? (
        <div className="setting-row wide">
          <EmptyState
            icon={<Megaphone size={18} />}
            title={t("Keine Wartung geplant", "No maintenance planned")}
            action={
              <button type="button" className="button" onClick={() => setEditing(true)}>
                {t("Wartung ankündigen", "Announce maintenance")}
              </button>
            }
          >
            {t("Kündige Updates oder Ausfälle mit Uhrzeit an.", "Announce updates or downtime with a time.")}
          </EmptyState>
        </div>
      ) : (
        <form
          className="admin-maintenance-form"
          aria-label={t("Wartungshinweis", "Maintenance notice")}
          onSubmit={(e) => {
            e.preventDefault();
            void send({
              message,
              start: new Date(start).getTime(),
              end: new Date(end).getTime(),
            });
          }}
        >
          <SettingRow id="maintenance-text" label={t("Text", "Text")} description={t("Höchstens 300 Zeichen.", "At most 300 characters.")}>
            <input
              id="maintenance-text"
              className="control-lg"
              required
              maxLength={300}
              value={message}
              placeholder={t("z. B. Update auf die neue Version", "e.g. Update to the new version")}
              onChange={(e) => setMessage(e.target.value)}
            />
          </SettingRow>
          <SettingRow id="maintenance-start" label={t("Beginn", "Start")} description={t("In deiner Zeitzone.", "In your time zone.")}>
            <input id="maintenance-start" className="control-md" type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
          </SettingRow>
          <SettingRow id="maintenance-end" label={t("Ende", "End")}>
            <input id="maintenance-end" className="control-md" type="datetime-local" required min={start || undefined} value={end} onChange={(e) => setEnd(e.target.value)} />
          </SettingRow>
          <div className="setting-row admin-form-actions">
            <SaveState status={status} />
            {notice ? (
              <button
                type="button"
                className="button"
                disabled={status.state === "saving"}
                onClick={async () => {
                  if (await send(null)) {
                    setMessage("");
                    setStart("");
                    setEnd("");
                    setEditing(false);
                  }
                }}
              >
                {t("Hinweis entfernen", "Remove notice")}
              </button>
            ) : (
              <button type="button" className="button" onClick={() => setEditing(false)}>
                {t("Abbrechen", "Cancel")}
              </button>
            )}
            <button className="button primary" disabled={status.state === "saving"}>
              {t("Hinweis speichern", "Save notice")}
            </button>
          </div>
        </form>
      )}
    </SettingGroup>
  );
}
