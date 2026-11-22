"use client";
// Settings → KI → KI-Kontingent (#382): a bar per period with what is left
// and when it resets (GET /api/ai/quota, components/ai-quota.tsx).
import { useT } from "./i18n";
import { quotaShare } from "@/lib/ai/quota-shared";
import { SettingGroup } from "./settings-ui";
import { formatQuotaAmount, periodLabel, resetText, useAiQuota } from "./ai-quota";

// Settings → KI → KI-Kontingent.
export function AiQuotaBars() {
  const t = useT();
  const s = useAiQuota();
  if (!s || (!s.applies && !s.exempt)) return null;
  return (
    <SettingGroup
      id="quota"
      title={t("KI-Kontingent", "AI quota")}
      description={t(
        "Wie viel KI über den Anbieter der Instanz dir noch bleibt. Ein eigener KI-Anbieter und die KI auf dem Gerät zählen nicht dazu.",
        "How much AI through the instance's provider you have left. Your own AI provider and on-device AI do not count.",
      )}
    >
      {s.exempt && <p className="muted ai-quota-free">{t("Für dich gilt kein persönliches Limit.", "No personal limit applies to you.")}</p>}
      <ul className="ai-quota-bars">
        {s.periods.map((p) => {
          const share = quotaShare(p);
          const tone = p.used >= p.limit ? "full" : share >= s.warnAt / 100 ? "high" : "";
          const label = periodLabel(p, t);
          return (
            <li key={`${p.level}-${p.period}`} className={`ai-quota-bar ${tone}`}>
              <div className="ai-quota-bar-text">
                <span>{label}</span>
                <strong>{t(`${formatQuotaAmount(p.left, s)} von ${formatQuotaAmount(p.limit, s)} übrig`, `${formatQuotaAmount(p.left, s)} of ${formatQuotaAmount(p.limit, s)} left`)}</strong>
              </div>
              <progress max={p.limit > 0 ? p.limit : 1} value={p.limit > 0 ? Math.min(p.used, p.limit) : 1} aria-label={label} />
              <small className="muted">{t(`Beginnt neu am ${resetText(p, s.timeZone)}`, `Resets on ${resetText(p, s.timeZone)}`)}</small>
            </li>
          );
        })}
      </ul>
      {s.after && <p className="muted ai-quota-free">{t(`Ist dein Kontingent aufgebraucht, geht es mit ${s.after} weiter.`, `Once your quota is used up, AI goes on with ${s.after}.`)}</p>}
      <p className="muted ai-quota-unit">{s.unit === "cost" ? t("Geschätzte Kosten aus den Preisen je Modell.", "Estimated cost from the prices per model.") : t("Tokens: Eingabe und Ausgabe zusammen.", "Tokens: input and output together.")}</p>
    </SettingGroup>
  );
}
