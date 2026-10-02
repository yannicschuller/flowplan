"use client";
// The page behind a reset link: set a new password, then sign in.
import { useState, type FormEvent } from "react";
import { BrandMark } from "./brand-mark";
import { useT } from "./i18n";

export default function ResetPassword({ token }: { token: string }) {
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
    else setMessage(data.error || response.statusText);
  };
  return (
    <main className="login">
      <div className="login-brand">
        <BrandMark size={32} />
        flowplan
      </div>
      <section className="login-card">
        <h1>{done ? t("Passwort geändert.", "Password changed.") : t("Neues Passwort", "New password")}</h1>
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
          <form className="login-form" onSubmit={submit}>
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
      </section>
    </main>
  );
}
