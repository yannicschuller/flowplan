"use client";
// The calm notice once storage or the personal AI quota reaches 80 % and
// again at 100 % (lib/limits-summary.ts limitNotices): above the page, with
// "Speicher & KI ansehen" and, when the instance has one, "Mehr Speicher
// oder KI?". Closed is closed – per account and device (localStorage, like
// the maintenance banner): storage until the usage drops below the level
// and rises again, AI until the next period.
import { useEffect, useState } from "react";
import { ArrowSquareOut, Gauge, X } from "@phosphor-icons/react";
import type { Bootstrap } from "@/lib/types";
import { LOCALE_TAG } from "@/lib/locale-tag";
import {
  USAGE_LINK,
  aiPeriodKey,
  aiSummary,
  dismissNotice,
  limitNotices,
  parseNoticeMemory,
  periodPhrase,
  quotaPossible,
  storageSummary,
  type NoticeInput,
  type NoticeKind,
  type NoticeMemory,
} from "@/lib/limits-summary";
import { resetText, useAiQuota } from "./ai-quota";
import { useT } from "./i18n";

const memoryKey = (userId: string) => `flowplan-limit-notices:${userId}`;
function readMemory(userId: string): NoticeMemory {
  try {
    return parseNoticeMemory(localStorage.getItem(memoryKey(userId)));
  } catch {
    return {};
  }
}
function writeMemory(userId: string, memory: NoticeMemory) {
  try {
    if (Object.keys(memory).length) localStorage.setItem(memoryKey(userId), JSON.stringify(memory));
    else localStorage.removeItem(memoryKey(userId));
  } catch {}
}

export function LimitsNotice({ boot }: { boot: Bootstrap }) {
  const t = useT();
  const quota = useAiQuota(quotaPossible(boot.ai, !!boot.user.demo));
  const [memory, setMemory] = useState<NoticeMemory | null>(null);
  const userId = boot.user.id;
  const storage = boot.myLimits ? storageSummary(boot.myLimits, t, LOCALE_TAG) : null;
  const ai = aiSummary(boot.ai, quota, t, LOCALE_TAG);
  const loading = quotaPossible(boot.ai, !!boot.user.demo) && !quota;
  const input: NoticeInput = { storage: storage?.level || 0, ai: loading ? undefined : ai.period ? { level: ai.level, key: aiPeriodKey(ai.period) } : null };
  const { show, memory: kept } = limitNotices(input, memory || {});
  // Read in the browser only; what no longer applies is forgotten.
  useEffect(() => setMemory(readMemory(userId)), [userId]);
  const keptJson = JSON.stringify(kept);
  useEffect(() => {
    if (memory && keptJson !== JSON.stringify(memory)) writeMemory(userId, kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keptJson, userId, memory]);
  if (!memory || !show.length) return null;
  const close = (kind: NoticeKind) => {
    const next = dismissNotice(input, memory, kind);
    writeMemory(userId, next);
    setMemory(next);
  };
  const more = boot.myLimits?.moreUrl || null;
  const text = (kind: NoticeKind) => {
    if (kind === "storage")
      return storage!.level === 100
        ? t(`Dein Speicher ist voll (${storage!.text}).`, `Your storage is full (${storage!.text}).`)
        : t(`Dein Speicher ist fast voll (${storage!.text}).`, `Your storage is nearly full (${storage!.text}).`);
    const when = periodPhrase(ai.period!.period, t);
    if (ai.level === 100)
      return quota?.after
        ? t(`Dein KI-Kontingent für ${when} ist aufgebraucht – es geht mit ${quota.after} weiter.`, `Your AI quota for ${when} is used up – AI goes on with ${quota.after}.`)
        : t(`Dein KI-Kontingent für ${when} ist aufgebraucht – wieder ab ${resetText(ai.period!, quota!.timeZone)}.`, `Your AI quota for ${when} is used up – available again from ${resetText(ai.period!, quota!.timeZone)}.`);
    return t(`Du hast den Großteil deines KI-Kontingents für ${when} verbraucht (${ai.text}).`, `You have used most of your AI quota for ${when} (${ai.text}).`);
  };
  return (
    <div className="instance-banners limits-notices">
      {show.map((kind) => (
        <div key={kind} className="instance-banner tone-info limits-notice" role="status" data-kind={kind}>
          <Gauge size={16} aria-hidden />
          <span className="instance-banner-text">{text(kind)}</span>
          <a className="instance-banner-link" href={USAGE_LINK} onClick={() => close(kind)}>
            {t("Speicher & KI ansehen", "View storage & AI")}
          </a>
          {more && (
            <a className="instance-banner-link" href={more} target="_blank" rel="noopener noreferrer">
              {t("Mehr Speicher oder KI?", "More storage or AI?")}
              <ArrowSquareOut size={13} aria-hidden />
            </a>
          )}
          <button type="button" className="instance-banner-close" aria-label={t("Hinweis schließen", "Close notice")} title={t("Schließen", "Close")} onClick={() => close(kind)}>
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
