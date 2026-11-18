"use client";
// /passkey-add: the passkey of "Passkey hinzufügen" in the iPhone, iPad and
// Android app, made in the system's sign-in sheet (lib/app-passkey.ts). One
// tap exchanges the app's one-time token for the ceremony; the device asks
// for Face ID, a fingerprint or its PIN; then the page goes back to the app –
// or, opened by the desktop app in the default browser, says to close it
// (the desktop app's window sees the new passkey itself).
import { serverMessage } from "@/lib/server-message";
import { appPasskeyCallback, passkeyName, type AppPasskeyStatus } from "@/lib/app-passkey";
import { useEffect, useRef, useState } from "react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { BrandMark } from "./brand-mark";
import { AuthLayout } from "./auth-layout";
import { useT } from "./i18n";

type Options = Parameters<typeof startRegistration>[0]["optionsJSON"];
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(serverMessage((data as { error?: string }).error) || response.statusText);
  return data as T;
}

export default function AppPasskeyAdd({
  token,
  returnTo,
  account,
  instanceName = "",
}: {
  token: string;
  // The phone app's callback; null: the desktop app's default browser
  // (no way back but closing the window); false: an invalid callback.
  returnTo: string | null | false;
  account: { name: string; email: string } | null;
  instanceName?: string;
}) {
  const t = useT();
  const [state, setState] = useState<"ready" | "busy" | "added" | "error">("ready"),
    [error, setError] = useState(""),
    [supported, setSupported] = useState(true);
  // The ceremony, once the token is used up: a cancelled prompt can be tried
  // again with it (five minutes).
  const options = useRef<Options | null>(null);
  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
    // The token leaves the address bar (and the history) at once.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("token")) {
        url.searchParams.delete("token");
        window.history.replaceState(null, "", url.pathname + url.search);
      }
    } catch {}
  }, []);
  // The way back is a link as well: a Custom Tab opens the app's scheme
  // only after a tap once the ceremony took a while.
  const callback = (status: AppPasskeyStatus) => (returnTo ? appPasskeyCallback(returnTo, status) : "");
  const back = (status: AppPasskeyStatus) => {
    if (returnTo) window.location.href = callback(status);
  };
  const add = async () => {
    setState("busy");
    setError("");
    try {
      options.current ??= await post<Options>("passkey-app-options", { token });
      let response;
      try {
        response = await startRegistration({ optionsJSON: options.current });
      } catch {
        throw new Error(t("Passkey wurde nicht angelegt.", "The passkey was not created."));
      }
      // The ceremony is used up by this, whatever the answer.
      options.current = null;
      await post("passkey-app-register", { response, name: passkeyName(navigator.userAgent, navigator.maxTouchPoints) });
      setState("added");
      back("added");
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  // Back to the app: the phone app's callback; nothing in the browser.
  const backLink = (status: AppPasskeyStatus, primary = true, label = "") =>
    returnTo ? (
      <a className={`button wide${primary ? " primary" : ""}`} aria-disabled={state === "busy" || undefined} href={callback(status)}>
        {label || t("Zurück zur App", "Back to the app")}
      </a>
    ) : null;
  const heading =
    returnTo === false
      ? t("Link ungültig", "Invalid link")
      : !account
        ? t("Link abgelaufen", "Link expired")
        : state === "added"
          ? t("Passkey angelegt", "Passkey added")
          : t("Passkey hinzufügen", "Add a passkey");
  return (
    <AuthLayout instanceName={instanceName} signedOut>
      <div className="login-brand">
        <BrandMark size={32} />
        flowplan
      </div>
      <section className="login-card">
        <h1>{heading}</h1>
        {returnTo === false ? (
          <p>{t("Schließe dieses Fenster und tippe in der Flowplan-App noch einmal auf „Passkey hinzufügen“.", "Close this window and tap “Add a passkey” in the Flowplan app again.")}</p>
        ) : !account ? (
          <>
            <p>{t("Der Link gilt fünf Minuten und nur einmal. Tippe in der App noch einmal auf „Passkey hinzufügen“.", "The link is valid for five minutes and only once. Tap “Add a passkey” in the app again.")}</p>
            {backLink("failed")}
          </>
        ) : state === "added" ? (
          <>
            <p role="status">
              {returnTo
                ? t("Du kannst dich jetzt in der App mit diesem Passkey anmelden.", "You can now sign in to the app with this passkey.")
                : t("Du kannst dieses Fenster schließen: Die Flowplan-App zeigt den neuen Passkey, und du meldest dich damit an – auch hier im Browser.", "You can close this window: the Flowplan app shows the new passkey, and you sign in with it – here in the browser too.")}
            </p>
            {backLink("added")}
          </>
        ) : !supported ? (
          <>
            <p role="alert" className="error">
              {t("Dieser Browser unterstützt keine Passkeys.", "This browser does not support passkeys.")}
            </p>
            {backLink("failed")}
          </>
        ) : (
          <>
            <p>
              {t(
                `Für dein Konto ${account.name} (${account.email}). Dein Gerät fragt gleich nach Face ID, Fingerabdruck oder Geräte-PIN und speichert den Passkey (iCloud-Schlüsselbund, Google-Passwortmanager oder dein Passwortmanager).`,
                `For your account ${account.name} (${account.email}). Your device asks for Face ID, your fingerprint or its PIN and stores the passkey (iCloud Keychain, Google Password Manager or your password manager).`,
              )}
            </p>
            {error && (
              <div role="alert" className="error">
                {error}
              </div>
            )}
            <button type="button" className="button primary wide" disabled={state === "busy"} onClick={() => void add()}>
              {state === "error" ? t("Erneut versuchen", "Try again") : t("Passkey anlegen", "Create passkey")}
            </button>
            {backLink(state === "error" ? "failed" : "cancelled", false, t("Abbrechen", "Cancel"))}
          </>
        )}
      </section>
    </AuthLayout>
  );
}
