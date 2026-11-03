"use client";
// Settings → Konto & Sicherheit → Anmeldemethoden (#101): the ways this
// account signs in – password, LDAP, connected SSO identities – with
// "SSO verbinden", "Trennen", "Passwort entfernen" and "Passwort festlegen".
// Each of these is confirmed once more (lib/step-up.ts) in a small dialog:
// the password, a code from the authenticator app or a passkey, whatever the
// account has; without any of them a sign-in within the last ten minutes.
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Fingerprint, IdentificationCard, Key, LinkSimple, Plus, SpinnerGap, Trash } from "@phosphor-icons/react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import type { SignInOverview } from "@/lib/identities";
import type { StepUpMethods } from "@/lib/step-up";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { CONTROL, SettingGroup, SettingRow, StatusBadge } from "./settings-ui";

type Overview = SignInOverview & { confirm: StepUpMethods };
async function post<T = Overview>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(serverMessage((data as { error?: string }).error) || response.statusText);
  return data as T;
}
type Confirm = { password?: string; code?: string; passkey?: unknown };
// What a confirmed step does, with the confirmation it got.
type Pending = { title: string; text: string; danger?: boolean; link?: boolean; button: string; newPassword?: boolean; run: (confirm: Confirm, extra: { next?: string }) => Promise<string | void> };

