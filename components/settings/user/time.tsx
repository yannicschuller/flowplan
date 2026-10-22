"use client";
// Settings → Zeiten: time tracked in all databases – filters, totals, the
// entries with their billing status, rates and the exports in one card.
import { useT } from "../../i18n";
import { SettingGroup } from "../../settings-ui";
import { TimeReport } from "../../time-report";
import { useUserSettings } from "../user-context";

export default function TimeSection() {
  const t = useT();
  const { boot } = useUserSettings();
  return (
    <SettingGroup
      id="report"
      title={t("Auswertung", "Report")}
      description={t("Zeiten aus allen Datenbanken mit Zeiterfassung, die du lesen darfst. Ein Klick auf einen Balken zeigt die Einträge dahinter.", "Time from all databases with time tracking you may read. Clicking a bar shows the entries behind it.")}
    >
      <div className="setting-row wide ws-time">
        <TimeReport workspaceId={boot.workspace.id} title={boot.workspace.name} />
      </div>
    </SettingGroup>
  );
}
