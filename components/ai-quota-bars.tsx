"use client";
// The AI quota's bars (#382): one per period with what is left and when it
// resets (GET /api/ai/quota, components/ai-quota.tsx). Shown under
// Settings → Speicher & KI (components/settings/user/usage.tsx).
import { useT } from "./i18n";
import { quotaShare, type QuotaPeriodState, type QuotaStatus } from "@/lib/ai/quota-shared";
import { formatQuotaAmount, periodLabel, resetText } from "./ai-quota";

export function QuotaBarList({ status: s, periods }: { status: QuotaStatus; periods: QuotaPeriodState[] }) {
  const t = useT();
  if (!periods.length) return null;
  return (
    <ul className="ai-quota-bars">
      {periods.map((p) => {
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
  );
}