export function SignInMethods({ onChanged }: { onChanged?: () => unknown }) {
  const t = useT();
  const [data, setData] = useState<Overview | null>(null),
    [note, setNote] = useState<{ text: string; error?: boolean }>({ text: "" }),
    [pending, setPending] = useState<Pending | null>(null);
  const load = useCallback(() => post("sign-in-methods").then(setData, () => setData(null)), []);
  useEffect(() => {
    void load();
    // Back from the provider after "Connect SSO" (?ssoLink=ok or the reason).
    const params = new URLSearchParams(window.location.search);
    const result = params.get("ssoLink");
    if (result) {
      setNote(result === "ok" ? { text: t("SSO-Konto verbunden. Du kannst dich jetzt auch damit anmelden.", "SSO identity connected. You can now sign in with it too.") } : { text: serverMessage(result), error: true });
      params.delete("ssoLink");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }
  }, [load, t]);
  if (!data) return null;
  const date = (ms: number) => new Date(ms).toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "short", year: "numeric" });
  const others = (data.password ? 1 : 0) + (data.ldap ? 1 : 0);
  const done = (result: Overview & { ok?: boolean }, text: string) => {
    setData(result);
    void onChanged?.();
    return text;
  };
  const connect = () =>
    setPending({
      title: t("SSO-Konto verbinden", "Connect SSO identity"),
      text: t(
        "Danach meldest du dich bei deinem Identitätsanbieter an. Das SSO-Konto wird mit diesem Flowplan-Konto verbunden – du kannst dich dann mit beidem anmelden.",
        "You then sign in with your identity provider. The SSO identity is connected to this Flowplan account – you can then sign in with either.",
      ),
      button: t("Weiter zum Anbieter", "Continue to provider"),
      link: true,
      run: async (confirm) => {
        const { url } = await post<{ url: string }>("sso-link-start", { confirm });
        window.location.assign(url);
      },
    });
  const disconnect = (identity: Overview["list"][number]) =>
    setPending({
      title: t("SSO-Konto trennen?", "Disconnect SSO identity?"),
      text: t(
        `Du kannst dich danach nicht mehr mit ${identity.email || identity.provider} über ${identity.provider} anmelden.`,
        `You can then no longer sign in with ${identity.email || identity.provider} through ${identity.provider}.`,
      ),
      danger: true,
      button: t("Trennen", "Disconnect"),
      run: async (confirm) => done(await post("sso-unlink", { identityId: identity.id, confirm }), t("SSO-Konto getrennt.", "SSO identity disconnected.")),
    });
  const removePassword = () =>
    setPending({
      title: t("Passwort entfernen?", "Remove password?"),
      text: t(
        "Danach meldest du dich nur noch über SSO an. Passkeys und die Authenticator-App bleiben, um wichtige Schritte zu bestätigen. Ein neues Passwort kannst du jederzeit festlegen.",
        "You then sign in through SSO only. Passkeys and the authenticator app stay for confirming important steps. You can set a new password at any time.",
      ),
      danger: true,
      button: t("Passwort entfernen", "Remove password"),
      run: async (confirm) => done(await post("password-remove", { confirm }), t("Passwort entfernt – Anmeldung nur noch über SSO.", "Password removed – sign-in through SSO only.")),
    });
  const setPassword = () =>
    setPending({
      title: t("Passwort festlegen", "Set password"),
      text: t("Mindestens 10 Zeichen. Danach kannst du dich auch wieder mit E-Mail und Passwort anmelden.", "At least 10 characters. You can then sign in with e-mail and password again too."),
      button: t("Passwort festlegen", "Set password"),
      newPassword: true,
      run: async (confirm, extra) => done(await post("password-set", { confirm, next: extra.next }), t("Passwort festgelegt.", "Password set.")),
    });
  return (
    <SettingGroup
      id="sign-in-methods"
      title={t("Anmeldemethoden", "Sign-in methods")}
      description={t(
        "Womit du dich bei diesem Konto anmeldest. Ein SSO-Konto deiner Organisation lässt sich mit diesem Konto verbinden, damit es kein zweites Profil gibt.",
        "How you sign in to this account. An SSO identity of your organisation can be connected to this account, so there is no second profile.",
      )}
    >
      {note.text && (
        <div className="setting-row wide">
          <p role={note.error ? "alert" : "status"} className={note.error ? "error sign-in-note" : "account-status sign-in-note"}>
            {note.text}
          </p>
        </div>
      )}
      {data.local && (
        <SettingRow
          anchor="password-method"
          label={t("E-Mail und Passwort", "E-mail and password")}
          description={
            data.password
              ? data.ssoOnly
                ? t("Die Administration lässt verbundene Konten nur über SSO anmelden. Das Passwort bestätigt hier keine Schritte mehr.", "The administrators let connected accounts sign in through SSO only. The password no longer confirms steps here.")
                : t("Du kannst dich mit deiner E-Mail-Adresse und deinem Passwort anmelden.", "You can sign in with your e-mail address and password.")
              : t("Kein Passwort – du meldest dich über SSO an.", "No password – you sign in through SSO.")
          }
        >
          <StatusBadge tone={data.password ? "ok" : "off"}>{data.password ? t("Aktiv", "Active") : t("Kein Passwort", "No password")}</StatusBadge>
          {data.password && data.identities > 0 && (
            <button type="button" className="button danger" onClick={removePassword}>
              {t("Passwort entfernen …", "Remove password …")}
            </button>
          )}
          {!data.password && (
            <button type="button" className="button" onClick={setPassword}>
              <Key size={16} aria-hidden /> {t("Passwort festlegen …", "Set password …")}
            </button>
          )}
        </SettingRow>
      )}
      {data.ldap && (
        <SettingRow label={t("Verzeichnis (LDAP)", "Directory (LDAP)")} description={t("Anmeldung mit dem Passwort deines Verzeichniskontos.", "Sign-in with the password of your directory account.")}>
          <StatusBadge tone="ok">{t("Aktiv", "Active")}</StatusBadge>
        </SettingRow>
      )}
      <SettingRow
        anchor="sso"
        label={t("Single Sign-on (SSO)", "Single sign-on (SSO)")}
        description={
          data.identities
            ? data.identities === 1
              ? t("1 verbundenes SSO-Konto.", "1 connected SSO identity.")
              : t(`${data.identities} verbundene SSO-Konten.`, `${data.identities} connected SSO identities.`)
            : data.ssoConfigured
              ? t("Noch nicht verbunden. Verbinde dein SSO-Konto, um dich auch darüber anzumelden.", "Not connected yet. Connect your SSO identity to sign in with it too.")
              : t("Diese Instanz hat kein SSO eingerichtet.", "This instance has no SSO set up.")
        }
      >
        {data.ssoConfigured && (
          <button type="button" className="button" onClick={connect}>
            <Plus size={16} aria-hidden /> {t("SSO verbinden …", "Connect SSO …")}
          </button>
        )}
      </SettingRow>
      {data.list.length > 0 && (
        <div className="setting-row wide setting-sublist">
          <ul className="passkey-list identity-list" aria-label={t("Verbundene SSO-Konten", "Connected SSO identities")}>
            {data.list.map((identity) => {
              const last = data.identities <= 1 && others === 0;
              return (
                <li key={identity.id}>
                  <IdentificationCard size={18} aria-hidden />
                  <span>
                    {identity.email || identity.provider}
                    <small>
                      {identity.provider} · {t("verbunden", "connected")} {date(identity.createdAt)}
                      {identity.lastUsedAt ? ` · ${t("zuletzt benutzt", "last used")} ${date(identity.lastUsedAt)}` : ""}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={last}
                    aria-label={t(`${identity.email || identity.provider} trennen`, `Disconnect ${identity.email || identity.provider}`)}
                    title={last ? t("Deine einzige Anmeldemethode – lege zuerst ein Passwort fest.", "Your only sign-in method – set a password first.") : t("Trennen", "Disconnect")}
                    onClick={() => disconnect(identity)}
                  >
                    <Trash size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {pending && (
        <StepUpDialog
          pending={pending}
          methods={data.confirm}
          onClose={() => setPending(null)}
          onDone={(text) => {
            setPending(null);
            if (text) setNote({ text });
          }}
        />
      )}
    </SettingGroup>
  );
}

// Confirms one step: the password, a code from the app or a passkey.
function StepUpDialog({ pending, methods, onClose, onDone }: { pending: Pending; methods: StepUpMethods; onClose: () => void; onDone: (text: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [useCode, setUseCode] = useState(!methods.password && methods.code);
  const passkeys = methods.passkey && typeof window !== "undefined" && browserSupportsWebAuthn();
  const go = async (key: string, confirm: () => Promise<Confirm>, form?: HTMLFormElement) => {
    setBusy(key);
    setError("");
    try {
      let next: string | undefined;
      if (pending.newPassword && form) {
        const data = new FormData(form);
        next = String(data.get("next") || "");
        if (next !== String(data.get("repeat") || "")) throw new Error(t("Die beiden Passwörter sind nicht gleich.", "The two passwords differ."));
      }
      const text = await pending.run(await confirm(), { next });
      if (text) onDone(text);
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void go(
      "form",
      async () => (methods.password && !useCode ? { password: String(data.get("password") || "") } : methods.code && useCode ? { code: String(data.get("code") || "") } : {}),
      form,
    );
  };
  const passkey = () =>
    go("passkey", async () => {
      const options = await post<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("confirm-passkey-options");
      try {
        return { passkey: await startAuthentication({ optionsJSON: options }) };
      } catch {
        throw new Error(t("Der Passkey wurde nicht bestätigt.", "The passkey was not confirmed."));
      }
    });
  const asks = (methods.password && !useCode) || (methods.code && useCode);
  return (
    <Modal open onClose={() => !busy && onClose()} title={pending.title} className="step-up-dialog">
      <form method="post" action="/api/auth/no-script" className="account-form step-up-form" onSubmit={submit}>
        <p className="muted">{pending.text}</p>
        {pending.newPassword && (
          <>
            <label>
              {t("Neues Passwort", "New password")}
              <input className={CONTROL.lg} name="next" type="password" autoComplete="new-password" required minLength={10} maxLength={200} autoFocus />
            </label>
            <label>
              {t("Neues Passwort wiederholen", "Repeat new password")}
              <input className={CONTROL.lg} name="repeat" type="password" autoComplete="new-password" required minLength={10} maxLength={200} />
            </label>
          </>
        )}
        <fieldset className="step-up-confirm">
          <legend>{t("Zur Sicherheit bestätigen", "Confirm for security")}</legend>
          {methods.password && !useCode && (
            <label>
              {t("Aktuelles Passwort", "Current password")}
              <input className={CONTROL.lg} name="password" type="password" autoComplete="current-password" required maxLength={200} autoFocus={!pending.newPassword} />
            </label>
          )}
          {methods.code && useCode && (
            <label>
              {t("Code aus der Authenticator-App oder Wiederherstellungscode", "Code from the authenticator app or recovery code")}
              <input className={CONTROL.lg} name="code" inputMode="text" autoComplete="one-time-code" required maxLength={40} autoFocus={!pending.newPassword} />
            </label>
          )}
          {methods.password && methods.code && (
            <button type="button" className="text-button" onClick={() => setUseCode(!useCode)}>
              {useCode ? t("Stattdessen mit Passwort", "Use the password instead") : t("Stattdessen mit Code aus der App", "Use a code from the app instead")}
            </button>
          )}
          {methods.recent && (
            <p className="muted small">
              {methods.recentOk
                ? t("Du hast dich gerade erst angemeldet – das genügt als Bestätigung.", "You signed in just now – that is enough to confirm.")
                : t("Melde dich ab und wieder an, dann bestätigt die frische Anmeldung diesen Schritt (zehn Minuten lang).", "Sign out and in again; the fresh sign-in then confirms this step (for ten minutes).")}
            </p>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="account-form-actions">
          {(asks || methods.recentOk || (pending.newPassword && !passkeys)) && (
            <button className={`button ${pending.danger ? "danger-solid" : "primary"}`} disabled={!!busy}>
              {busy === "form" ? <SpinnerGap className="spin" aria-hidden /> : pending.link ? <LinkSimple size={16} aria-hidden /> : null} {pending.button}
            </button>
          )}
          {passkeys && (
            <button type="button" className={`button${asks || methods.recentOk ? "" : pending.danger ? " danger-solid" : " primary"}`} disabled={!!busy} onClick={() => void (pending.newPassword ? passkeyWithForm() : passkey())}>
              {busy === "passkey" ? <SpinnerGap className="spin" aria-hidden /> : <Fingerprint size={16} aria-hidden />} {t("Mit Passkey bestätigen", "Confirm with passkey")}
            </button>
          )}
          <button type="button" className="button" disabled={!!busy} onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
  // A new password confirmed by a passkey: the form's fields go along.
  function passkeyWithForm() {
    const form = document.querySelector<HTMLFormElement>(".step-up-form");
    if (form && !form.reportValidity()) return;
    void go(
      "passkey",
      async () => {
        const options = await post<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("confirm-passkey-options");
        try {
          return { passkey: await startAuthentication({ optionsJSON: options }) };
        } catch {
          throw new Error(t("Der Passkey wurde nicht bestätigt.", "The passkey was not confirmed."));
        }
      },
      form || undefined,
    );
  }
}
