"use client";
// The weekly digest e-mail (lib/weekly-digest.ts): on or off, and – only
// while AI summaries are usable for this person – with a short AI summary.
// The browser's time zone is saved with it (Monday 07:00 local time).
import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { aiUsable } from "@/lib/ai/client";
import type { AiStatus } from "@/lib/ai/features";
import type { WeeklyDigestPrefs } from "@/lib/weekly-digest";
import { SaveState, SettingGroup, StatusBadge, SwitchRow, useSaveState } from "./settings-ui";

export function WeeklyDigestSettings({
  prefs,
  ai,
  mail,
  save,
}: {
  prefs: WeeklyDigestPrefs | undefined;
  ai: AiStatus | null | undefined;
  // The instance can send e-mail.
  mail: boolean;
  save: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const t = useT();
  const [status, run] = useSaveState();
  const [local, setLocal] = useState<WeeklyDigestPrefs>(prefs || { enabled: false, aiSummary: false, timeZone: "UTC" });
  useEffect(() => {
    if (prefs) setLocal(prefs);
  }, [prefs]);
  const aiOk = aiUsable(ai, "summarize");
  const change = (next: Partial<WeeklyDigestPrefs>) => {
    const value = { ...local, ...next };
    setLocal(value);
    let timeZone = value.timeZone;
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone;
    } catch {}
    void run(() => save({ action: "notification.weekly", enabled: value.enabled, aiSummary: value.aiSummary, timeZone }));
  };
  return (
    <SettingGroup
      id="weekly-digest"
      title={t("Wöchentliche Zusammenfassung", "Weekly digest")}
      description={t(
        "Jeden Montag um 7 Uhr (deine Zeitzone) eine E-Mail: was sich in Seiten geändert hat, denen du folgst, und deine offenen und überfälligen Aufgaben.",
        "Every Monday at 7 am (your time zone) an e-mail: what changed in pages you follow, and your open and overdue tasks.",
      )}
      actions={
        <>
          <SaveState status={status} />
          {!mail && <StatusBadge tone="warn">{t("Kein E-Mail-Versand", "No e-mail sending")}</StatusBadge>}
        </>
      }
    >
      <SwitchRow
        label={t("Wöchentliche Zusammenfassung per E-Mail", "Weekly digest by e-mail")}
        description={!mail ? t("Diese Instanz versendet zurzeit keine E-Mails.", "This instance does not send e-mail at the moment.") : undefined}
        checked={local.enabled}
        onChange={(enabled) => change({ enabled })}
      />
      {aiOk && (
        <SwitchRow
          label={t("Mit kurzer KI-Zusammenfassung der Änderungen", "With a short AI summary of the changes")}
          description={t("Die Inhalte gehen an deinen KI-Anbieter – nur, was die KI lesen darf.", "The content goes to your AI provider – only what the AI may read.")}
          checked={local.aiSummary}
          disabled={!local.enabled}
          onChange={(aiSummary) => change({ aiSummary })}
        />
      )}
    </SettingGroup>
  );
}
