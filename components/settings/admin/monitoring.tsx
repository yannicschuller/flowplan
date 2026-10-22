"use client";
// Administration → Überwachung: operating metrics, refused requests,
// background workers, delivery, health alerts and the maintenance notice
// (components/admin-operations.tsx).
import { useT } from "../../i18n";
import { AdminOperations } from "../../admin-operations";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { duration, mb } from "./format";

export default function MonitoringSection() {
  const t = useT();
  const { data, onError } = useAdminData();
  return (
    <>
      {data ? (
        <section className="settings-section">
          <h2>{t("Betriebsmetriken", "Operating metrics")}</h2>
          <div className="admin-metrics" aria-label={t("Betriebsmetriken", "Operating metrics")}>
            {(
              [
                [t("Datenbank", "Database"), mb(data.metrics.databaseBytes)],
                [t("Uploads", "Uploads"), t(`${mb(data.metrics.uploadBytes)} · ${data.metrics.files} Dateien`, `${mb(data.metrics.uploadBytes)} · ${data.metrics.files} files`)],
                [t("Seiten", "Pages"), t(`${data.metrics.pages} aktiv · ${data.metrics.trashedPages} im Papierkorb`, `${data.metrics.pages} active · ${data.metrics.trashedPages} in trash`)],
                [t("Datensätze", "Records"), String(data.metrics.rows)],
                [
                  t("Versionen", "Versions"),
                  t(`${data.metrics.snapshots} · Aufbewahrung ${data.metrics.retentionDays ? `${data.metrics.retentionDays} Tage` : "unbegrenzt"}`, `${data.metrics.snapshots} · kept ${data.metrics.retentionDays ? `${data.metrics.retentionDays} days` : "forever"}`),
                ],
                [t("Push-Warteschlange", "Push queue"), t(`${data.metrics.pushPending} offen · ${data.metrics.pushFailed} fehlgeschlagen`, `${data.metrics.pushPending} pending · ${data.metrics.pushFailed} failed`)],
                [t("Suchindex", "Search index"), data.metrics.searchBacklog ? t(`${data.metrics.searchBacklog} Änderungen ausstehend`, `${data.metrics.searchBacklog} changes pending`) : t("aktuell", "up to date")],
                [t("Erinnerungen", "Reminders"), String(data.metrics.reminders)],
                [
                  t("Demos", "Demos"),
                  t(`${data.metrics.demosActive} laufen · ${data.metrics.demosStarted} insgesamt gestartet`, `${data.metrics.demosActive} running · ${data.metrics.demosStarted} started in total`) + (data.settings.publicDemo ? "" : t(" · ausgeschaltet", " · switched off")),
                ],
                [t("Standardkontingent", "Default quota"), data.metrics.defaultQuotaMb ? t(`${data.metrics.defaultQuotaMb} MB je Arbeitsbereich`, `${data.metrics.defaultQuotaMb} MB per workspace`) : t("unbegrenzt", "unlimited")],
                [t("Laufzeit", "Uptime"), `${duration(data.metrics.uptimeSeconds, t)} · Node ${data.metrics.node}`],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <AdminLoading />
      )}
      <AdminOperations onError={onError} />
    </>
  );
}
