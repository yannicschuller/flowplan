"use client";
import { serverMessage } from "@/lib/i18n-errors";
// Sign-in page: e-mail and password, passkeys, single sign-on (OIDC) – as
// far as the instance offers them. Also creating an account (the first
// account sets the instance up) and asking for a password reset link.
import { BrandMark } from "./brand-mark";
import { loginReturnPath } from "@/lib/page-location";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, ArrowSquareOut, EnvelopeSimple, Fingerprint, ShieldCheck, SpinnerGap } from "@phosphor-icons/react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { LanguageSwitch, useLocale, useT } from "./i18n";
import type { LoginOptions } from "@/lib/local-auth";
import type { LegalLinks } from "@/lib/legal-links";
import { LegalFooter } from "./legal-footer";

// "confirm": registered, waiting for the link from the e-mail.
type Mode = "signin" | "register" | "forgot" | "confirm";
type Props = Partial<LoginOptions> & {
  error?: string;
  // "confirmed": the address was confirmed from another browser.
  notice?: "confirmed";
  instanceName?: string;
  mode?: Mode;
  // Legal notice and privacy policy of the instance (when set).
  legal?: LegalLinks;
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
  remember: rememberAvailable = false,
  error,
  notice: initialNotice,
  instanceName = "",
  mode: initialMode,
  legal,
}: Props) {
  const t = useT();
  const [mode, setMode] = useState<Mode>(initialMode || (firstAccount ? "register" : "signin"));
  const [busy, setBusy] = useState(""),
    [message, setMessage] = useState(error || ""),
    [notice, setNotice] = useState(
      initialNotice === "confirmed" ? t("Deine E-Mail-Adresse ist bestätigt – melde dich jetzt an.", "Your e-mail address is confirmed – sign in now.") : "",
    ),
    [pendingEmail, setPendingEmail] = useState("");
  const [loginUrl, setLoginUrl] = useState("/api/auth/login");
  const [passkeys, setPasskeys] = useState(false);
  // "Stay signed in on this device": for password, passkey and SSO alike.
  const [remember, setRemember] = useState(false);
  const stay = rememberAvailable && remember;
  // The desktop and mobile apps sign in with passkeys and SSO in the system
  // browser (lib/desktop-sign-in.ts): in the app these buttons hand over to
  // it, in the browser ?desktop= carries the app's request through the sign-in.
  const [desktopApp, setDesktopApp] = useState(false);
  const [desktopRequest, setDesktopRequest] = useState("");
  // One line: "Stay signed in" on the left, "Forgot password?" on the right.
  const rememberBox = rememberAvailable && !desktopApp && (
    <label className="login-remember" title={t("Nur auf eigenen Geräten. Die Anmeldung bleibt bestehen, solange du Flowplan nutzt.", "Only on your own devices. You stay signed in while you use Flowplan.")}>
      <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
      {t("Angemeldet bleiben", "Stay signed in")}
    </label>
  );
  useEffect(() => {
    const request = new URLSearchParams(location.search).get("desktop") || "";
    const desktopReturn = /^[A-Za-z0-9_-]{43}$/.test(request) ? `/api/auth/desktop?challenge=${request}` : "";
    setDesktopRequest(desktopReturn);
    setDesktopApp(/Flowplan(Desktop|Mobile)\//.test(navigator.userAgent));
    const update = () =>
      setLoginUrl(`/api/auth/login?returnTo=${encodeURIComponent(desktopReturn || loginReturnPath(`/${location.hash}`))}`);
    update();
    setPasskeys(browserSupportsWebAuthn());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  // Signed in: back to where the visitor wanted to go.
  const done = () => {
    if (desktopRequest) return void location.assign(desktopRequest);
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
        await post("password", { email: field(form, "email"), password: field(form, "password"), remember: stay });
        done();
      });
    else if (mode === "register")
      void run("register", async () => {
        const invite = new URLSearchParams(location.search).get("invite") || undefined;
        const result = await post("register", { name: field(form, "name"), email: field(form, "email"), password: field(form, "password"), invite });
        // The instance sends e-mail: the account waits for the link.
        if (result?.pending) {
          setBusy("");
          setPendingEmail(String(result.email || field(form, "email")));
          setMode("confirm");
          return;
        }
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
      await post("passkey", { ...response, remember: stay });
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
      : mode === "confirm"
        ? [t("Fast", "Almost"), t("geschafft.", "there.")]
        : mode === "forgot"
        ? [t("Passwort", "Forgot your"), t("vergessen?", "password?")]
        : [t("Raum für deine", "Room for your"), t("nächste große Idee.", "next big idea.")];
  return (
    // data-signed-out: the offline service worker (public/sw.js) does not
    // store this page as the app, so an expired session keeps the offline copy.
    <main className="login" data-signed-out="">
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
        ) : mode === "confirm" ? (
          <div className="login-confirm">
            <EnvelopeSimple size={30} aria-hidden />
            <p>
              {t("Wir haben einen Bestätigungslink an", "We sent a confirmation link to")} <strong>{pendingEmail}</strong>{" "}
              {t(
                "geschickt. Öffne ihn, um dein Konto zu bestätigen – danach bist du direkt angemeldet.",
                ". Open it to confirm your account – you are signed in right away.",
              )}
            </p>
            <small className="muted">{t("Nichts angekommen? Schau auch im Spam-Ordner nach.", "Nothing arrived? Also check the spam folder.")}</small>
            <button
              type="button"
              className="button wide"
              disabled={!!busy}
              onClick={() =>
                void run("resend", async () => {
                  await post("verify-resend", { email: pendingEmail });
                  setBusy("");
                  setNotice(t("Der Link ist erneut unterwegs.", "The link is on its way again."));
                })
              }
            >
              {busy === "resend" ? <SpinnerGap className="spin" /> : <EnvelopeSimple size={18} />}
              {t("Link erneut senden", "Send the link again")}
            </button>
          </div>
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
        {desktopRequest && !notice && (
          <div role="status" className="login-notice">
            {t("Melde dich an, um die Flowplan-App mit deinem Konto zu verbinden.", "Sign in to connect the Flowplan app to your account.")}
          </div>
        )}
        {notice && (
          <div role="status" className="login-notice">
            {notice}
          </div>
        )}
        {localLogin && mode !== "confirm" && (
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
            {mode === "signin" && (rememberBox || mail) && (
              <div className="login-options">
                {rememberBox}
                {mail && (
                  <button type="button" className="text-button login-forgot" onClick={() => switchTo("forgot")}>
                    {t("Passwort vergessen?", "Forgot password?")}
                  </button>
                )}
              </div>
            )}
            <button className="button primary wide" disabled={!!busy}>
              {busy && busy !== "passkey" && busy !== "demo" ? <SpinnerGap className="spin" /> : null}
              {mode === "register"
                ? t("Konto erstellen", "Create account")
                : mode === "forgot"
                  ? t("Link senden", "Send link")
                  : t("Anmelden", "Sign in")}
            </button>
          </form>
        )}
        {localLogin && mode === "signin" && desktopApp && (
          <a className="button wide" href="/api/auth/desktop" title={t("Öffnet die Anmeldung im Browser", "Opens the sign-in in your browser")}>
            <Fingerprint size={19} />
            {t("Mit Passkey anmelden", "Sign in with a passkey")}
            <ArrowSquareOut size={16} />
          </a>
        )}
        {localLogin && mode === "signin" && passkeys && !desktopApp && (
          <button className="button wide" onClick={passkey} disabled={!!busy}>
            {busy === "passkey" ? <SpinnerGap className="spin" /> : <Fingerprint size={19} />}
            {t("Mit Passkey anmelden", "Sign in with a passkey")}
          </button>
        )}
        {configured && mode === "signin" && (
          <>
            {localLogin && <div className="login-or">{t("oder", "or")}</div>}
            {!localLogin && rememberBox && <div className="login-options">{rememberBox}</div>}
            <a
              className={`button wide${localLogin ? "" : " primary"}`}
              href={desktopApp ? "/api/auth/desktop?via=sso" : stay ? `${loginUrl}&remember=1` : loginUrl}
              title={desktopApp ? t("Öffnet die Anmeldung im Browser", "Opens the sign-in in your browser") : undefined}
            >
              <ShieldCheck size={19} />
              {t("Mit SSO anmelden", "Sign in with SSO")}
              {desktopApp ? <ArrowSquareOut size={16} /> : <ArrowRight size={18} />}
            </a>
          </>
        )}
        {!configured && !localLogin && (
          <div className="callout">
            {t(
              "Die Anmeldung wird über deinen OIDC-Anbieter eingerichtet. Wie das geht, steht in der Dokumentation unter „Anmeldung mit OIDC“.",
              "Sign-in is set up with your OIDC provider. The documentation explains how under “Sign-in with OIDC”.",
            )}{" "}
            <a href="https://docs.flowplan.org/sign-in">docs.flowplan.org/sign-in</a>
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
            ) : !firstAccount || mode === "forgot" || mode === "confirm" ? (
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
      {/* One quiet line: the tagline on the left, legal links and language on the right. */}
      <footer className="login-footer">
        <span>
          Flowplan · {t("Ein Zuhause für gute Zusammenarbeit.", "A home for good collaboration.")}
        </span>
        <div className="login-footer-links">
          {legal && <LegalFooter links={legal} locale={useLocale()} />}
          <LanguageSwitch className="language-switch" />
        </div>
      </footer>
    </main>
  );
}
