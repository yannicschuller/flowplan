"use client";
import { serverMessage } from "@/lib/i18n-errors";
// Two-factor sign-in with an authenticator app (lib/two-factor.ts):
// Settings → General → your profile, and the screen an instance shows when
// it requires a second factor that the account does not have yet.
import { useEffect, useState, type FormEvent } from "react";
import {
  Copy,
  DownloadSimple,
  Fingerprint,
  ShieldCheck,
  SignOut,
  SpinnerGap,
} from "@phosphor-icons/react";
import {
  browserSupportsWebAuthn,
  startRegistration,
} from "@simplewebauthn/browser";
import { BrandMark } from "./brand-mark";
import { useT } from "./i18n";
import type { TwoFactorStatus } from "@/lib/two-factor";

type Setup = {
  secret: string;
  uri: string;
  qr: { size: number; path: string } | null;
};
async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      serverMessage((data as { error?: string }).error) || response.statusText,
    );
  return data as T;
}
// The confirmation field takes either the password or a six-digit code
// (passwords have at least ten characters).
const confirmation = (value: string) =>
  /^\d{6}$/.test(value.replace(/\s/g, ""))
    ? { code: value }
    : { password: value };

export function TwoFactorSettings({
  enforced = false,
  onDone,
}: {
  enforced?: boolean;
  onDone?: () => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<TwoFactorStatus | null>(null),
    [setup, setSetup] = useState<Setup | null>(null),
    [codes, setCodes] = useState<string[] | null>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirm, setConfirm] = useState("");
  useEffect(() => {
    post<{ status: TwoFactorStatus }>("two-factor")
      .then((r) => setStatus(r.status))
      .catch((e) => setError((e as Error).message));
  }, []);
  const run = async (key: string, action: () => Promise<string | void>) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const message = await action();
      if (message) setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const begin = () =>
    run("setup", async () => {
      setSetup(await post<Setup>("totp-setup"));
    });
  const finishSetup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") || "");
    void run("confirm", async () => {
      const result = await post<{
        recoveryCodes: string[];
        status: TwoFactorStatus;
      }>("totp-confirm", { code });
      setSetup(null);
      setCodes(result.recoveryCodes);
      setStatus(result.status);
      return t(
        "Zwei-Faktor-Anmeldung ist eingeschaltet.",
        "Two-factor sign-in is on.",
      );
    });
  };
  const regenerate = () =>
    run("recovery", async () => {
      const result = await post<{
        recoveryCodes: string[];
        status: TwoFactorStatus;
      }>("totp-recovery", confirmation(confirm));
      setConfirm("");
      setCodes(result.recoveryCodes);
      setStatus(result.status);
      return t(
        "Neue Wiederherstellungscodes erstellt – die alten gelten nicht mehr.",
        "New recovery codes created – the old ones no longer work.",
      );
    });
  const disable = () =>
    run("disable", async () => {
      const result = await post<{ status: TwoFactorStatus }>(
        "totp-disable",
        confirmation(confirm),
      );
      setConfirm("");
      setStatus(result.status);
      return t(
        "Zwei-Faktor-Anmeldung ist ausgeschaltet.",
        "Two-factor sign-in is off.",
      );
    });
  // Turning it on needs nothing; turning it off is confirmed like the rest.
  const toggleAfterPasskey = (enabled: boolean) =>
    run("after-passkey", async () => {
      const result = await post<{ status: TwoFactorStatus }>(
        "totp-after-passkey",
        enabled ? { enabled } : { enabled, ...confirmation(confirm) },
      );
      setConfirm("");
      setStatus(result.status);
      return enabled
        ? t(
            "Nach dem Passkey wird jetzt auch ein Code aus der App verlangt.",
            "A code from the app is now also asked for after the passkey.",
          )
        : t(
            "Mit dem Passkey meldest du dich jetzt ohne Code an.",
            "With the passkey you now sign in without a code.",
          );
    });
  const codesText = (codes || []).join("\n");
  return (
    <div className="two-factor">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="account-status">
          {notice}
        </p>
      )}
      {codes ? (
        <div className="recovery-codes">
          <p>
            <strong>
              {t("Deine Wiederherstellungscodes", "Your recovery codes")}
            </strong>
            <br />
            {t(
              "Bewahre sie sicher auf, z. B. im Passwortmanager. Jeder Code funktioniert einmal, wenn du keinen Zugriff auf die App hast. Sie werden nur jetzt angezeigt.",
              "Keep them safe, e.g. in your password manager. Each code works once when you cannot reach the app. They are shown only now.",
            )}
          </p>
          <ol className="recovery-code-list">
            {codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ol>
          <div className="two-factor-actions">
            <button
              type="button"
              className="button compact"
              onClick={() =>
                void navigator.clipboard.writeText(codesText).then(
                  () => setNotice(t("Codes kopiert", "Codes copied")),
                  () =>
                    setNotice(
                      t(
                        "Bitte die Codes von Hand kopieren.",
                        "Please copy the codes by hand.",
                      ),
                    ),
                )
              }
            >
              <Copy size={15} /> {t("Kopieren", "Copy")}
            </button>
            <a
              className="button compact"
              download="flowplan-recovery-codes.txt"
              href={`data:text/plain;charset=utf-8,${encodeURIComponent(codesText + "\n")}`}
            >
              <DownloadSimple size={15} /> {t("Herunterladen", "Download")}
            </a>
            <button
              type="button"
              className="button primary compact"
              onClick={() => {
                setCodes(null);
                onDone?.();
              }}
            >
              {enforced
                ? t("Weiter zu Flowplan", "Continue to Flowplan")
                : t("Gespeichert", "Saved")}
            </button>
          </div>
        </div>
      ) : setup ? (
        <form className="totp-setup" onSubmit={finishSetup}>
          <p>
            {t(
              "1. Scanne den QR-Code mit einer Authenticator-App (z. B. Aegis, 2FAS, Google Authenticator, 1Password).",
              "1. Scan the QR code with an authenticator app (e.g. Aegis, 2FAS, Google Authenticator, 1Password).",
            )}
          </p>
          {setup.qr && (
            <svg
              className="totp-qr"
              role="img"
              aria-label={t(
                "QR-Code für die Authenticator-App",
                "QR code for the authenticator app",
              )}
              viewBox={`-4 -4 ${setup.qr.size + 8} ${setup.qr.size + 8}`}
              shapeRendering="crispEdges"
            >
              <rect
                x={-4}
                y={-4}
                width={setup.qr.size + 8}
                height={setup.qr.size + 8}
                fill="#fff"
              />
              <path d={setup.qr.path} fill="#000" />
            </svg>
          )}
          <p className="muted small">
            {t(
              "Kein Scan möglich? Gib diesen Schlüssel in der App ein:",
              "Cannot scan? Enter this key in the app:",
            )}
            <br />
            <code className="totp-secret">
              {setup.secret.match(/.{1,4}/g)?.join(" ")}
            </code>
          </p>
          <label>
            {t(
              "2. Code aus der App eingeben",
              "2. Enter the code from the app",
            )}
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              required
              autoFocus
            />
          </label>
          <div className="two-factor-actions">
            <button className="button primary compact" disabled={!!busy}>
              {busy === "confirm" && <SpinnerGap className="spin" />}
              {t("Bestätigen", "Confirm")}
            </button>
            <button
              type="button"
              className="button compact"
              disabled={!!busy}
              onClick={() => setSetup(null)}
            >
              {t("Abbrechen", "Cancel")}
            </button>
          </div>
        </form>
      ) : !status ? (
        <p className="muted">{t("Lädt …", "Loading …")}</p>
      ) : status.enabled ? (
        <div className="totp-enabled">
          <p>
            <ShieldCheck size={17} /> {t("Eingeschaltet", "On")} ·{" "}
            {t(
              `${status.recoveryLeft} Wiederherstellungscodes übrig`,
              `${status.recoveryLeft} recovery codes left`,
            )}
          </p>
          <label>
            {t(
              "Zum Ändern: Passwort oder aktueller Code aus der App",
              "To change it: password or current code from the app",
            )}
            <input
              type="password"
              autoComplete="current-password"
              maxLength={200}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <div className="two-factor-actions">
            <button
              type="button"
              className="button compact"
              disabled={!!busy || !confirm}
              onClick={() => void regenerate()}
            >
              {t("Neue Wiederherstellungscodes", "New recovery codes")}
            </button>
            <button
              type="button"
              className="button compact danger"
              disabled={
                !!busy || !confirm || (status.required && !status.passkey)
              }
              onClick={() => void disable()}
            >
              {t("Ausschalten", "Turn off")}
            </button>
          </div>
          {status.passkey && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={status.afterPasskey}
                disabled={!!busy || (status.afterPasskey && !confirm)}
                onChange={(e) => void toggleAfterPasskey(e.target.checked)}
              />
              <span>
                {t(
                  "Auch nach dem Passkey einen Code verlangen",
                  "Also ask for a code after the passkey",
                )}
                <small className="muted">
                  {t(
                    "Ein Passkey reicht sonst allein. Zum Ausschalten oben Passwort oder Code eingeben.",
                    "Otherwise a passkey is enough on its own. To turn this off, enter your password or a code above.",
                  )}
                </small>
              </span>
            </label>
          )}
          {status.required && !status.passkey && (
            <small className="muted">
              {t(
                "Auf dieser Instanz vorgeschrieben – ausschalten geht erst mit einem Passkey.",
                "Required on this instance – turning it off needs a passkey first.",
              )}
            </small>
          )}
        </div>
      ) : (
        <div>
          <p className="muted">
            {status.required
              ? t(
                  "Auf dieser Instanz ist eine Zwei-Faktor-Anmeldung vorgeschrieben.",
                  "Two-factor sign-in is required on this instance.",
                )
              : t(
                  "Nach dem Passwort fragt Flowplan nach einem Code aus einer Authenticator-App. Wer sich mit einem Passkey anmeldet, braucht keinen Code.",
                  "After the password, Flowplan asks for a code from an authenticator app. Signing in with a passkey needs no code.",
                )}
          </p>
          <button
            type="button"
            className="button"
            disabled={!!busy}
            onClick={() => void begin()}
          >
            {busy === "setup" ? (
              <SpinnerGap className="spin" />
            ) : (
              <ShieldCheck size={17} />
            )}
            {t("Authenticator-App einrichten", "Set up an authenticator app")}
          </button>
        </div>
      )}
    </div>
  );
}

