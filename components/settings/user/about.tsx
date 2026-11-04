"use client";
// Settings → Über Flowplan: the running version, the licence (AGPL-3.0) with
// the source of what runs here, links to website, docs, community and bug
// reports, and one quiet way to support Flowplan. What may be shown is
// decided on the server (lib/about.ts): FLOWPLAN_SOURCE_URL, and no sponsor
// link with FLOWPLAN_HIDE_SPONSOR or inside the mobile apps.
import { useSyncExternalStore, type ReactNode } from "react";
import { ArrowCircleUp, ArrowSquareOut, Heart } from "@phosphor-icons/react";
import { DISCORD_URL, ISSUES_URL, LICENSE_URL, SPONSOR_URL, hideSponsorInPage } from "@/lib/about";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useLocale, useT } from "../../i18n";
import { SettingGroup, SettingRow, StatusBadge } from "../../settings-ui";
import { useUserSettings } from "../user-context";

const noSubscribe = () => () => {};

function External({ href, children, label }: { href: string; children: ReactNode; label?: string }) {
  const t = useT();
  return (
    <a className="about-link" href={href} target="_blank" rel="noopener" aria-label={label ? `${label} (${t("öffnet in neuem Tab", "opens in a new tab")})` : undefined}>
      <span>{children}</span>
      <ArrowSquareOut size={14} aria-hidden />
    </a>
  );
}

// "https://github.com/a/b" → "github.com/a/b"
const shortUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

export default function AboutSection() {
  const t = useT();
  const locale = useLocale();
  const { boot } = useUserSettings();
  const about = boot.instance?.about;
  // The mobile apps' bridge, for an app whose user agent the server missed.
  const inApp = useSyncExternalStore(noSubscribe, () => hideSponsorInPage(), () => false);
  const docsUrl = `https://docs.flowplan.org/${locale === "de" ? "de" : "en"}`;
  const sponsor = !!about?.sponsor && !inApp;
  const source = about?.sourceUrl || "https://github.com/yannicschuller/flowplan";
  const channel = about?.channel === "beta" ? t("Beta", "Beta") : about?.channel === "release" ? t("Release", "Release") : "";
  return (
    <>
      <SettingGroup id="version" title={t("Version", "Version")}>
        <SettingRow
          label={t("Laufende Version", "Running version")}
          description={about?.builtAt ? t(`Gebaut am ${new Date(about.builtAt).toLocaleString(LOCALE_TAG)}`, `Built on ${new Date(about.builtAt).toLocaleString(LOCALE_TAG)}`) : undefined}
        >
          <span className="about-version">
            <strong>{about?.version ? `Flowplan ${about.version}` : t("Version unbekannt", "Version unknown")}</strong>
            {channel && (
              <StatusBadge tone={about?.channel === "beta" ? "warn" : "ok"} title={about?.channel === "beta" ? t("Vorabversion (Docker-Tag :beta)", "Pre-release (Docker tag :beta)") : t("Veröffentlichte Version", "Published release")}>
                {channel}
              </StatusBadge>
            )}
            {about?.commit &&
              (about.commitUrl ? (
                <a href={about.commitUrl} target="_blank" rel="noopener" title={t(`Commit ${about.commit} auf GitHub ansehen`, `View commit ${about.commit} on GitHub`)}>
                  <code>{about.commit.slice(0, 7)}</code>
                </a>
              ) : (
                <code title={t(`Commit ${about.commit}`, `Commit ${about.commit}`)}>{about.commit.slice(0, 7)}</code>
              ))}
          </span>
        </SettingRow>
        {about?.update && (
          <div className="callout about-update" role="status">
            <ArrowCircleUp size={18} aria-hidden />
            <span>{t(`Flowplan ${about.update.latest} ist verfügbar.`, `Flowplan ${about.update.latest} is available.`)}</span>
            <a href="#admin/general">{t("Zur Instanz", "Go to the instance")}</a>
          </div>
        )}
      </SettingGroup>
      <SettingGroup id="licence" title={t("Lizenz & Quellcode", "Licence & source code")}>
        <SettingRow
          // A non-breaking hyphen: "AGPL-3.0" stays on one line on phones.
          label={t("Flowplan ist freie Software unter der GNU AGPL‑3.0", "Flowplan is free software under the GNU AGPL‑3.0")}
          description={t(
            "Du darfst Flowplan nutzen, verändern und weitergeben. Wer eine veränderte Fassung für andere betreibt, stellt ihnen deren Quellcode bereit.",
            "You may use, change and share Flowplan. Whoever runs a changed version for others offers them its source code.",
          )}
        >
          <External href={LICENSE_URL} label={t("Lizenztext", "Licence text")}>
            {t("Lizenztext", "Licence text")}
          </External>
        </SettingRow>
        <SettingRow
          anchor="source"
          label={t("Quellcode", "Source code")}
          description={about?.customSource ? t("Der Quellcode des Codes, der auf dieser Instanz läuft.", "The source of the code running on this instance.") : t("Der Quellcode von Flowplan auf GitHub.", "Flowplan’s source code on GitHub.")}
        >
          <External href={source} label={t("Quellcode", "Source code")}>
            <span className="about-url">{shortUrl(source)}</span>
          </External>
        </SettingRow>
        <p className="about-copyright">{t("© Yannic Schuller und Mitwirkende", "© Yannic Schuller and contributors")}</p>
      </SettingGroup>
      <SettingGroup id="links" title={t("Links", "Links")}>
        <SettingRow label={t("Website", "Website")} description={t("Was Flowplan ist und kann.", "What Flowplan is and does.")}>
          <External href="https://flowplan.org" label={t("Website", "Website")}>
            flowplan.org
          </External>
        </SettingRow>
        <SettingRow label={t("Dokumentation", "Documentation")} description={t("Anleitungen für jede Funktion.", "Guides for every feature.")}>
          <External href={docsUrl} label={t("Dokumentation", "Documentation")}>
            docs.flowplan.org
          </External>
        </SettingRow>
        <SettingRow label={t("Community", "Community")} description={t("Fragen stellen und Ideen teilen auf Discord.", "Ask questions and share ideas on Discord.")}>
          <External href={DISCORD_URL} label="Discord">
            Discord
          </External>
        </SettingRow>
        <SettingRow
          anchor="bug"
          label={t("Fehler melden", "Report a bug")}
          description={t("Auf GitHub – nenn am besten die Version von oben.", "On GitHub – ideally with the version above.")}
        >
          <External href={ISSUES_URL} label={t("Fehler melden", "Report a bug")}>
            {t("GitHub Issues", "GitHub issues")}
          </External>
        </SettingRow>
      </SettingGroup>
      {sponsor && (
        <SettingGroup id="support" title={t("Flowplan unterstützen ♥", "Support Flowplan ♥")}>
          <SettingRow
            label={t("Danke, dass du Flowplan nutzt!", "Thank you for using Flowplan!")}
            description={t(
              "Flowplan entsteht in freier Zeit und bleibt frei. Wenn es dir hilft, freut sich die Weiterentwicklung über einen Beitrag.",
              "Flowplan is made in spare time and stays free. If it helps you, a contribution keeps its development going.",
            )}
          >
            <a className="button about-sponsor" href={SPONSOR_URL} target="_blank" rel="noopener">
              <Heart size={16} weight="fill" aria-hidden />
              {t("GitHub Sponsors", "GitHub Sponsors")}
            </a>
          </SettingRow>
        </SettingGroup>
      )}
    </>
  );
}
