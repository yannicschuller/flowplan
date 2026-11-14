"use client";
// The introduction's setup path for administrators (components/onboarding.tsx,
// step "Instanz einrichten"): a traffic light per part of the instance
// (lib/admin-setup-status.ts) from the administration's summary
// (GET /api/admin/summary), each with the section where it is set up.
import { useEffect, useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { adminSetupStatus, type Light, type SetupFacts, type SetupItem } from "@/lib/admin-setup-status";
import { settingsHash } from "@/lib/settings-sections";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";

export function AdminSetup({ onOpenSection }: { onOpenSection: (hash: string) => void }) {
  const t = useT();
  const [items, setItems] = useState<SetupItem[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch("/api/admin/summary", { cache: "no-store" });
        const data = (await response.json()) as SetupFacts & { error?: string };
        if (!response.ok) throw new Error(serverMessage(data.error) || String(response.status));
        if (live) setItems(adminSetupStatus(data));
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  const title: Record<SetupItem["id"], string> = {
    https: t("Adresse und HTTPS (APP_URL)", "Address and HTTPS (APP_URL)"),
    mail: t("E-Mail-Versand", "E-mail delivery"),
    backup: t("Sicherung", "Backup"),
    signin: t("Anmeldung (SSO)", "Sign-in (SSO)"),
    ai: t("KI-Anbieter", "AI provider"),
  };
  const reason: Record<SetupItem["reason"], string> = {
    ok: t("Eingerichtet.", "Set up."),
    "https-plain": t(
      "APP_URL ist http auf einem anderen Rechner: Passwörter gehen unverschlüsselt durchs Netz, Passkeys, Apps und Offline gehen nicht. HTTPS über einen Reverse Proxy einrichten.",
      "APP_URL is http on another machine: passwords cross the network unencrypted, passkeys, apps and offline do not work. Set up HTTPS through a reverse proxy.",
    ),
    "https-unset": t(
      "APP_URL ist nicht gesetzt: Links in E-Mails und Einladungen zeigen auf localhost. Die öffentliche Adresse mit https:// eintragen.",
      "APP_URL is not set: links in e-mails and invitations point to localhost. Enter the public address with https://.",
    ),
    "https-local": t("http auf diesem Rechner – gut zum Ausprobieren, für den Betrieb HTTPS einrichten.", "http on this machine – fine for trying out, set up HTTPS for real use."),
    "mail-off": t(
      "Kein SMTP: Einladungen, Passwort-Zurücksetzen und Zusammenfassungen gehen nicht per E-Mail.",
      "No SMTP: invitations, password resets and summaries are not sent by e-mail.",
    ),
    "mail-failed": t("Eingerichtet, aber Nachrichten sind fehlgeschlagen – bitte prüfen.", "Set up, but messages failed – please check."),
    "backup-off": t("Keine geplante Sicherung: Richte eine tägliche Sicherung ein, bevor echte Daten hineinkommen.", "No scheduled backup: set up a daily backup before real data comes in."),
    "backup-failed": t("Die letzte Sicherung ist fehlgeschlagen.", "The last backup failed."),
    "backup-pending": t("Eingeschaltet, die erste Sicherung steht noch aus.", "Switched on, the first backup is still to come."),
    "signin-local": t("Konten mit E-Mail und Passwort. Optional: Single Sign-on (OpenID Connect) oder LDAP.", "Accounts with e-mail and password. Optional: single sign-on (OpenID Connect) or LDAP."),
    "signin-ldap-error": t("Der LDAP-Abgleich ist fehlgeschlagen.", "The LDAP sync failed."),
    "ai-off": t("Aus. Optional: ein Anbieter wie Ollama oder OpenAI für Schreibhilfe, Fragen und Zusammenfassungen.", "Off. Optional: a provider such as Ollama or OpenAI for writing help, questions and summaries."),
    "ai-no-provider": t("Eingeschaltet, aber kein Anbieter gewählt.", "Switched on, but no provider chosen."),
  };
  const lightLabel: Record<Light, string> = { green: t("Grün", "Green"), yellow: t("Gelb", "Yellow"), red: t("Rot", "Red") };
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!items) return <p className="muted" role="status">{t("Status wird geladen …", "Loading status …")}</p>;
  return (
    <ul className="onboarding-setup">
      {items.map((item) => {
        const hash = settingsHash({ area: "admin", section: item.section, anchor: item.id === "backup" ? "backup" : null });
        return (
          <li key={item.id} data-light={item.light}>
            <span className="onboarding-light" aria-hidden />
            <span className="onboarding-setup-text">
              <strong>
                {title[item.id]} <span className="sr-only">{`(${lightLabel[item.light]})`}</span>
              </strong>
              <small>{reason[item.reason]}</small>
            </span>
            <a
              className="button compact"
              href={hash}
              aria-label={`${title[item.id]}: ${item.light === "green" ? t("Ansehen", "View||action") : t("Einrichten", "Set up||action")}`}
              onClick={(e) => {
                e.preventDefault();
                onOpenSection(hash);
              }}
            >
              {item.light === "green" ? t("Ansehen", "View||action") : t("Einrichten", "Set up||action")}
              <ArrowSquareOut size={14} aria-hidden />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
