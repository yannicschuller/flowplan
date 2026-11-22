"use client";
// The notice after signing in to an account marked for deletion because its
// address is unconfirmed (#436, lib/unconfirmed-deletion.ts): the day, and
// "Bestätigungslink erneut senden". Signing in does not keep the account –
// only confirming the address does –, so it stays until then.
import { useState } from "react";
import { Warning } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { api } from "./ui";
import { useT } from "./i18n";

export function UnconfirmedDeletionNotice({ due }: { due: number }) {
  const t = useT();
  const [state, setState] = useState<{ busy: boolean; note: string; error: boolean }>({ busy: false, note: "", error: false });
  const date = new Date(due).toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "long", year: "numeric" });
  return (
    <div className="unconfirmed-deletion-banner" role="alert">
      <Warning size={18} weight="fill" aria-hidden />
      <span>
        <strong>{t(`Dein Konto wird am ${date} gelöscht – bestätige jetzt deine Adresse.`, `Your account will be deleted on ${date} – confirm your address now.`)}</strong>{" "}
        {t(
          "Öffne den Link aus der E-Mail, am besten in diesem Browser. Anmelden allein verhindert die Löschung nicht.",
          "Open the link from the e-mail, ideally in this browser. Signing in alone does not stop the deletion.",
        )}
        {state.note && (
          <small className={state.error ? "error" : undefined} role="status">
            {state.note}
          </small>
        )}
      </span>
      <button
        type="button"
        className="button primary"
        disabled={state.busy}
        onClick={async () => {
          setState({ busy: true, note: "", error: false });
          try {
            const result = await api<{ email: string }>("/api/command", { action: "account.keepLink" });
            setState({ busy: false, note: t(`Ein neuer Link ist an ${result.email} unterwegs.`, `A new link is on its way to ${result.email}.`), error: false });
          } catch (e) {
            setState({ busy: false, note: (e as Error).message, error: true });
          }
        }}
      >
        {t("Bestätigungslink erneut senden", "Resend confirmation link")}
      </button>
    </div>
  );
}
