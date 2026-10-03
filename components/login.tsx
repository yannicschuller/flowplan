"use client";
import { serverMessage } from "@/lib/i18n-errors";
// Sign-in page: e-mail and password, passkeys, single sign-on (OIDC) – as
// far as the instance offers them. Also creating an account (the first
// account sets the instance up) and asking for a password reset link.
import { BrandMark } from "./brand-mark";
import { loginReturnPath } from "@/lib/page-location";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Fingerprint, ShieldCheck, SpinnerGap } from "@phosphor-icons/react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { LanguageSwitch, useT } from "./i18n";
import type { LoginOptions } from "@/lib/local-auth";

type Mode = "signin" | "register" | "forgot";
type Props = Partial<LoginOptions> & {
  error?: string;
  instanceName?: string;
  mode?: Mode;
};

async function post(path: string, body?: unknown) {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(serverMessage((data as { error?: string }).error) || response.statusText);
  return data;
}

export default function Login({
  demo = false,
  configured = false,
  localLogin = false,
  signupOpen = false,
  firstAccount = false,
  mail = false,
  error,
  instanceName = "",
  mode: initialMode,
}: Props) {
  const t = useT();
  const [mode, setMode] = useState<Mode>(initialMode || (firstAccount ? "register" : "signin"));
  const [busy, setBusy] = useState(""),
    [message, setMessage] = useState(error || ""),
    [notice, setNotice] = useState("");
  const [loginUrl, setLoginUrl] = useState("/api/auth/login");
  const [passkeys, setPasskeys] = useState(false);
  useEffect(() => {
    const update = () =>
      setLoginUrl(`/api/auth/login?returnTo=${encodeURIComponent(loginReturnPath(`/${location.hash}`))}`);
    update();
    setPasskeys(browserSupportsWebAuthn());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  // Signed in: back to where the visitor wanted to go.
  const done = () => {
    history.replaceState(null, "", loginReturnPath(`/${location.hash}`));
    location.reload();
  };
  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setMessage("");
    try {
      await action();
    } catch (e) {
      setMessage((e as Error).message);
      setBusy("");
    }
  };
  const field = (form: FormData, name: string) => String(form.get(name) || "");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (mode === "signin")
      void run("password", async () => {
        await post("password", { email: field(form, "email"), password: field(form, "password") });
        done();
      });
    else if (mode === "register")
      void run("register", async () => {
        await post("register", { name: field(form, "name"), email: field(form, "email"), password: field(form, "password") });
        done();
      });
    else
      void run("forgot", async () => {
        await post("reset-request", { email: field(form, "email") });
        setBusy("");
        setNotice(
          t(
            "Wenn es ein Konto mit dieser Adresse gibt, ist ein Link zum Zurücksetzen unterwegs.",
            "If there is an account with this address, a reset link is on its way.",
          ),
        );
      });
  };
  const passkey = () =>
    run("passkey", async () => {
      const options = await post("passkey-options");
      let response;
      try {
        response = await startAuthentication({ optionsJSON: options });
      } catch {
        throw new Error(t("Anmeldung mit Passkey abgebrochen.", "Passkey sign-in was cancelled."));
      }
      await post("passkey", response);
      done();
    });
  const devWorkspace = () =>
    run("demo", async () => {
      await post("demo");
      done();
    });
  const switchTo = (next: Mode) => {
    setMode(next);
    setMessage("");
    setNotice("");
  };
  const title =
    mode === "register"
      ? firstAccount
        ? [t("Willkommen bei", "Welcome to"), t("deinem Flowplan.", "your Flowplan.")]
        : [t("Konto", "Create your"), t("erstellen.", "account.")]
      : mode === "forgot"
        ? [t("Passwort", "Forgot your"), t("vergessen?", "password?")]
        : [t("Raum für deine", "Room for your"), t("nächste große Idee.", "next big idea.")];
  return (
    <main className="login">
      <div className="login-brand">
        <BrandMark size={32} />
        flowplan
        {instanceName && <span className="muted"> · {instanceName}</span>}
      </div>
      <section className="login-card">
        <div className="login-mark">
          <BrandMark size={48} />
        </div>
        <h1>
          {title[0]}
          <br />
          {title[1]}
        </h1>
        {mode === "register" && firstAccount ? (
          <p>
            {t(
              "Lege das erste Konto an. Es verwaltet die Instanz und kann weitere Personen einladen.",
              "Create the first account. It administers the instance and can invite others.",
            )}
          </p>
        ) : mode === "forgot" ? (
          <p>{t("Wir schicken dir einen Link, mit dem du ein neues Passwort festlegst.", "We send you a link to set a new password.")}</p>
        ) : (
          <p>
            {t("Deine Notizen, Projekte und dein Team.", "Your notes, projects and team.")}
            <br />
            {t("Alles an einem Ort.", "All in one place.")}
          </p>
        )}
        {message && (
          <div role="alert" className="error">
            {message}
          </div>
        )}
        {notice && (
          <div role="status" className="login-notice">
            {notice}
          </div>
        )}
        {localLogin && (
          <form className="login-form" onSubmit={submit}>
            {mode === "register" && (
              <label>
                {t("Name", "Name")}
                <input name="name" autoComplete="name" required maxLength={80} />
              </label>
            )}
            <label>
              {t("E-Mail-Adresse", "E-mail address")}
              <input
                name="email"
                type="email"
                autoComplete={mode === "signin" ? "username webauthn" : "email"}
                required
                maxLength={200}
              />
            </label>
            {mode !== "forgot" && (
              <label>
                {t("Passwort", "Password")}
                <input
                  name="password"
                  type="password"
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  required
                  minLength={mode === "register" ? 10 : undefined}
                  maxLength={200}
                />
                {mode === "register" && <small>{t("Mindestens 10 Zeichen.", "At least 10 characters.")}</small>}
              </label>
            )}
            <button className="button primary wide" disabled={!!busy}>
              {busy && busy !== "passkey" && busy !== "demo" ? <SpinnerGap className="spin" /> : null}
              {mode === "register"
                ? t("Konto erstellen", "Create account")
                : mode === "forgot"
                  ? t("Link senden", "Send link")
                  : t("Anmelden", "Sign in")}
            </button>
            {mode === "signin" && mail && (
              <button type="button" className="text-button login-link" onClick={() => switchTo("forgot")}>
                {t("Passwort vergessen?", "Forgot password?")}
              </button>
            )}
          </form>
        )}
        {localLogin && mode === "signin" && passkeys && (
          <button className="button wide" onClick={passkey} disabled={!!busy}>
            {busy === "passkey" ? <SpinnerGap className="spin" /> : <Fingerprint size={19} />}
            {t("Mit Passkey anmelden", "Sign in with a passkey")}
          </button>
        )}
        {configured && mode === "signin" && (
          <>
            {localLogin && <div className="login-or">{t("oder", "or")}</div>}
            <a className={`button wide${localLogin ? "" : " primary"}`} href={loginUrl}>
              <ShieldCheck size={19} />
              {t("Mit SSO anmelden", "Sign in with SSO")}
              <ArrowRight size={18} />
            </a>
          </>
        )}
        {!configured && !localLogin && (
          <div className="callout">
            {t(
              "Die Anmeldung wird über deinen OIDC-Anbieter eingerichtet. Wie das geht, steht in der Dokumentation unter „Anmeldung mit OIDC“.",
              "Sign-in is set up with your OIDC provider. The documentation explains how under “Sign-in with OIDC”.",
            )}{" "}
            <a href="/docs/anmeldung-oidc">/docs/anmeldung-oidc</a>
          </div>
        )}
        {demo && mode === "signin" && (
          <button className="button wide" onClick={devWorkspace} disabled={!!busy}>
            {busy === "demo" ? <SpinnerGap className="spin" /> : <ArrowRight />}
            {t("Lokalen Arbeitsbereich öffnen", "Open local workspace")}
          </button>
        )}
        {localLogin && (
          <p className="login-switch">
            {mode === "signin" ? (
              signupOpen && (
                <>
                  {t("Noch kein Konto?", "No account yet?")}{" "}
                  <button type="button" className="text-button" onClick={() => switchTo("register")}>
                    {t("Konto erstellen", "Create one")}
                  </button>
                </>
              )
            ) : !firstAccount || mode === "forgot" ? (
              <>
                {t("Schon ein Konto?", "Already have an account?")}{" "}
                <button type="button" className="text-button" onClick={() => switchTo("signin")}>
                  {t("Anmelden", "Sign in")}
                </button>
              </>
            ) : null}
          </p>
        )}
        <small>{t("Dein Wissen. Dein Workflow. Dein Flowplan.", "Your knowledge. Your workflow. Your Flowplan.")}</small>
      </section>
      <footer>
        FLOWPLAN <span>{t("Ein Zuhause für gute Zusammenarbeit.", "A home for good collaboration.")}</span>
        <LanguageSwitch className="language-switch" />
      </footer>
    </main>
  );
}
