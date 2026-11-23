"use client";
// Settings → Speicher & KI: everything about what a person has on this
// instance in one place – storage (used, limit, where it comes from), the
// largest upload, own workspaces, storage per workspace, the AI quota with
// its periods and what happens afterwards, the models, and the instance's
// "Mehr Speicher oder KI?" link. Texts and shares: lib/limits-summary.ts.
import { useEffect } from "react";
import { ArrowRight, ArrowSquareOut, Gauge } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { explainStorage, storageSizeText } from "@/lib/limit-explain";
import { USAGE_LINK, afterLine, aiState, aiSummary, instanceCeiling, personalPeriod, quotaPossible, storageSummary, type MyLimits, type T } from "@/lib/limits-summary";
import { AI_REASON_TEXT, type AiStatus } from "@/lib/ai/features";
import { settingsHash } from "@/lib/settings-sections";
import { useT } from "../../i18n";
import { SettingGroup, SettingRow } from "../../settings-ui";
import { QuotaBarList } from "../../ai-quota-bars";
import { refreshAiQuota, resetText, useAiQuota } from "../../ai-quota";
import { useUserSettings } from "../user-context";

export default function UsageSection() {
  const t = useT();
  const { boot } = useUserSettings();
  const quota = useAiQuota(quotaPossible(boot.ai, !!boot.user.demo));
  // The notice may have asked a while ago: this page shows the numbers of now.
  useEffect(() => refreshAiQuota(), []);
  return (
    <>
      {boot.myLimits && <StorageCard limits={boot.myLimits} />}
      <AiCard ai={boot.ai} quota={quota} />
      {boot.myLimits?.moreUrl && (
        <div className="usage-more" id="more">
          <a className="button primary" href={boot.myLimits.moreUrl} target="_blank" rel="noopener noreferrer">
            {t("Mehr Speicher oder KI?", "More storage or AI?")}
            <ArrowSquareOut size={14} aria-hidden />
          </a>
        </div>
      )}
    </>
  );
}

// "aus Gruppe Flowplan Plus", "25 GB aus Gruppe Flowplan Plus + 50 GB aus
// Gruppe Flowplan +50 GB", "für dich festgelegt" or null (the default).
function sourceText(limits: MyLimits, field: "storageMb" | "workspaces" | "uploadMb", t: T) {
  const source = limits.sources?.[field];
  const groupName = (group: string | null) => (group && limits.groupNames?.[group]) || t("einer deiner Gruppen", "one of your groups");
  const sum = explainStorage(source, t, groupName, LOCALE_TAG);
  if (sum) return sum;
  if (!source || source.from === "default") return null;
  if (source.from === "user") return t("für dich festgelegt", "set for you");
  const name = groupName(source.group);
  return t(`aus Gruppe ${name}`, `from group ${name}`);
}

const bytesText = (bytes: number) => {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024
    ? `${(mb / 1024).toLocaleString(LOCALE_TAG, { maximumFractionDigits: 1 })} GB`
    : `${mb.toLocaleString(LOCALE_TAG, { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`;
};

function UsageBar({ label, text, share, note }: { label: string; text: string; share: number | null; note?: string | null }) {
  const tone = share === null ? "" : share >= 1 ? " full" : share >= 0.8 ? " high" : "";
  return (
    <div className={`usage-bar${tone}`}>
      <div className="usage-bar-text">
        <span>{label}</span>
        <strong>{text}</strong>
      </div>
      {share !== null && <progress max={1000} value={Math.round(share * 1000)} aria-label={label} />}
      {note && <small className="limit-source">{note}</small>}
    </div>
  );
}

