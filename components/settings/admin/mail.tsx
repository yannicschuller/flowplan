"use client";
// Administration → E-Mail: the SMTP state, its queue and a test e-mail.
import { useState } from "react";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";

export default function MailSection() {
  const t = useT();
  const { data, load, onError } = useAdminData();
  const [to, setTo] = useState(""),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState("");
  if (!data) return <AdminLoading />;
  const mail = data.mail;
  return (
    <section className="settings-section">
      <h2>{t("E-Mail-Versand", "Sending e-mail")}</h2>
      {mail.configured ? (
        <p>
          SMTP: <code>{mail.host}</code> {t("als", "as")}{" "}<code>{mail.from}</code> ·{" "}
          {mail.pending} {t("in der Warteschlange ·", "queued ·")}{" "}{mail.sentWeek} {t("gesendet (7 Tage)", "sent (7 days)")}
          {mail.failed > 0 && t(` · ${mail.failed} aufgegeben`, ` · ${mail.failed} given up`)}
        </p>
      ) : (
        <p className="muted">
          {t("Nicht eingerichtet. Mit", "Not set up. With")}{" "}<code>SMTP_HOST</code>, <code>SMTP_PORT</code>,{" "}
          <code>SMTP_USER</code>, <code>SMTP_PASSWORD</code> {t("und", "and")}{" "}<code>SMTP_FROM</code>{" "}
          {t("verschickt Flowplan Einladungen und Zusammenfassungen ungelesener Benachrichtigungen.", "Flowplan sends invitations and digests of unread notifications.")}
        </p>
      )}
      {mail.lastError && <p className="error">{t("Letzter Fehler:", "Last error:")}{" "}{mail.lastError}</p>}
      {mail.configured && (
        <form
          className="integration-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setNote("");
            try {
              await api("/api/admin/mail-test", { to });
              setNote(t(`Test-E-Mail an ${to} gesendet.`, `Test email sent to ${to}.`));
              void load();
            } catch (err) {
              onError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <input type="email" required value={to} onChange={(e) => setTo(e.target.value)} placeholder={t("E-Mail-Adresse", "E-mail address")} aria-label={t("Empfänger der Test-E-Mail", "Test email recipient")} />
          <button className="button" disabled={busy}>
            {t("Test-E-Mail senden", "Send test email")}
          </button>
        </form>
      )}
      {note && <p role="status">{note}</p>}
    </section>
  );
}
