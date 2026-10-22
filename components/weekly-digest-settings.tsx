"use client";
// The weekly digest e-mail (lib/weekly-digest.ts): on or off, and – only
// while AI summaries are usable for this person – with a short AI summary.
// The browser's time zone is saved with it (Monday 07:00 local time).
import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { aiUsable } from "@/lib/ai/client";
import type { AiStatus } from "@/lib/ai/features";
import type { WeeklyDigestPrefs } from "@/lib/weekly-digest";

export function WeeklyDigestSettings({
  prefs,
  ai,
  mail,
  save,
  onError,
}: {
  prefs: WeeklyDigestPrefs | undefined;
  ai: AiStatus | null | undefined;
  // The instance can send e-mail.
  mail: boolean;
  save: (body: Record<string, unknown>) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [local, setLocal] = useState<WeeklyDigestPrefs>(prefs || { enabled: false, aiSummary: false, timeZone: "UTC" });
  useEffect(() => {
    if (prefs) setLocal(prefs);
  }, [prefs]);
  const aiOk = aiUsable(ai, "summarize");
  const change = async (next: Partial<WeeklyDigestPrefs>) => {
    const value = { ...local, ...next };
    setLocal(value);
    let timeZone = value.timeZone;
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone;
    } catch {}
    try {
      await save({ action: "notification.weekly", enabled: value.enabled, aiSummary: value.aiSummary, timeZone });
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <section className="settings-section">
      <h2>{t("Wöchentliche Zusammenfassung", "Weekly digest")}</h2>
      <p className="muted">
        {t(
          "Jeden Montag um 7 Uhr (deine Zeitzone) eine E-Mail: was sich in Seiten geändert hat, denen du folgst, und deine offenen und überfälligen Aufgaben.",
          "Every Monday at 7 am (your time zone) an e-mail: what changed in pages you follow, and your open and overdue tasks.",
        )}
        {!mail && ` ${t("Diese Instanz versendet zurzeit keine E-Mails.", "This instance does not send e-mail at the moment.")}`}
      </p>
      <label className="settings-check">
        <input type="checkbox" checked={local.enabled} onChange={(e) => void change({ enabled: e.target.checked })} />
        {t("Wöchentliche Zusammenfassung per E-Mail", "Weekly digest by e-mail")}
      </label>
      {aiOk && (
        <label className="settings-check">
          <input type="checkbox" checked={local.aiSummary} disabled={!local.enabled} onChange={(e) => void change({ aiSummary: e.target.checked })} />
          {t("Mit kurzer KI-Zusammenfassung der Änderungen", "With a short AI summary of the changes")}
          <small className="muted">
            {" "}
            {t(
              "Die Inhalte gehen an deinen KI-Anbieter – nur, was die KI lesen darf.",
              "The content goes to your AI provider – only what the AI may read.",
            )}
          </small>
        </label>
      )}
    </section>
  );
}