function StorageCard({ limits }: { limits: MyLimits }) {
  const t = useT();
  const storage = storageSummary(limits, t, LOCALE_TAG);
  const source = limits.admin ? t("Als Administrator hast du keine Grenzen.", "As an administrator you have no limits.") : sourceText(limits, "storageMb", t) || t("Standard dieser Instanz", "This instance's default");
  const perWorkspace = limits.byWorkspace || [];
  const workspacesSource = sourceText(limits, "workspaces", t);
  return (
    <SettingGroup
      id="storage"
      title={t("Speicher", "Storage")}
      description={
        limits.admin || limits.moreUrl
          ? t("So viel steht dir auf dieser Instanz zur Verfügung.", "This is what you have on this instance.")
          : t("So viel steht dir auf dieser Instanz zur Verfügung. Mehr gibt es bei den Admins.", "This is what you have on this instance. Admins can give you more.")
      }
    >
      <div className="setting-row wide">
        <UsageBar label={t("Deine Dateien und Bilder", "Your files and images")} text={storage.text} share={storage.share} note={source} />
        {storage.level === 100 && <p className="usage-warn">{t("Dein Speicher ist voll: Neue Dateien passen erst wieder, wenn du Platz schaffst.", "Your storage is full: new files only fit once you make room.")}</p>}
      </div>
      {perWorkspace.length > 0 && (
        <SettingRow anchor="per-workspace" label={t("Nach Arbeitsbereich", "By workspace")} description={t("Deine Dateien in den Arbeitsbereichen, in denen du Mitglied bist.", "Your files in the workspaces you are a member of.")} wide>
          <ul className="usage-workspaces">
            {perWorkspace.map((w) => (
              <li key={w.id}>
                <span>{w.name}</span>
                <strong>{bytesText(w.bytes)}</strong>
              </li>
            ))}
          </ul>
        </SettingRow>
      )}
      <SettingRow anchor="upload" label={t("Größte Datei beim Hochladen", "Largest upload")} description={sourceText(limits, "uploadMb", t) ?? undefined}>
        <strong className="setting-value">{storageSizeText(limits.uploadMb, LOCALE_TAG)}</strong>
      </SettingRow>
      <SettingRow anchor="workspaces" label={t("Eigene Arbeitsbereiche", "Own workspaces")} description={workspacesSource ?? undefined}>
        <strong className="setting-value">
          {limits.workspaces ? t(`${limits.ownedWorkspaces} von ${limits.workspaces}`, `${limits.ownedWorkspaces} of ${limits.workspaces}`) : t(`${limits.ownedWorkspaces} · unbegrenzt`, `${limits.ownedWorkspaces} · unlimited`)}
        </strong>
      </SettingRow>
    </SettingGroup>
  );
}

