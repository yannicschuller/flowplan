"use client";
// The page behind the links of a change of the e-mail address (#405): the
// one to the new address confirms it, the one to the old address cancels
// the pending change. Nothing happens before the button.
import { serverMessage } from "@/lib/server-message";
import { useState } from "react";
import { BrandMark } from "./brand-mark";
import { AuthLayout } from "./auth-layout";
import { useT } from "./i18n";

export default function EmailChangeLink({ token, cancel }: { token: string; cancel: boolean }) {
  const t = useT();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [done, setDone] = useState<{ email?: string; cancelled?: boolean } | null>(null);
  const go = async () => {
    setBusy(true);
    setMessage("");
    const response = await fetch(cancel ? "/api/auth/email-cancel" : "/api/auth/email-confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string; email?: string; cancelled?: boolean };
    setBusy(false);
    if (response.ok) setDone(data);
    else setMessage(serverMessage(data.error) || response.statusText);
  };
  const title = done
    ? cancel
      ? done.cancelled
        ? t("Änderung abgebrochen", "Change cancelled")
        : t("Nichts abzubrechen", "Nothing to cancel")
      : t("Neue Adresse bestätigt", "New address confirmed")
    : cancel
      ? t("Änderung der E-Mail-Adresse abbrechen", "Cancel the e-mail address change")
      : t("Neue E-Mail-Adresse bestätigen", "Confirm your new e-mail address");
  return (
    <AuthLayout>
      <div className="login-brand">
        <BrandMark size={32} />
        flowplan
      </div>
      <section className="login-card">
        <h1>{title}</h1>
        {done ? (
          <>
            <p>
              {cancel
                ? done.cancelled
                  ? t(
                      "Die Adresse deines Kontos bleibt, wie sie war. Warst du das nicht, ändere jetzt dein Passwort.",
                      "Your account keeps its address. If this wasn't you, change your password now.",
                    )
                  : t(
                      "Es wartet keine Änderung mehr – sie wurde schon bestätigt, abgebrochen oder ist abgelaufen. Wurde deine Adresse ohne dich geändert, wende dich an die Administration.",
                      "No change is waiting any more – it was confirmed, cancelled or has expired. If your address was changed without you, contact the administrators.",
                    )
                : t(`Du meldest dich ab jetzt mit ${done.email || ""} an.`, `From now on you sign in with ${done.email || ""}.`)}
            </p>
            <a className="button primary wide" href="/">
              {t("Zu Flowplan", "Go to Flowplan")}
            </a>
          </>
        ) : !token ? (
          <p>{t("Dieser Link ist unvollständig.", "This link is incomplete.")}</p>
        ) : (
          <>
            <p>
              {cancel
                ? t("Die neue Adresse wird dann nicht übernommen; ihr Bestätigungslink gilt nicht mehr.", "The new address is then not taken over; its confirmation link stops working.")
                : t("Danach meldest du dich mit dieser Adresse an, und E-Mails von Flowplan kommen hierher.", "You then sign in with this address, and e-mails from Flowplan come here.")}
            </p>
            {message && (
              <div role="alert" className="error">
                {message}
              </div>
            )}
            <button type="button" className={`button wide ${cancel ? "danger-solid" : "primary"}`} disabled={busy} onClick={() => void go()}>
              {cancel ? t("Änderung abbrechen", "Cancel the change") : t("Adresse bestätigen", "Confirm address")}
            </button>
          </>
        )}
      </section>
    </AuthLayout>
  );
}
