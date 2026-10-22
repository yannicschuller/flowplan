"use client";
// Settings → Offline & Geräte: the offline copy on this device.
import { useT } from "../../i18n";
import { OfflineSettings } from "../../offline-settings";
import { useUserSettings } from "../user-context";

export default function DevicesSection() {
  const t = useT();
  const { boot } = useUserSettings();
  return (
    <>
      <OfflineSettings userId={boot.user.id} workspaceId={boot.workspace.id} />
      <section className="settings-section">
        <h2>{t("Offline & Synchronisierung", "Offline & sync")}</h2>
        <p>
          {t("Dokumente und Whiteboards werden zusätzlich auf diesem Gerät gespeichert und nach Wiederherstellung der Verbindung zusammengeführt. Einträge in Datenbanken lassen sich offline anlegen, ändern und löschen; Konflikte kannst du danach auflösen.", "Documents and whiteboards are also stored on this device and merged once the connection is back. Database records can be created, changed and deleted offline; you can resolve conflicts afterwards.")}
        </p>
      </section>
    </>
  );
}
