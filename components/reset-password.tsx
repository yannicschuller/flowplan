"use client";
import { serverMessage } from "@/lib/i18n-errors";
// The page behind a reset link: set a new password, then sign in.
import { useState, type FormEvent } from "react";
import { BrandMark } from "./brand-mark";
import { AuthLayout } from "./auth-layout";
import { useT } from "./i18n";
import { AppProfilesLink } from "./app-profiles-link";

// `confirmed`: the confirmation link of a new account, opened in another
// browser than the one that signed up – its owner chooses the password now.
export default function ResetPassword({ token, confirmed = false }: { token: string; confirmed?: boolean }) {
  const t = useT();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [done, setDone] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    if (password !== String(form.get("repeat") || "")) {
      setMessage(t("Die beiden Passwörter sind nicht gleich.", "The two passwords differ."));
      return;
    }
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/auth/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (response.ok) setDone(true);
    else setMessage(serverMessage(data.error) || response.statusText);
  };
  return (
    <AuthLayout>
      <div className="login-brand">
        <BrandMark size={32} />
        flowplan
      </div>
      <section className="login-card">
        <h1>
          {done
            ? confirmed
              ? t("Passwort festgelegt.", "Password set.")
              : t("Passwort geändert.", "Password changed.")
            : confirmed
              ? t("Adresse bestätigt – Passwort festlegen", "Address confirmed – set your password")
              : t("Neues Passwort", "New password")}
        </h1>
        {confirmed && !done && token && (
          <p>
            {t(
              "Der Link wurde nicht in dem Browser geöffnet, in dem das Konto angelegt wurde. Damit nur du dich anmelden kannst, legst du das Passwort jetzt fest – ein vorher gewähltes gilt nicht mehr. Danach erscheinen auch Arbeitsbereiche, zu denen du eingeladen wurdest.",
              "The link was not opened in the browser where the account was created. So that only you can sign in, set the password now – one chosen before no longer applies. Afterwards, workspaces you were invited to appear as well.",
            )}
          </p>
        )}
        {done ? (
          <>
            <p>{t("Melde dich jetzt mit dem neuen Passwort an.", "Sign in with the new password now.")}</p>
            <a className="button primary wide" href="/login">
              {t("Zur Anmeldung", "Go to sign-in")}
            </a>
          </>
        ) : !token ? (
          <p>{t("Dieser Link ist unvollständig.", "This link is incomplete.")}</p>
        ) : (
          <form method="post" action="/api/auth/no-script" className="login-form" onSubmit={submit}>
            {message && (
              <div role="alert" className="error">
                {message}
              </div>
            )}
            <label>
              {t("Neues Passwort", "New password")}
              <input name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={200} />
              <small>{t("Mindestens 10 Zeichen.", "At least 10 characters.")}</small>
            </label>
            <label>
              {t("Passwort wiederholen", "Repeat password")}
              <input name="repeat" type="password" autoComplete="new-password" required minLength={10} maxLength={200} />
            </label>
            <button className="button primary wide" disabled={busy}>
              {t("Passwort festlegen", "Set password")}
            </button>
          </form>
        )}
        <AppProfilesLink />
      </section>
    </AuthLayout>
  );
}
