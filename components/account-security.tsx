"use client";
// Settings → Konto & Sicherheit: the display name, the password and the
// passkeys of an account with e-mail and password, as rows of the settings
// cards (components/settings-ui.tsx). The authenticator app is in
// components/two-factor.tsx; SSO accounts are managed by their provider.
import { serverMessage } from "@/lib/server-message";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { appPasskeysInBrowser, desktopApp, desktopPasskeyLink, desktopPasskeysInBrowser, desktopPasskeysInWindow, nativeApp } from "@/lib/native-app";
import { APP_PASSKEY_WAIT_MS, appAddsPasskey, passkeyName, waitForAppPasskey, waitForDesktopPasskey, type DesktopPasskeyPoll } from "@/lib/app-passkey";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Fingerprint, Plus, Trash } from "@phosphor-icons/react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useT } from "./i18n";
import { CONTROL, SaveState, SettingRow, StatusBadge, useSaveState } from "./settings-ui";
import { PasswordInput } from "./password-input";

type Passkey = { id: string; name: string; created_at: number; last_used_at: number | null };
async function post<T = { ok: true; passkeys: Passkey[] }>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(serverMessage((data as { error?: string }).error) || response.statusText);
  return data as T;
}

// A short note next to a control: what just happened or what went wrong.
function Note({ text, error }: { text: string; error?: boolean }) {
  if (!text) return null;
  return error ? (
    <span role="alert" className="save-state error">
      {text}
    </span>
  ) : (
    <span role="status" className="save-state saved">
      {text}
    </span>
  );
}

// The display name: saved when the field is left or with Enter.
export function ProfileNameRow({ name, onRenamed }: { name: string; onRenamed: () => unknown }) {
  const t = useT();
  const [value, setValue] = useState(name);
  const [status, run] = useSaveState();
  useEffect(() => setValue(name), [name]);
  const save = () => {
    const next = value.trim();
    if (!next || next === name) return;
    void run(async () => {
      await post("profile", { name: next });
      await onRenamed();
    });
  };
  return (
    <SettingRow label={t("Anzeigename", "Display name")} id="profile-name" description={t("Erscheint bei Kommentaren, Erwähnungen und in der Mitgliederliste.", "Shown with comments, mentions and in the member list.")}>
      <input
        id="profile-name"
        className={CONTROL.lg}
        value={value}
        required
        maxLength={80}
        autoComplete="name"
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
      />
      <SaveState status={status} />
    </SettingRow>
  );
}

