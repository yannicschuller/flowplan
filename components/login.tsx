"use client";
import { serverMessage } from "@/lib/i18n-errors";
// Sign-in page: e-mail and password, passkeys, single sign-on (OIDC) – as
// far as the instance offers them. Also creating an account (the first
// account sets the instance up) and asking for a password reset link.
import { BrandMark } from "./brand-mark";
import { loginReturnPath } from "@/lib/page-location";
import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { ArrowRight, ArrowSquareOut, EnvelopeSimple, Fingerprint, ShieldCheck, SpinnerGap } from "@phosphor-icons/react";
import { PlainHttpNote } from "./plain-http-note";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { LanguageSwitch, useLocale, useT } from "./i18n";
import type { LoginOptions } from "@/lib/local-auth";
import type { LegalLinks } from "@/lib/legal-links";
import { LegalFooter } from "./legal-footer";
import { GITHUB_URL, LICENSE_URL } from "@/lib/about";
import { AppProfilesLink } from "./app-profiles-link";
import { startAppSignIn } from "@/lib/app-sign-in";
import { appDeviceKey } from "@/lib/native-app";
import { SetupRestore } from "./setup-restore";

// "confirm": registered, waiting for the link from the e-mail.
// "totp": the password was right, a code from the authenticator app follows.
type Mode = "signin" | "register" | "forgot" | "confirm" | "totp";
type Props = Partial<LoginOptions> & {
  error?: string;
  // "confirmed": the address was confirmed from another browser.
  notice?: "confirmed";
  instanceName?: string;
  mode?: Mode;
  // Legal notice and privacy policy of the instance (when set).
  legal?: LegalLinks;
  // The source of the running code (FLOWPLAN_SOURCE_URL, lib/about.ts).
  sourceUrl?: string;
};

