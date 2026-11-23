"use client";
// Settings → KI: one's AI features, an own provider and what the AI may
// read. The AI quota (#382) lives under Speicher & KI; here a line with
// what is left and the link.
import { LOCALE_TAG } from "@/lib/locale-tag";
import { aiSummary, quotaPossible } from "@/lib/limits-summary";
import { UserAiSettings } from "../../ai-settings";
import { useAiQuota } from "../../ai-quota";
import { useT } from "../../i18n";
import { useUserSettings } from "../user-context";
import { UsageMovedNote } from "./usage";

export default function AiSection() {
  const t = useT();
  const { boot, onError, onRefresh } = useUserSettings();
  const quota = useAiQuota(quotaPossible(boot.ai, !!boot.user.demo));
  const summary = aiSummary(boot.ai, quota, t, LOCALE_TAG);
  return (
    <>
      {!boot.user.demo && <UsageMovedNote summary={summary.state === "quota" ? t(`KI-Kontingent: ${summary.text}`, `AI quota: ${summary.text}`) : undefined} />}
      <UserAiSettings boot={boot} onError={onError} onRefresh={onRefresh} />
    </>
  );
}