// Signed in, but the instance requires a second factor first.
export function TwoFactorRequired({
  name,
  instanceName,
}: {
  name: string;
  instanceName?: string;
}) {
  const t = useT();
  const [passkeys, setPasskeys] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => setPasskeys(browserSupportsWebAuthn()), []);
  const addPasskey = async () => {
    setBusy(true);
    setError("");
    try {
      const options = await post<
        Parameters<typeof startRegistration>[0]["optionsJSON"]
      >("passkey-register-options");
      let response;
      try {
        response = await startRegistration({ optionsJSON: options });
      } catch {
        throw new Error(
          t("Passkey wurde nicht angelegt.", "The passkey was not created."),
        );
      }
      const device =
        navigator.userAgent.match(
          /iPhone|iPad|Mac|Android|Windows|Linux/,
        )?.[0] || "";
      await post("passkey-register", {
        response,
        name: device ? `Passkey · ${device}` : "Passkey",
      });
      location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <main className="login" data-signed-out="">
      <div className="login-brand">
        <BrandMark size={32} />
        flowplan
        {instanceName && <span className="muted"> · {instanceName}</span>}
      </div>
      <section className="login-card two-factor-required">
        <h1>{t("Zweiten Faktor einrichten", "Set up a second factor")}</h1>
        <p>
          {t(
            `Hallo ${name}, auf dieser Instanz meldest du dich mit zwei Faktoren an. Richte eine Authenticator-App ein – oder lege einen Passkey an.`,
            `Hello ${name}, this instance requires two-factor sign-in. Set up an authenticator app – or add a passkey.`,
          )}
        </p>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        <TwoFactorSettings enforced onDone={() => location.reload()} />
        {passkeys && (
          <button
            type="button"
            className="button wide"
            disabled={busy}
            onClick={() => void addPasskey()}
          >
            {busy ? <SpinnerGap className="spin" /> : <Fingerprint size={19} />}
            {t("Stattdessen Passkey anlegen", "Add a passkey instead")}
          </button>
        )}
        <button
          type="button"
          className="text-button"
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
            location.assign("/");
          }}
        >
          <SignOut size={15} /> {t("Abmelden", "Sign out")}
        </button>
      </section>
    </main>
  );
}