// Sign-ins in the desktop or mobile app carry its device key: they then
// last as long as the app's (lib/app-devices.ts).
const DEVICE_PATHS = new Set(["password", "totp-login", "register", "passkey"]);
async function post(path: string, body?: unknown) {
  const device = DEVICE_PATHS.has(path) ? appDeviceKey() : null;
  const payload = device && body && typeof body === "object" ? { ...body, device } : body;
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
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
  ldap = false,
  plainHttp = false,
  error,
  notice: initialNotice,
  instanceName = "",
  mode: initialMode,
  legal,
  sourceUrl = GITHUB_URL,
}: Props) {
  const t = useT();
  // The password form: accounts with e-mail and password, or the LDAP directory.
  const passwordForm = localLogin || ldap;
  const [mode, setMode] = useState<Mode>(initialMode || (firstAccount ? "register" : "signin"));
  // The first start: restore an existing instance from a backup instead (#128).
  const [restoring, setRestoring] = useState(false);
  const [busy, setBusy] = useState(""),
    [message, setMessage] = useState(error || ""),
    [notice, setNotice] = useState(
      initialNotice === "confirmed" ? t("Deine E-Mail-Adresse ist bestätigt – melde dich jetzt an.", "Your e-mail address is confirmed – sign in now.") : "",
    ),
    [pendingEmail, setPendingEmail] = useState(""),
    // Second step: a recovery code instead of the code from the app.
    [recovery, setRecovery] = useState(false);
  const [loginUrl, setLoginUrl] = useState("/api/auth/login");
  const [passkeys, setPasskeys] = useState(false);
  // "Stay signed in on this device": for password, passkey and SSO alike.
  const [remember, setRemember] = useState(false);
  const stay = rememberAvailable && remember;
  // The desktop and mobile apps sign in with passkeys and SSO in the system
  // browser (lib/desktop-sign-in.ts): in the app these buttons hand over to
  // it, in the browser ?desktop= carries the app's request through the sign-in.
  const [desktopApp, setDesktopApp] = useState(false);
  // In the apps the hand-off (passkey, SSO) and a password sign-in with
  // the app's device key stay signed in anyway; an older app without a key
  // signs in with the password like a browser and gets the box for it.
  const [appKey, setAppKey] = useState(false);
  const [desktopRequest, setDesktopRequest] = useState("");
  // The app's sign-in being handed over (#109): its button shows a spinner.
  const [handingOff, setHandingOff] = useState<"" | "sso" | "passkey" | "browser">("");
  // One line: "Stay signed in" on the left, "Forgot password?" on the right.
  const rememberBox = rememberAvailable && (!desktopApp || (passwordForm && !appKey)) && (
    <label className="login-remember" title={t("Nur auf eigenen Geräten. Die Anmeldung bleibt bestehen, solange du Flowplan nutzt.", "Only on your own devices. You stay signed in while you use Flowplan.")}>
      <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
      {t("Angemeldet bleiben", "Stay signed in")}
    </label>
  );
  // Signed out (or the session ended): nothing of the last person stays in
  // the tab's cache of recent pages (lib/swr-cache.ts).
  useEffect(() => {
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--)
        if (sessionStorage.key(i)?.startsWith("flowplan:swr:")) sessionStorage.removeItem(sessionStorage.key(i)!);
    } catch {}
  }, []);
  useEffect(() => {
    const request = new URLSearchParams(location.search).get("desktop") || "";
    const desktopReturn = /^[A-Za-z0-9_-]{43}$/.test(request) ? `/api/auth/desktop?challenge=${request}` : "";
    setDesktopRequest(desktopReturn);
    setDesktopApp(/Flowplan(Desktop|Mobile)\//.test(navigator.userAgent));
    setAppKey(/Flowplan(Desktop|Mobile)\//.test(navigator.userAgent) && !!appDeviceKey());
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
        const result = await post("password", { email: field(form, "email"), password: field(form, "password"), remember: stay });
        if (result?.twoFactor) {
          setBusy("");
          setRecovery(false);
          setMode("totp");
          return;
        }
        done();
      });
    else if (mode === "totp")
      void run("totp", async () => {
        await post("totp-login", { code: field(form, "code") });
        done();
      });
    else if (mode === "register")
      void run("register", async () => {
        const query = new URLSearchParams(location.search);
        const invite = query.get("invite") || undefined,
          setup = query.get("setup") || undefined;
        const result = await post("register", { name: field(form, "name"), email: field(form, "email"), password: field(form, "password"), invite, setup });
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
      const result = await post("passkey", { ...response, remember: stay });
      // Only if the person asked for a code after the passkey as well.
      if (result?.twoFactor) {
        setBusy("");
        setRecovery(false);
        setMode("totp");
        return;
      }
      done();
    });
  const devWorkspace = () =>
    run("demo", async () => {
      await post("demo");
      done();
    });
  // In the apps: the bridge where the app has one, else the link the app
  // catches. A hand-off that fails or goes unanswered is said here and
  // reported to the instance's log (lib/app-sign-in.ts).
  const handOff = (kind: "sso" | "passkey" | "browser") => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    setMessage("");
    setHandingOff(kind);
    const how = startAppSignIn(kind === "sso" ? "sso" : null, (failure) => {
      setHandingOff("");
      if (!failure) return;
      setMessage(
        failure.reason === "failed"
          ? `${t("Die App konnte die Anmeldung nicht öffnen", "The app could not open the sign-in")} (${failure.error || failure.stage}).`
          : t(
              "Die App hat die Anmeldung nicht geöffnet. Aktualisiere die Flowplan-App und versuche es noch einmal. Passiert es wieder, melde es bitte – das Protokoll der Instanz enthält die Einzelheiten.",
              "The app did not open the sign-in. Update the Flowplan app and try again. If it happens again, please report it – the instance's log has the details.",
            ),
      );
    });
    if (how === "bridge") event.preventDefault();
  };
  const switchTo = (next: Mode) => {
    setMode(next);
    setMessage("");
    setNotice("");
  };
  const title = restoring
    ? [t("Aus einer Sicherung", "Restore from"), t("wiederherstellen.", "a backup.")]
    : mode === "register"
      ? firstAccount
        ? [t("Willkommen bei", "Welcome to"), t("deinem Flowplan.", "your Flowplan.")]
        : [t("Konto", "Create your"), t("erstellen.", "account.")]
      : mode === "confirm" || mode === "totp"
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
        {restoring ? (
          <SetupRestore onCancel={() => setRestoring(false)} />
        ) : mode === "register" && firstAccount ? (
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
        ) : mode === "totp" ? (
          <p>
            {recovery
              ? t("Gib einen deiner Wiederherstellungscodes ein. Jeder funktioniert einmal.", "Enter one of your recovery codes. Each works once.")
              : t("Gib den sechsstelligen Code aus deiner Authenticator-App ein.", "Enter the six-digit code from your authenticator app.")}
          </p>
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
        {passwordForm && mode === "totp" && (
          <form method="post" action="/api/auth/no-script" className="login-form" onSubmit={submit}>
            <label>
              {recovery ? t("Wiederherstellungscode", "Recovery code") : t("Code aus der App", "Code from the app")}
              <input
                key={recovery ? "recovery" : "code"}
                name="code"
                required
                autoFocus
                autoComplete={recovery ? "off" : "one-time-code"}
                inputMode={recovery ? "text" : "numeric"}
                pattern={recovery ? undefined : "[0-9 ]{6,7}"}
                maxLength={recovery ? 20 : 7}
                placeholder={recovery ? "xxxxx-xxxxx" : "123456"}
              />
            </label>
            <button className="button primary wide" disabled={!!busy}>
              {busy === "totp" ? <SpinnerGap className="spin" /> : null}
              {t("Bestätigen", "Confirm")}
            </button>
            <div className="login-options">
              <button type="button" className="text-button" onClick={() => setRecovery(!recovery)}>
                {recovery ? t("Code aus der App verwenden", "Use a code from the app") : t("Wiederherstellungscode verwenden", "Use a recovery code")}
              </button>
              <button type="button" className="text-button" onClick={() => switchTo("signin")}>
                {t("Zurück", "Back")}
              </button>
            </div>
          </form>
        )}
        {passwordForm && mode !== "confirm" && mode !== "totp" && !restoring && (
          <form method="post" action="/api/auth/no-script" className="login-form" onSubmit={submit}>
            {mode === "register" && (
              <label>
                {t("Name", "Name")}
                <input name="name" autoComplete="name" required maxLength={80} />
              </label>
            )}
            <label>
              {ldap && mode === "signin" ? t("E-Mail-Adresse oder Benutzername", "E-mail address or user name") : t("E-Mail-Adresse", "E-mail address")}
              <input
                name="email"
                type={ldap && mode === "signin" ? "text" : "email"}
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
                {mail && localLogin && (
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
        {/* In the app, password managers offer nothing: iOS AutoFill only
            matches the app's own domains, never a self-hosted instance
            (flowplan-app#5). The system browser's sign-in sheet shows this
            page with password and code, where they fill in both. */}
        {passwordForm && (mode === "signin" || mode === "totp") && desktopApp && (
          <p className="login-browser">
            {t("Passwort-Manager füllt nichts aus?", "Password manager not filling in?")}{" "}
            <a
              href="/api/auth/desktop"
              onClick={handOff("browser")}
              aria-busy={handingOff === "browser" || undefined}
              title={t(
                "Öffnet die Anmeldung im Browser – dort füllt dein Passwort-Manager Passwort und Code aus",
                "Opens the sign-in in your browser, where your password manager fills in the password and code",
              )}
            >
              {t("Im Browser anmelden", "Sign in in the browser")}
              {handingOff === "browser" ? <SpinnerGap size={14} className="spin" /> : <ArrowSquareOut size={14} />}
            </a>
          </p>
        )}
        {localLogin && mode === "signin" && desktopApp && (
          <a
            className="button wide"
            href="/api/auth/desktop"
            onClick={handOff("passkey")}
            aria-busy={handingOff === "passkey" || undefined}
            title={t("Öffnet die Anmeldung im Browser", "Opens the sign-in in your browser")}
          >
            {handingOff === "passkey" ? <SpinnerGap size={19} className="spin" /> : <Fingerprint size={19} />}
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
            {passwordForm && <div className="login-or">{t("oder", "or")}</div>}
            {!passwordForm && rememberBox && <div className="login-options">{rememberBox}</div>}
            <a
              className={`button wide${passwordForm ? "" : " primary"}`}
              href={desktopApp ? "/api/auth/desktop?via=sso" : stay ? `${loginUrl}&remember=1` : loginUrl}
              title={desktopApp ? t("Öffnet die Anmeldung im Browser", "Opens the sign-in in your browser") : undefined}
              onClick={desktopApp ? handOff("sso") : undefined}
              aria-busy={handingOff === "sso" || undefined}
            >
              {handingOff === "sso" ? <SpinnerGap size={19} className="spin" /> : <ShieldCheck size={19} />}
              {t("Mit SSO anmelden", "Sign in with SSO")}
              {desktopApp ? <ArrowSquareOut size={16} /> : <ArrowRight size={18} />}
            </a>
          </>
        )}
        {!configured && !passwordForm && (
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
        {mode === "register" && firstAccount && !restoring && (
          <p className="login-switch">
            {t("Umzug oder Neuinstallation?", "Moving or reinstalling?")}{" "}
            <button type="button" className="text-button" onClick={() => setRestoring(true)}>
              {t("Aus Sicherung wiederherstellen", "Restore from a backup")}
            </button>
          </p>
        )}
        {localLogin && !restoring && (
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
            ) : mode !== "totp" && (!firstAccount || mode === "forgot" || mode === "confirm") ? (
              <>
                {t("Schon ein Konto?", "Already have an account?")}{" "}
                <button type="button" className="text-button" onClick={() => switchTo("signin")}>
                  {t("Anmelden", "Sign in")}
                </button>
              </>
            ) : null}
          </p>
        )}
        {plainHttp && <PlainHttpNote />}
        {/* In the mobile app: back to its profiles (another instance, #69). */}
        <AppProfilesLink />
        <small>{t("Dein Wissen. Dein Workflow. Dein Flowplan.", "Your knowledge. Your workflow. Your Flowplan.")}</small>
      </section>
      {/* One quiet line: the tagline on the left, legal links and language on the right. */}
      <footer className="login-footer">
        <span>
          Flowplan · {t("Ein Zuhause für gute Zusammenarbeit.", "A home for good collaboration.")}
        </span>
        <div className="login-footer-links">
          {legal && <LegalFooter links={legal} locale={useLocale()} />}
          {/* AGPL-3.0: the licence and the source of what runs here. */}
          <nav className="legal-footer" aria-label={t("Lizenz und Quellcode", "Licence and source code")}>
            <a href={LICENSE_URL} rel="noopener license">
              AGPL-3.0
            </a>
            <a href={sourceUrl} rel="noopener">
              {t("Quellcode", "Source code")}
            </a>
          </nav>
          <LanguageSwitch className="language-switch" />
        </div>
      </footer>
    </main>
  );
}
