"use client";
// The page after a first SSO sign-in whose verified address belongs to an
// existing account (#101): "An account with this e-mail already exists –
// connect it?". The person proves that account – its password (and a code
// if the authenticator app is on) or its passkey – and is then signed in
// with both connected. "Create a separate account instead" only where the
// instance allows new SSO accounts.
import { serverMessage } from "@/lib/i18n-errors";
import { useEffect, useState, type FormEvent } from "react";
import { Fingerprint, LinkSimple, SpinnerGap } from "@phosphor-icons/react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import type { PendingLinkInfo } from "@/lib/oidc-link";
import { BrandMark } from "./brand-mark";
import { AuthLayout } from "./auth-layout";
import { useT } from "./i18n";

async function post(path: string, body?: unknown) {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string; twoFactor?: boolean; returnTo?: string };
  if (!response.ok) throw new Error(serverMessage(data.error) || response.statusText);
  return data;
}

export default function LinkAccount({ info, instanceName = "" }: { info: PendingLinkInfo | null; instanceName?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [code, setCode] = useState(!!info?.secondFactor),
    [passkeys, setPasskeys] = useState(false);
  useEffect(() => setPasskeys(!!info?.passkey && browserSupportsWebAuthn()), [info]);
  const run = async (key: string, action: () => Promise<{ twoFactor?: boolean; returnTo?: string }>) => {
    setBusy(key);
    setError("");
    try {
      const result = await action();
      if (result.twoFactor) {
        setCode(true);
        setBusy("");
        return;
      }
      window.location.assign(result.returnTo || "/");
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run("form", () => (code ? post("link-code", { code: data.get("code") }) : post("link-password", { password: data.get("password") })));
  };
  const passkey = () =>
    run("passkey", async () => {
      const options = await post("passkey-options");
      let response;
      try {
        response = await startAuthentication({ optionsJSON: options as never });
      } catch {
        throw new Error(t("Der Passkey wurde nicht bestätigt.", "The passkey was not confirmed."));
      }
      return post("link-passkey", response);
    });
  return (
    <AuthLayout instanceName={instanceName}>
      <div className="login-brand">
        <BrandMark size={32} />
        flowplan
        {instanceName && <span className="muted"> · {instanceName}</span>}
      </div>
      <section className="login-card link-account">
        {!info ? (
          <>
            <h1>{t("Anmeldung abgelaufen", "Sign-in expired")}</h1>
            <p>{t("Bitte melde dich noch einmal mit SSO an.", "Please sign in with SSO again.")}</p>
            <a className="button primary wide" href="/login">
              {t("Zur Anmeldung", "Go to sign-in")}
            </a>
          </>
        ) : (
          <>
            <span className="link-account-icon" aria-hidden>
              <LinkSimple size={22} />
            </span>
            <h1>{t("Es gibt schon ein Konto mit dieser E-Mail-Adresse – verbinden?", "An account with this e-mail already exists – connect it?")}</h1>
            <p>
              {t(
                `Dein SSO-Anbieter hat ${info.email} bestätigt. Bestätige, dass das bestehende Flowplan-Konto dir gehört – danach meldest du dich mit SSO und wie bisher an, mit allen deinen Inhalten.`,
                `Your SSO provider confirmed ${info.email}. Confirm that the existing Flowplan account is yours – afterwards you sign in with SSO and as before, with all your content.`,
              )}
            </p>
            <form method="post" action="/api/auth/no-script" className="login-form" onSubmit={submit}>
              {error && (
                <div role="alert" className="error">
                  {error}
                </div>
              )}
              {code ? (
                <label>
                  {t("Code aus der Authenticator-App", "Code from the authenticator app")}
                  <input name="code" autoComplete="one-time-code" inputMode="text" required maxLength={40} autoFocus />
                  <small>{t("Oder einen deiner Wiederherstellungscodes.", "Or one of your recovery codes.")}</small>
                </label>
              ) : (
                info.password && (
                  <label>
                    {info.ldap ? t("Passwort deines Verzeichniskontos", "Password of your directory account") : t("Passwort des bestehenden Kontos", "Password of the existing account")}
                    <input name="password" type="password" autoComplete="current-password" required maxLength={200} autoFocus />
                  </label>
                )
              )}
              {(code || info.password) && (
                <button className="button primary wide" disabled={!!busy}>
                  {busy === "form" && <SpinnerGap className="spin" aria-hidden />} {code ? t("Bestätigen und verbinden", "Confirm and connect") : t("Konto verbinden", "Connect account")}
                </button>
              )}
            </form>
            {!code && passkeys && (
              <button type="button" className="button wide" disabled={!!busy} onClick={() => void passkey()}>
                {busy === "passkey" ? <SpinnerGap className="spin" aria-hidden /> : <Fingerprint size={19} aria-hidden />} {t("Mit Passkey bestätigen", "Confirm with passkey")}
              </button>
            )}
            <div className="link-account-other">
              {info.separate && (
                <button type="button" className="text-button" disabled={!!busy} onClick={() => void run("separate", () => post("link-separate"))}>
                  {t("Stattdessen ein eigenes Konto anlegen", "Create a separate account instead")}
                </button>
              )}
              <button
                type="button"
                className="text-button"
                disabled={!!busy}
                onClick={() =>
                  void post("link-cancel")
                    .catch(() => undefined)
                    .then(() => window.location.assign("/login"))
                }
              >
                {t("Abbrechen", "Cancel")}
              </button>
            </div>
          </>
        )}
      </section>
    </AuthLayout>
  );
}