function AiCard({ ai, quota }: { ai: AiStatus | null | undefined; quota: ReturnType<typeof useAiQuota> }) {
  const t = useT();
  const state = aiState(ai, quota);
  if (state === "none") return null;
  const summary = aiSummary(ai, quota, t, LOCALE_TAG);
  const personal = personalPeriod(quota);
  const ceiling = instanceCeiling(quota);
  const periods = quota ? quota.periods.filter((p) => p.level === "person" || p === ceiling) : [];
  const offReason = Object.values(ai?.features || {}).find((f) => f.reason)?.reason;
  return (
    <SettingGroup
      id="ai"
      title={t("KI-Kontingent", "AI quota")}
      description={t(
        "Wie viel KI über den Anbieter der Instanz dir bleibt. Ein eigener KI-Anbieter und die KI auf dem Gerät zählen nicht dazu.",
        "How much AI through the instance's provider you have left. Your own AI provider and on-device AI do not count.",
      )}
    >
      {state === "quota" && quota ? (
        <div className="setting-row wide">
          <QuotaBarList status={quota} periods={periods} />
          {personal &&
            (quota.after ? (
              <p className="muted ai-quota-free">
                {afterLine(quota, t, LOCALE_TAG)!.spent && quota.after.resetAt
                  ? t(
                      `Danach ging es mit ${quota.after.model} weiter – auch das ist aufgebraucht. KI ist aus bis ${resetText({ ...personal, resetAt: Math.min(quota.after.resetAt, personal.resetAt) }, quota.timeZone)}.`,
                      `After that, AI went on with ${quota.after.model} – that is used up as well. AI is off until ${resetText({ ...personal, resetAt: Math.min(quota.after.resetAt, personal.resetAt) }, quota.timeZone)}.`,
                    )
                  : afterLine(quota, t, LOCALE_TAG)!.left
                    ? t(`Danach geht es mit ${quota.after.model} weiter – ${afterLine(quota, t, LOCALE_TAG)!.left}.`, `After that, AI goes on with ${quota.after.model} – ${afterLine(quota, t, LOCALE_TAG)!.left}.`)
                    : t(`Danach geht es mit ${quota.after.model} weiter.`, `After that, AI goes on with ${quota.after.model}.`)}
              </p>
            ) : (
              <p className="muted ai-quota-free">
                {t(`Danach ist KI aus – bis ${resetText(personal, quota.timeZone)}.`, `After that, AI is off – until ${resetText(personal, quota.timeZone)}.`)}
              </p>
            ))}
          {ceiling && (
            <p className="muted ai-quota-free">
              {t("Das Kontingent der ganzen Instanz ist bald erreicht – dann ist KI für alle bis zum Neubeginn aus.", "The whole instance's quota is nearly reached – then AI is off for everyone until it resets.")}
            </p>
          )}
          <p className="muted ai-quota-unit">{quota.unit === "cost" ? t("Geschätzte Kosten aus den Preisen je Modell.", "Estimated cost from the prices per model.") : t("Tokens: Eingabe und Ausgabe zusammen.", "Tokens: input and output together.")}</p>
        </div>
      ) : (
        <div className="setting-row wide">
          <UsageBar label={t("KI", "AI")} text={summary.text} share={null} />
          <small className="muted">
            {state === "off"
              ? offReason
                ? t(AI_REASON_TEXT[offReason][0], AI_REASON_TEXT[offReason][1])
                : t("KI ist für dich ausgeschaltet.", "AI is switched off for you.")
              : state === "own"
                ? t("Du nutzt deinen eigenen KI-Anbieter – dafür gilt kein Kontingent.", "You use your own AI provider – no quota applies to it.")
                : t("Für dich gilt kein persönliches Limit.", "No personal limit applies to you.")}
          </small>
        </div>
      )}
      {ai?.provider && (
        <SettingRow
          anchor="models"
          label={t("Deine KI-Modelle", "Your AI models")}
          description={
            ai.provider.source === "user"
              ? t("Von deinem eigenen Anbieter.", "From your own provider.")
              : ai.provider.assigned
                ? t("Für dich festgelegt von der Administration.", "Set for you by the administration.")
                : t("Das Modell der Instanz.", "The instance's model.")
          }
        >
          <span className="usage-models">
            <code>{ai.provider.model}</code>
            {quota?.after && state === "quota" && <small className="muted">{afterLine(quota, t, LOCALE_TAG)!.text}</small>}
          </span>
        </SettingRow>
      )}
      <SettingRow label={t("KI-Einstellungen", "AI settings")} description={t("Funktionen, eigener Anbieter und worauf die KI zugreifen darf.", "Features, own provider and what the AI may access.")}>
        <a className="button" href={settingsHash({ area: "settings", section: "ai" })}>
          {t("Öffnen", "Open")}
        </a>
      </SettingRow>
    </SettingGroup>
  );
}

// The short line in Konto & Sicherheit and KI: where storage and the AI
// quota went (no bars of their own there).
export function UsageMovedNote({ summary }: { summary?: string }) {
  const t = useT();
  return (
    <p className="usage-moved">
      <Gauge size={16} aria-hidden />
      <span>
        {summary ? `${summary} · ` : ""}
        {t("Speicher, Upload-Grenze und KI-Kontingent findest du unter", "Storage, upload limit and AI quota are under")}{" "}
        <a href={USAGE_LINK}>
          {t("Speicher & KI", "Storage & AI")}
          <ArrowRight size={13} aria-hidden />
        </a>
      </span>
    </p>
  );
}
