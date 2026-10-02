"use client";
// Settings → General → your profile: name, password and passkeys of an
// account with e-mail and password. SSO accounts are managed by their
// provider.
import { useEffect, useState, type FormEvent } from "react";
import { Fingerprint, Trash } from "@phosphor-icons/react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useT } from "./i18n";

type Passkey = { id: string; name: string; created_at: number; last_used_at: number | null };
async function post<T = { ok: true; passkeys: Passkey[] }>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || response.statusText);
  return data as T;
}

export function AccountSecurity({ name, onRenamed }: { name: string; onRenamed: () => void }) {
  const t = useT();
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
    post("passkeys")
      .then((r) => setPasskeys(r.passkeys))
      .catch(() => setPasskeys([]));
  }, []);
  const run = async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    setError("");
    setStatus("");
    try {
      setStatus(await action());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const date = (ms: number) => new Date(ms).toLocaleDateString(t("de-DE", "en-GB"), { day: "numeric", month: "short", year: "numeric" });
  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("name") || "");
    void run("name", async () => {
      await post("profile", { name: value });
      onRenamed();
      return t("Name gespeichert", "Name saved");
    });
  };
  const changePassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (data.get("next") !== data.get("repeat")) {
      setError(t("Die beiden neuen Passwörter sind nicht gleich.", "The two new passwords differ."));
      return;
    }
    void run("password", async () => {
      await post("password-change", { current: data.get("current"), next: data.get("next") });
      form.reset();
      return t("Passwort geändert", "Password changed");
    });
  };
  const addPasskey = () =>
    run("passkey", async () => {
      const options = await post<Parameters<typeof startRegistration>[0]["optionsJSON"]>("passkey-register-options");
      let response;
      try {
        response = await startRegistration({ optionsJSON: options });
      } catch {
        throw new Error(t("Passkey wurde nicht angelegt.", "The passkey was not created."));
      }
      const device = navigator.userAgent.match(/iPhone|iPad|Mac|Android|Windows|Linux/)?.[0] || "";
      const result = await post("passkey-register", { response, name: device ? `Passkey · ${device}` : "Passkey" });
      setPasskeys(result.passkeys);
      return t("Passkey angelegt", "Passkey added");
    });
  const removePasskey = (passkey: Passkey) =>
    run(`delete-${passkey.id}`, async () => {
      const result = await post("passkey-delete", { id: passkey.id });
      setPasskeys(result.passkeys);
      return t("Passkey entfernt", "Passkey removed");
    });
  return (
    <div className="account-security">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="account-status">
          {status}
        </p>
      )}
      <form className="account-form" onSubmit={rename}>
        <label>
          {t("Name", "Name")}
          <input name="name" defaultValue={name} required maxLength={80} />
        </label>
        <button className="button" disabled={!!busy}>
          {t("Speichern", "Save")}
        </button>
      </form>
      <h3>{t("Passwort", "Password")}</h3>
      <form className="account-form" onSubmit={changePassword}>
        <label>
          {t("Bisheriges Passwort", "Current password")}
          <input name="current" type="password" autoComplete="current-password" required maxLength={200} />
        </label>
        <label>
          {t("Neues Passwort", "New password")}
          <input name="next" type="password" autoComplete="new-password" required minLength={10} maxLength={200} />
        </label>
        <label>
          {t("Neues Passwort wiederholen", "Repeat new password")}
          <input name="repeat" type="password" autoComplete="new-password" required minLength={10} maxLength={200} />
        </label>
        <button className="button" disabled={!!busy}>
          {t("Passwort ändern", "Change password")}
        </button>
      </form>
      <h3>{t("Passkeys", "Passkeys")}</h3>
      <p className="muted">
        {t(
          "Mit einem Passkey meldest du dich per Fingerabdruck, Gesicht oder Geräte-PIN an – ohne Passwort.",
          "With a passkey you sign in with your fingerprint, face or device PIN – no password needed.",
        )}
      </p>
      <ul className="passkey-list">
        {passkeys?.map((p) => (
          <li key={p.id}>
            <Fingerprint size={18} />
            <span>
              {p.name}
              <small>
                {t("Angelegt", "Added")} {date(p.created_at)}
                {p.last_used_at ? ` · ${t("zuletzt benutzt", "last used")} ${date(p.last_used_at)}` : ""}
              </small>
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={t(`${p.name} entfernen`, `Remove ${p.name}`)}
              disabled={!!busy}
              onClick={() => void removePasskey(p)}
            >
              <Trash size={16} />
            </button>
          </li>
        ))}
        {passkeys && !passkeys.length && <li className="muted">{t("Noch kein Passkey.", "No passkey yet.")}</li>}
      </ul>
      {supported ? (
        <button type="button" className="button" disabled={!!busy} onClick={() => void addPasskey()}>
          <Fingerprint size={17} /> {t("Passkey hinzufügen", "Add a passkey")}
        </button>
      ) : (
        <p className="muted">{t("Dieser Browser unterstützt keine Passkeys.", "This browser does not support passkeys.")}</p>
      )}
    </div>
  );
}
