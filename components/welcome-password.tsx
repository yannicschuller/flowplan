"use client";
// The page behind the link of an account an administrator created (#433,
// lib/account-create.ts): choose the first password, then straight into
// Flowplan.
import { useState, type FormEvent } from "react";
import { serverMessage } from "@/lib/server-message";
import { BrandMark } from "./brand-mark";
import { AuthLayout } from "./auth-layout";
import { useT } from "./i18n";
import { AppProfilesLink } from "./app-profiles-link";
import { PasswordInput } from "./password-input";

export default function WelcomePassword({ token, account, instanceName = "" }: { token: string; account: { name: string; email: string } | null; instanceName?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
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
    const response = await fetch("/api/auth/welcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string; twoFactor?: boolean };
    if (response.ok) {
      // Signed in (a second step, should the account have one, on the sign-in page).
      location.assign(data.twoFactor ? "/login" : "/");
      return;
    }
    setBusy(false);
    setMessage(serverMessage(data.error) || response.statusText);
  };
  return (
    <AuthLayout instanceName={instanceName} signedOut>
      <div className="login-brand">
        <BrandMark size={32} />
        flowplan
      </div>
      <section className="login-card">
        {!account || !token ? (
          <>
            <h1>{t("Link abgelaufen", "Link expired")}</h1>
            <p>
              {t(
                "Dieser Link ist abgelaufen, wurde schon benutzt oder ist unvollständig. Bitte die Person, die dein Konto angelegt hat, um einen neuen Link. Hast du dein Passwort schon festgelegt, melde dich einfach an.",
                "This link has expired, was used already or is incomplete. Ask the person who created your account for a new link. If you have set your password already, just sign in.",
              )}
            </p>
            <a className="button primary wide" href="/login">
              {t("Zur Anmeldung", "Go to sign-in")}
            </a>
          </>
        ) : (
          <>
            <h1>{t("Willkommen – Passwort festlegen", "Welcome – set your password")}</h1>
            <p>
              {t(
                `Für dich wurde ein Konto angelegt: ${account.name} (${account.email}). Leg jetzt dein Passwort fest – danach bist du direkt angemeldet.`,
                `An account was created for you: ${account.name} (${account.email}). Set your password now – you are signed in right afterwards.`,
              )}
            </p>
            <form method="post" action="/api/auth/no-script" className="login-form" onSubmit={submit}>
              {message && (
                <div role="alert" className="error">
                  {message}
                </div>
              )}
              {/* For password managers: the account the password belongs to. */}
              <input type="email" name="email" autoComplete="username" value={account.email} readOnly hidden />
              <label>
                {t("Passwort", "Password")}
                <PasswordInput name="password" autoComplete="new-password" required minLength={10} maxLength={200} />
                <small>{t("Mindestens 10 Zeichen.", "At least 10 characters.")}</small>
              </label>
              <label>
                {t("Passwort wiederholen", "Repeat password")}
                <PasswordInput name="repeat" autoComplete="new-password" required minLength={10} maxLength={200} />
              </label>
              <button className="button primary wide" disabled={busy}>
                {t("Passwort festlegen und anmelden", "Set password and sign in")}
              </button>
            </form>
          </>
        )}
        <AppProfilesLink />
      </section>
    </AuthLayout>
  );
}
