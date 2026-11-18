"use client";
// Administration → Überwachung: the stuck Litestream replica
// (lib/litestream-health.ts), next to the data folder warning. The check
// every 15 minutes finds it; the repair runs on the next start of the
// container (docker/entrypoint.sh deletes <prefix>/db/ in the bucket and
// Litestream begins with a full snapshot). The buttons write the same
// marker by hand ("Replik jetzt neu aufbauen"), take it back, or end the
// process so that the container restarts ("Jetzt neu starten").
import { useState } from "react";
import { ArrowClockwise, ArrowsCounterClockwise, WarningCircle } from "@phosphor-icons/react";
import type { SystemOverview } from "@/lib/cluster/system";
import type { LitestreamAction } from "@/lib/litestream-health";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { useAdmin } from "../admin-context";
import { dateTime, num } from "./monitoring-format";
import { useDocs } from "./parts";

export function LitestreamWarning({ s, reload }: { s: SystemOverview; reload: () => void }) {
  const t = useT();
  const docs = useDocs();
  const { onError } = useAdmin();
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const ls = s.litestream;
  if (!ls?.active) return null;
  const incident = ls.incident;
  const scheduled = ls.marker === "remote";
  if (!incident && !scheduled) return null;
  const act = async (action: LitestreamAction) => {
    setBusy(true);
    try {
      await api("/api/admin/monitoring", { action });
      if (action === "litestream.restart") setRestarting(true);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
      reload();
    }
  };
  const rebuild = () => {
    if (
      confirm(
        t(
          "Replik jetzt neu aufbauen? Beim nächsten Neustart löscht Flowplan den Ordner db/ der Litestream-Replik im Bucket und lädt einen vollständigen Snapshot hoch. Bis dahin gibt es im Bucket keinen früheren Zeitpunkt zum Wiederherstellen; Dateien, Sicherungen und die Datenbank im Volume bleiben. Sind geplante Sicherungen an, legt Flowplan vorher eine an.",
          "Rebuild the replica now? On the next restart Flowplan deletes the db/ folder of the Litestream replica in the bucket and uploads a full snapshot. Until then there is no earlier point in time to restore from the bucket; files, backups and the database in the volume stay. If scheduled backups are on, Flowplan makes one first.",
        ),
      )
    )
      void act("litestream.rebuild");
  };
  const restart = () => {
    if (
      confirm(
        t(
          "Flowplan jetzt neu starten? Alle sind für einen Moment getrennt. Der Container startet nur von selbst wieder, wenn er eine Neustart-Richtlinie hat (etwa restart: unless-stopped; in Coolify der Standard).",
          "Restart Flowplan now? Everyone is disconnected for a moment. The container only starts again by itself if it has a restart policy (such as restart: unless-stopped; the default in Coolify).",
        ),
      )
    )
      void act("litestream.restart");
  };
  const link = (
    <a href={docs("storage-and-backups", "litestream-zustand-reparieren", "repair-the-litestream-state")} target="_blank" rel="noreferrer">
      {t("Litestream-Zustand reparieren", "Repair the Litestream state")}
    </a>
  );
  const scheduledText = t(
    "Die Replik wird beim nächsten Neustart repariert: Flowplan löscht dann den Ordner db/ im Bucket, und Litestream beginnt mit einem vollständigen Snapshot. Das passiert beim nächsten Update oder Neustart von selbst – oder jetzt mit „Jetzt neu starten“.",
    "The replica is repaired on the next restart: Flowplan then deletes the db/ folder in the bucket, and Litestream starts over with a full snapshot. That happens by itself with the next update or restart – or now with “Restart now”.",
  );
  const buttons = (
    <span className="mon-note-actions">
      {scheduled ? (
        <>
          <button type="button" className="button" disabled={busy || restarting} onClick={restart}>
            <ArrowClockwise size={16} aria-hidden />
            {t("Jetzt neu starten", "Restart now")}
          </button>
          <button type="button" className="button" disabled={busy || restarting} onClick={() => void act("litestream.cancel")}>
            {t("Reparatur abbrechen", "Cancel the repair")}
          </button>
        </>
      ) : (
        <button type="button" className="button" disabled={busy} onClick={rebuild}>
          <ArrowsCounterClockwise size={16} aria-hidden />
          {t("Replik jetzt neu aufbauen", "Rebuild the replica now")}
        </button>
      )}
    </span>
  );
  if (restarting)
    return (
      <p className="mon-note" role="status">
        <ArrowClockwise size={16} aria-hidden />
        <span>{t("Flowplan startet neu und repariert dabei die Litestream-Replik. Die Seite verbindet sich danach von selbst wieder.", "Flowplan is restarting and repairs the Litestream replica on the way. The page reconnects by itself afterwards.")}</span>
      </p>
    );
  if (!incident)
    return (
      <div className="mon-note" role="status" data-testid="litestream-warning">
        <ArrowsCounterClockwise size={16} aria-hidden />
        <span>
          {scheduledText} {link}
        </span>
        {buttons}
      </div>
    );
  const files = `${num(incident.files)}${incident.truncated ? "+" : ""}`;
  const backup = incident.backup;
  return (
    <div className="mon-note warn" role="alert" data-testid="litestream-warning">
      <WarningCircle size={16} aria-hidden />
      <span>
        {t(
          `Die Litestream-Replik im Bucket hängt (seit ${dateTime(incident.since)}): ${files} Änderungsdateien der Ebene 0 werden nicht mehr zusammengefasst, die älteste ist von ${dateTime(incident.oldestAt)}. Meist liegt dort eine beschädigte Datei, etwa nach zwei Containern auf demselben Volume. Die Datenbank im Volume ist in Ordnung, aber eine Wiederherstellung aus dem Bucket kann scheitern.`,
          `The Litestream replica in the bucket is stuck (since ${dateTime(incident.since)}): ${files} level 0 change files are no longer compacted, the oldest is from ${dateTime(incident.oldestAt)}. Usually a damaged file lies there, for example after two containers on the same volume. The database in the volume is fine, but a restore from the bucket may fail.`,
        )}{" "}
        {scheduled
          ? scheduledText
          : incident.repair === "backup_failed"
            ? t(
                `Die Sicherung vor der Reparatur ist fehlgeschlagen (${backup?.error || "?"}), deshalb ist noch nichts vorgemerkt.`,
                `The backup before the repair failed (${backup?.error || "?"}), so nothing is scheduled yet.`,
              )
            : incident.repair === "cancelled"
              ? t("Die Reparatur wurde abgebrochen.", "The repair was cancelled.")
              : !ls.autoheal
                ? t("Die automatische Reparatur ist aus (FLOWPLAN_LITESTREAM_AUTOHEAL=off).", "Automatic repair is off (FLOWPLAN_LITESTREAM_AUTOHEAL=off).")
                : null}{" "}
        {scheduled && backup && !backup.error && backup.name
          ? t(`Vorher gesichert: ${backup.name} (${dateTime(backup.at)}).`, `Backed up first: ${backup.name} (${dateTime(backup.at)}).`)
          : null}{" "}
        {link}
      </span>
      {buttons}
    </div>
  );
}
