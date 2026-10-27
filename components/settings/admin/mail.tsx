"use client";
// Administration → E-Mail: the SMTP state, its queue and a test e-mail.
import { useState } from "react";
import { PaperPlaneTilt } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { SaveState, SettingGroup, SettingRow, StatusBadge, useSaveState } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, FixLink, useDocs, type StatusItem } from "./parts";

export default function MailSection() {
  const t = useT();
  const docs = useDocs();
  const { data, load } = useAdminData();
  const [to, setTo] = useState("");
  const [status, run] = useSaveState();
  const [note, setNote] = useState("");
  if (!data) return <AdminLoading />;
  const mail = data.mail;
  const guide = docs("configuration", "e-mail-smtp");
  const items: StatusItem[] = [
    mail.configured
      ? { tone: "ok", label: t("SMTP eingerichtet", "SMTP set up") }
      : {
          tone: "warn",
          label: t("SMTP nicht eingerichtet", "SMTP not set up"),
        },
  ];
  if (mail.configured && mail.failed)
    items.push({
      tone: "error",
      label: t(`${mail.failed} aufgegeben`, `${mail.failed} given up`),
    });
  if (mail.configured && mail.pending)
    items.push({
      tone: "info",
      label: t(`${mail.pending} in der Warteschlange`, `${mail.pending} queued`),
    });
  return (
    <>
      <AdminStatus items={items} action={!mail.configured ? <FixLink href={guide}>{t("So richtest du es ein", "How to set it up")}</FixLink> : undefined}>
        {mail.configured
          ? t(`${mail.sentWeek} E-Mails in 7 Tagen gesendet.`, `${mail.sentWeek} e-mails sent in 7 days.`)
          : t("Ohne SMTP verschickt Flowplan keine E-Mails – Einladungen gehen nur per Link.", "Without SMTP Flowplan sends no e-mail – invitations only go by link.")}
      </AdminStatus>
      <SettingGroup
        id="smtp"
        title={t("E-Mail-Versand", "Sending e-mail")}
        description={t(
          "Einladungen, Bestätigungen, Passwort-Links und Zusammenfassungen ungelesener Benachrichtigungen.",
          "Invitations, confirmations, password links and digests of unread notifications.",
        )}
      >
        {mail.configured ? (
          <>
            <SettingRow label={t("Server", "Server")} description={t("Aus SMTP_HOST und SMTP_PORT.", "From SMTP_HOST and SMTP_PORT.")}>
              <code className="admin-break">{mail.host}</code>
            </SettingRow>
            <SettingRow label={t("Absender", "Sender")} description={t("Aus SMTP_FROM.", "From SMTP_FROM.")}>
              <code className="admin-break">{mail.from}</code>
            </SettingRow>
            <SettingRow
              label={t("Warteschlange", "Queue")}
              description={t(
                `${mail.pending} wartend · ${mail.sentWeek} gesendet (7 Tage) · ${mail.failed} aufgegeben`,
                `${mail.pending} waiting · ${mail.sentWeek} sent (7 days) · ${mail.failed} given up`,
              )}
            >
              <StatusBadge tone={mail.failed ? "error" : "ok"}>{mail.failed ? t("Mit Fehlern", "With errors") : t("In Ordnung", "Fine")}</StatusBadge>
            </SettingRow>
          </>
        ) : (
          <SettingRow
            label={t("Einrichten", "Set up||action")}
            description={
              <>
                {t("In der Umgebung setzen:", "Set in the environment:")} <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASSWORD</code> {t("und", "and")}{" "}
                <code>SMTP_FROM</code>.
              </>
            }
          >
            <FixLink href={guide}>{t("Anleitung", "Guide")}</FixLink>
          </SettingRow>
        )}
        {mail.lastError && (
          <SettingRow label={t("Letzter Fehler", "Last error")} description={mail.lastError}>
            <StatusBadge tone="error">{t("Fehler", "Error")}</StatusBadge>
          </SettingRow>
        )}
      </SettingGroup>
      {mail.configured && (
        <SettingGroup
          id="test"
          title={t("Test-E-Mail", "Test e-mail")}
          description={t("Prüft Server, Zugangsdaten und Absender mit einer echten E-Mail.", "Checks server, credentials and sender with a real e-mail.")}
        >
          <form
            className="setting-row"
            onSubmit={(e) => {
              e.preventDefault();
              setNote("");
              void run(async () => {
                await api("/api/admin/mail-test", { to });
                setNote(t(`Test-E-Mail an ${to} gesendet.`, `Test email sent to ${to}.`));
                void load();
              });
            }}
          >
            <div className="setting-text">
              <label htmlFor="mail-test-to">{t("Empfänger", "Recipient")}</label>
              <small role="status">{note || t("Eine Adresse, die du lesen kannst.", "An address you can read.")}</small>
            </div>
            <div className="setting-control admin-inline-form">
              <input id="mail-test-to" className="control-md" type="email" required value={to} onChange={(e) => setTo(e.target.value)} />
              <button className="button" disabled={status.state === "saving"}>
                <PaperPlaneTilt size={16} aria-hidden /> {t("Test-E-Mail senden", "Send test email")}
              </button>
              {status.state === "error" && <SaveState status={status} />}
            </div>
          </form>
        </SettingGroup>
      )}
    </>
  );
}