// The password: a button that opens the form under the row.
export function PasswordRow() {
  const t = useT();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError("");
    if (data.get("next") !== data.get("repeat")) return setError(t("Die beiden neuen Passwörter sind nicht gleich.", "The two new passwords differ."));
    setBusy(true);
    try {
      await post("password-change", { current: data.get("current"), next: data.get("next") });
      form.reset();
      setOpen(false);
      setDone(t("Passwort geändert", "Password changed"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingRow anchor="password" label={t("Passwort", "Password")} description={t("Mindestens 10 Zeichen. Andere Geräte bleiben angemeldet.", "At least 10 characters. Other devices stay signed in.")}>
        <Note text={done} />
        {!open && (
          <button
            type="button"
            className="button"
            aria-expanded={false}
            aria-controls="password-form"
            onClick={() => {
              setDone("");
              setError("");
              setOpen(true);
            }}
          >
            {t("Passwort ändern …", "Change password …")}
          </button>
        )}
      </SettingRow>
      {open && (
        <form method="post" action="/api/auth/no-script" id="password-form" className="setting-row wide account-form" onSubmit={submit}>
          <label>
            {t("Bisheriges Passwort", "Current password")}
            <PasswordInput className={CONTROL.lg} name="current" autoComplete="current-password" required maxLength={200} autoFocus />
          </label>
          <label>
            {t("Neues Passwort", "New password")}
            <PasswordInput className={CONTROL.lg} name="next" autoComplete="new-password" required minLength={10} maxLength={200} />
          </label>
          <label>
            {t("Neues Passwort wiederholen", "Repeat new password")}
            <PasswordInput className={CONTROL.lg} name="repeat" autoComplete="new-password" required minLength={10} maxLength={200} />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="account-form-actions">
            <button className="button primary" disabled={busy}>
              {t("Passwort ändern", "Change password")}
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => setOpen(false)}>
              {t("Abbrechen", "Cancel")}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

// Passkeys: how many, "add", and the list under the row.
export function PasskeysRow() {
  const t = useT();
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [supported, setSupported] = useState(true);
  // The desktop app on macOS and Linux: its window has no authenticator, so
  // "add" would wait forever – passkeys are added in the browser there.
  const [inBrowser, setInBrowser] = useState(false);
  // The iPhone/iPad/Android app: its web view cannot make passkeys either.
  // "sheet": the app makes one in the system's sign-in sheet
  // (lib/app-passkey.ts); older apps through the system browser.
  const [inApp, setInApp] = useState<"sheet" | "open" | "note" | null>(null);
  // The desktop app that opens the one-time link in the default browser
  // (lib/app-passkey.ts): on a Mac the passkey goes to the iCloud Keychain.
  // With Touch ID in the window as well, "Passkey hinzufügen" offers both.
  const [desktopLink, setDesktopLink] = useState(false),
    [inWindow, setInWindow] = useState(false),
    [choosing, setChoosing] = useState(false),
    [waitingBrowser, setWaitingBrowser] = useState(false);
  const stopWaiting = useRef(false);
  const [note, setNote] = useState<{ text: string; error?: boolean }>({ text: "" }),
    [busy, setBusy] = useState("");
  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
    setInBrowser(desktopPasskeysInBrowser());
    setDesktopLink(desktopPasskeyLink());
    setInWindow(desktopPasskeysInWindow());
    setInApp(appAddsPasskey(nativeApp()) ? "sheet" : appPasskeysInBrowser());
    post("passkeys")
      .then((r) => setPasskeys(r.passkeys))
      .catch(() => setPasskeys([]));
  }, []);
  const run = async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    setNote({ text: "" });
    try {
      setNote({ text: await action() });
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy("");
    }
  };
  const date = (ms: number) => new Date(ms).toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "short", year: "numeric" });
  const add = () =>
    run("passkey", async () => {
      const options = await post<Parameters<typeof startRegistration>[0]["optionsJSON"]>("passkey-register-options");
      let response;
      try {
        response = await startRegistration({ optionsJSON: options });
      } catch {
        throw new Error(t("Passkey wurde nicht angelegt.", "The passkey was not created."));
      }
      const result = await post("passkey-register", { response, name: passkeyName(navigator.userAgent, navigator.maxTouchPoints) });
      setPasskeys(result.passkeys);
      return t("Passkey angelegt", "Passkey added");
    });
  // In the app: a one-time link for the system's sign-in sheet, which the
  // app opens; its answer comes as the event "flowplan:passkey".
  const addInApp = () =>
    run("passkey", async () => {
      const { url } = await post<{ url: string }>("passkey-app-link");
      const status = await waitForAppPasskey(window, () => nativeApp()?.addPasskey?.(url), APP_PASSKEY_WAIT_MS);
      // Whatever the answer, the list shows what is there now.
      await post("passkeys")
        .then((r) => setPasskeys(r.passkeys))
        .catch(() => {});
      if (status === "added") return t("Passkey angelegt", "Passkey added");
      if (status === "failed") throw new Error(t("Passkey wurde nicht angelegt.", "The passkey was not created."));
      return "";
    });
  // The desktop app: the link opens in the default browser; this window asks
  // the instance until the new passkey is there.
  const addInBrowser = () =>
    run("passkey", async () => {
      setChoosing(false);
      const known = new Set((passkeys ?? []).map((p) => p.id));
      const { url } = await post<{ url: string }>("passkey-app-link");
      const opened = await Promise.resolve(desktopApp()?.addPasskeyInBrowser?.(url)).catch(() => false);
      if (opened !== true) throw new Error(t("Der Browser ließ sich nicht öffnen.", "The browser could not be opened."));
      const token = new URL(url).searchParams.get("token");
      stopWaiting.current = false;
      setWaitingBrowser(true);
      try {
        const result = await waitForDesktopPasskey(
          () =>
            post<DesktopPasskeyPoll & { passkeys: Passkey[] }>("passkey-app-status", { token }).then((r) => {
              setPasskeys(r.passkeys);
              return r;
            }),
          known,
          { cancelled: () => stopWaiting.current },
        );
        return result === "added" ? t("Passkey angelegt", "Passkey added") : "";
      } finally {
        setWaitingBrowser(false);
      }
    });
  const remove = (passkey: Passkey) =>
    run(`delete-${passkey.id}`, async () => {
      const result = await post("passkey-delete", { id: passkey.id });
      setPasskeys(result.passkeys);
      return t("Passkey entfernt", "Passkey removed");
    });
  const count = passkeys?.length ?? 0;
  return (
    <>
      <SettingRow
        anchor="passkeys"
        label={t("Passkeys", "Passkeys")}
        description={
          desktopLink
            ? t(
                "Anmelden per Touch ID, Fingerabdruck oder Geräte-PIN – ohne Passwort. „Passkey hinzufügen“ legt ihn in deinem Browser an: auf dem Mac im iCloud-Schlüsselbund, nutzbar auch in Safari und auf dem iPhone.",
                "Sign in with Touch ID, your fingerprint or your device PIN – no password needed. “Add a passkey” creates it in your browser: on a Mac in the iCloud Keychain, usable in Safari and on the iPhone too.",
              )
            : inApp === "sheet"
            ? t(
                "Anmelden per Face ID, Fingerabdruck oder Geräte-PIN – ohne Passwort. Der Passkey wird im Anmeldefenster des Systems angelegt und dort gespeichert (iCloud-Schlüsselbund, Google-Passwortmanager oder dein Passwortmanager).",
                "Sign in with Face ID, your fingerprint or your device PIN – no password needed. The passkey is created in the system's sign-in window and stored there (iCloud Keychain, Google Password Manager or your password manager).",
              )
            : inApp
            ? inApp === "open"
              ? t(
                  "In der App legst du Passkeys im Browser an, wo sie gespeichert werden (iCloud-Schlüsselbund, Google-Passwortmanager oder dein Passwortmanager). Anmelden per Passkey geht danach auch in der App – über den Browser.",
                  "In the app you add passkeys in the browser, where they are stored (iCloud Keychain, Google Password Manager or your password manager). Signing in with a passkey then works in the app too – through the browser.",
                )
              : t(
                  "In der App legst du Passkeys im Browser an: Öffne Flowplan in Safari oder Chrome unter Einstellungen → Konto → Passkeys. Anmelden per Passkey geht danach auch in der App – über den Browser.",
                  "In the app you add passkeys in the browser: open Flowplan in Safari or Chrome under Settings → Account → Passkeys. Signing in with a passkey then works in the app too – through the browser.",
                )
            : inBrowser
            ? t(
                "In der Desktop-App legst du Passkeys im Browser an: Navigation → Im Browser öffnen zeigt diese Seite dort, dann „Passkey hinzufügen“. Anmelden per Passkey geht danach auch hier – über den Browser.",
                "In the desktop app you add passkeys in the browser: Navigation → Open in Browser shows this page there, then “Add a passkey”. Signing in with a passkey then works here too – through the browser.",
              )
            : supported
            ? t("Anmelden per Fingerabdruck, Gesicht oder Geräte-PIN – ohne Passwort.", "Sign in with your fingerprint, face or device PIN – no password needed.")
            : typeof window !== "undefined" && !window.isSecureContext
              ? // Plain http (#62): browsers offer passkeys only over HTTPS.
                t("Passkeys brauchen HTTPS – diese Instanz läuft ohne.", "Passkeys need HTTPS – this instance runs without it.")
              : t("Dieser Browser unterstützt keine Passkeys.", "This browser does not support passkeys.")
        }
      >
        <Note text={note.text} error={note.error} />
        {passkeys && <StatusBadge tone={count ? "ok" : "off"}>{count === 1 ? t("1 Passkey", "1 passkey") : count ? t(`${count} Passkeys`, `${count} passkeys`) : t("Keiner", "None")}</StatusBadge>}
        {inApp === "open" && (
          <button type="button" className="button" onClick={() => nativeApp()?.openInBrowser?.(`${window.location.origin}/#settings/account/passkeys`)}>
            <Plus size={16} aria-hidden /> {t("Im Browser hinzufügen", "Add in the browser")}
          </button>
        )}
        {desktopLink && waitingBrowser && (
          <>
            <span role="status" className="save-state">
              {t("Im Browser fortfahren …", "Continue in the browser …")}
            </span>
            <button type="button" className="button" onClick={() => {
                stopWaiting.current = true;
              }}>
              {t("Abbrechen", "Cancel")}
            </button>
          </>
        )}
        {desktopLink && !waitingBrowser && (
          <button
            type="button"
            className="button"
            disabled={!!busy}
            aria-expanded={inWindow ? choosing : undefined}
            aria-controls={inWindow ? "passkey-choice" : undefined}
            onClick={() => (inWindow ? setChoosing((open) => !open) : void addInBrowser())}
          >
            <Plus size={16} aria-hidden /> {t("Passkey hinzufügen", "Add a passkey")}
          </button>
        )}
        {inApp === "sheet" && (
          <button type="button" className="button" disabled={!!busy} onClick={() => void addInApp()}>
            <Plus size={16} aria-hidden /> {t("Passkey hinzufügen", "Add a passkey")}
          </button>
        )}
        {supported && !inBrowser && !inApp && !desktopLink && (
          <button type="button" className="button" disabled={!!busy} onClick={() => void add()}>
            <Plus size={16} aria-hidden /> {t("Passkey hinzufügen", "Add a passkey")}
          </button>
        )}
      </SettingRow>
      {desktopLink && inWindow && choosing && (
        <div id="passkey-choice" className="setting-row wide account-form" role="group" aria-label={t("Wo soll der Passkey liegen?", "Where should the passkey live?")}>
          <div className="account-form-actions">
            <button type="button" className="button primary" disabled={!!busy} onClick={() => void addInBrowser()}>
              {t("Im Schlüsselbund (iCloud)", "In the Keychain (iCloud)")}
            </button>
            <button
              type="button"
              className="button"
              disabled={!!busy}
              onClick={() => {
                setChoosing(false);
                void add();
              }}
            >
              {t("Nur in dieser App (Touch ID)", "Only in this app (Touch ID)")}
            </button>
          </div>
        </div>
      )}
      {count > 0 && (
        <div className="setting-row wide setting-sublist">
          <ul className="passkey-list" aria-label={t("Deine Passkeys", "Your passkeys")}>
            {passkeys!.map((p) => (
              <li key={p.id}>
                <Fingerprint size={18} aria-hidden />
                <span>
                  {p.name}
                  <small>
                    {t("Angelegt", "Added")} {date(p.created_at)}
                    {p.last_used_at ? ` · ${t("zuletzt benutzt", "last used")} ${date(p.last_used_at)}` : ""}
                  </small>
                </span>
                <button type="button" className="icon-button" aria-label={t(`${p.name} entfernen`, `Remove ${p.name}`)} title={t("Entfernen", "Remove")} disabled={!!busy} onClick={() => void remove(p)}>
                  <Trash size={16} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
