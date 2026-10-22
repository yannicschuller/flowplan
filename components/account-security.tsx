"use client";
// Settings → Konto & Sicherheit: the display name, the password and the
// passkeys of an account with e-mail and password, as rows of the settings
// cards (components/settings-ui.tsx). The authenticator app is in
// components/two-factor.tsx; SSO accounts are managed by their provider.
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useEffect, useState, type FormEvent } from "react";
import { Fingerprint, Plus, Trash } from "@phosphor-icons/react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useT } from "./i18n";
import { CONTROL, SaveState, SettingRow, StatusBadge, useSaveState } from "./settings-ui";

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
        <form id="password-form" className="setting-row wide account-form" onSubmit={submit}>
          <label>
            {t("Bisheriges Passwort", "Current password")}
            <input className={CONTROL.lg} name="current" type="password" autoComplete="current-password" required maxLength={200} autoFocus />
          </label>
          <label>
            {t("Neues Passwort", "New password")}
            <input className={CONTROL.lg} name="next" type="password" autoComplete="new-password" required minLength={10} maxLength={200} />
          </label>
          <label>
            {t("Neues Passwort wiederholen", "Repeat new password")}
            <input className={CONTROL.lg} name="repeat" type="password" autoComplete="new-password" required minLength={10} maxLength={200} />
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
  const [note, setNote] = useState<{ text: string; error?: boolean }>({ text: "" }),
    [busy, setBusy] = useState("");
  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
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
      const device = navigator.userAgent.match(/iPhone|iPad|Mac|Android|Windows|Linux/)?.[0] || "";
      const result = await post("passkey-register", { response, name: device ? `Passkey · ${device}` : "Passkey" });
      setPasskeys(result.passkeys);
      return t("Passkey angelegt", "Passkey added");
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
          supported
            ? t("Anmelden per Fingerabdruck, Gesicht oder Geräte-PIN – ohne Passwort.", "Sign in with your fingerprint, face or device PIN – no password needed.")
            : t("Dieser Browser unterstützt keine Passkeys.", "This browser does not support passkeys.")
        }
      >
        <Note text={note.text} error={note.error} />
        {passkeys && <StatusBadge tone={count ? "ok" : "off"}>{count === 1 ? t("1 Passkey", "1 passkey") : count ? t(`${count} Passkeys`, `${count} passkeys`) : t("Keiner", "None")}</StatusBadge>}
        {supported && (
          <button type="button" className="button" disabled={!!busy} onClick={() => void add()}>
            <Plus size={16} aria-hidden /> {t("Passkey hinzufügen", "Add a passkey")}
          </button>
        )}
      </SettingRow>
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
