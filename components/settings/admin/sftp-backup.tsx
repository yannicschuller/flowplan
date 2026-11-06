"use client";
// Administration → Speicher & Sicherung → SFTP (lib/sftp-backup.ts, #128):
// a further target of the scheduled backup – server, sign-in with password
// or private key, folder, how many copies stay, files along or not; the
// host key is confirmed on "Test connection" (trust on first use) and a
// changed key needs a confirmation again. Secrets are sent once and never
// shown again.
import { useCallback, useEffect, useState } from "react";
import { CloudArrowUp, PlugsConnected, ShieldCheck, Warning } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { SettingGroup, SettingRow, StatusBadge, SwitchRow } from "../../settings-ui";
import { bytes } from "../../admin-storage";
import { useDocs } from "./parts";
import { ago } from "./format";

type Settings = {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  auth: "password" | "key";
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
  directory: string;
  keep: number;
  uploads: boolean;
  hostKey: string | null;
};
type Run = { at: number; name: string; bytes: number; files: number; removed: number; error: string | null };
type Test = { state: "ok" | "unknown" | "changed"; fingerprint: string; expected: string | null; backups: number };
type State = { settings: Settings; status: { enabled: boolean; hostKey: string | null; last: Run | null }; test?: Test; run?: Run };

export function SftpBackup({ onError }: { onError: (message: string) => void }) {
  const t = useT();
  const docs = useDocs();
  const [state, setState] = useState<State | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  // Secrets: empty means "keep the stored one".
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState("");
  const [test, setTest] = useState<Test | null>(null);
  const [note, setNote] = useState("");
  const load = useCallback(async () => {
    try {
      const next = await api<State>("/api/admin/sftp-backup");
      setState(next);
      setForm(next.settings);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);
  useEffect(() => void load(), [load]);
  const act = async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    setNote("");
    try {
      const next = await api<State>("/api/admin/sftp-backup", body);
      setState(next);
      return next;
    } catch (e) {
      onError((e as Error).message);
      return null;
    } finally {
      setBusy("");
    }
  };
  if (!state || !form) return null;
  const set = (patch: Partial<Settings>) => setForm({ ...form, ...patch });
  const saved = !!state.settings.host;
  const last = state.status.last;
  const save = async () => {
    const next = await act("save", {
      action: "save",
      settings: {
        enabled: form.enabled,
        host: form.host,
        port: form.port,
        username: form.username,
        auth: form.auth,
        directory: form.directory,
        keep: form.keep,
        uploads: form.uploads,
        ...(password ? { password } : {}),
        ...(privateKey ? { privateKey } : {}),
        ...(passphrase ? { passphrase } : {}),
      },
    });
    if (!next) return;
    setForm(next.settings);
    setPassword("");
    setPrivateKey("");
    setPassphrase("");
    setNote(t("Gespeichert.", "Saved."));
    // A new server: its host key is looked at right away.
    if (!next.settings.hostKey) await check();
  };
  const check = async () => {
    const next = await act("test", { action: "test" });
    if (next?.test) {
      setTest(next.test);
      if (next.test.state === "ok")
        setNote(t(`Verbindung in Ordnung · ${next.test.backups} Sicherungen im Ordner`, `Connection fine · ${next.test.backups} backups in the folder`));
    }
  };
  const trust = async (fingerprint: string) => {
    const next = await act("trust", { action: "trust", fingerprint });
    if (next) {
      setTest(null);
      setForm(next.settings);
      await check();
    }
  };
  const tone = !state.status.enabled ? "off" : !state.settings.hostKey || last?.error ? "error" : last ? "ok" : "warn";
  return (
    <SettingGroup
      id="sftp-backup"
      title={t("SFTP-Ziel", "SFTP target")}
      description={
        <>
          {t(
            "Jede geplante Sicherung geht zusätzlich auf einen eigenen Server per SFTP – auf Wunsch mit allen Dateien. Für SMB- oder NFS-Freigaben: die Freigabe als Docker-Volume einhängen und den Ordner backups/ des Datenordners darauf legen.",
            "Every scheduled backup also goes to a server of your own via SFTP – with all files if you like. For SMB or NFS shares: mount the share as a Docker volume and put the data folder's backups/ folder on it.",
          )}{" "}
          <a href={docs("storage-and-backups", "sicherung-per-sftp", "backup-via-sftp")} target="_blank" rel="noreferrer">
            {t("Anleitung", "Guide")}
          </a>
        </>
      }
      actions={
        saved ? (
          <button
            type="button"
            className="button primary"
            disabled={!!busy || !state.settings.hostKey}
            onClick={async () => {
              const next = await act("run", { action: "run" });
              if (next?.run) setNote(next.run.error ? "" : t("Sicherung übertragen.", "Backup transferred."));
            }}
          >
            <CloudArrowUp size={16} aria-hidden /> {busy === "run" ? t("Sichert …", "Backing up …") : t("Jetzt sichern", "Back up now")}
          </button>
        ) : undefined
      }
    >
      {note && (
        <p className="setting-row admin-note" role="status">
          {note}
        </p>
      )}
      {saved && (
        <SettingRow
          label={t("Letzte SFTP-Sicherung", "Last SFTP backup")}
          description={
            last
              ? last.error
                ? `${new Date(last.at).toLocaleString(LOCALE_TAG)}: ${last.error}`
                : `${new Date(last.at).toLocaleString(LOCALE_TAG)} (${ago(last.at, t)}) · ${last.name} (${bytes(last.bytes)})${state.settings.uploads ? ` · ${t(`${last.files} Dateien neu, ${last.removed} entfernt`, `${last.files} files new, ${last.removed} removed`)}` : ""}`
              : t("Noch keine.", "None yet.")
          }
        >
          <StatusBadge tone={tone}>
            {!state.status.enabled
              ? t("Aus", "Off")
              : !state.settings.hostKey
                ? t("Hostschlüssel fehlt", "Host key missing")
                : last?.error
                  ? t("Fehlgeschlagen", "Failed")
                  : last
                    ? t("In Ordnung", "Fine")
                    : t("Wartet", "Waiting")}
          </StatusBadge>
        </SettingRow>
      )}
      {test && test.state !== "ok" && (
        <div className={`setting-row wide sftp-hostkey ${test.state}`} role="alert">
          {test.state === "changed" ? <Warning size={20} aria-hidden /> : <ShieldCheck size={20} aria-hidden />}
          <div>
            <strong>{test.state === "changed" ? t("Der Hostschlüssel hat sich geändert", "The host key has changed") : t("Hostschlüssel prüfen", "Check the host key")}</strong>
            <p>
              {test.state === "changed"
                ? t(
                    "Der Server meldet sich mit einem anderen Schlüssel als bisher. Das passiert nach einer Neuinstallation – oder wenn sich jemand dazwischen schaltet. Bis zur Bestätigung wird nichts gesendet.",
                    "The server presents another key than before. That happens after a reinstall – or when someone intercepts the connection. Nothing is sent until you confirm.",
                  )
                : t(
                    "Vergleiche den Fingerabdruck mit dem des Servers (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub). Erst nach der Bestätigung meldet sich Flowplan dort an.",
                    "Compare the fingerprint with the server's (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub). Flowplan signs in only after you confirm.",
                  )}
            </p>
            <dl className="move-facts">
              {test.expected && (
                <>
                  <dt>{t("Bisher", "Before")}</dt>
                  <dd>
                    <code>{test.expected}</code>
                  </dd>
                </>
              )}
              <dt>{t("Jetzt", "Now")}</dt>
              <dd>
                <code>{test.fingerprint}</code>
              </dd>
            </dl>
            <div className="move-inline">
              <button type="button" className={`button ${test.state === "changed" ? "danger" : "primary"}`} disabled={!!busy} onClick={() => void trust(test.fingerprint)}>
                {test.state === "changed" ? t("Neuen Schlüssel annehmen", "Accept the new key") : t("Schlüssel vertrauen", "Trust this key")}
              </button>
              <button type="button" className="button" onClick={() => setTest(null)}>
                {t("Abbrechen", "Cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
      <form
        method="post"
        action="/api/auth/no-script"
        className="setting-row wide move-form sftp-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="sftp-grid">
          <label>
            {t("Server", "Server")}
            <input value={form.host} onChange={(e) => set({ host: e.currentTarget.value })} placeholder="backup.example.org" required autoComplete="off" spellCheck={false} />
          </label>
          <label className="sftp-port">
            {t("Port", "Port")}
            <input type="number" min={1} max={65535} value={form.port} onChange={(e) => set({ port: Number(e.currentTarget.value) || 22 })} required />
          </label>
          <label>
            {t("Benutzer", "User")}
            <input value={form.username} onChange={(e) => set({ username: e.currentTarget.value })} required autoComplete="off" spellCheck={false} />
          </label>
          <label>
            {t("Anmeldung", "Sign-in")}
            <select value={form.auth} onChange={(e) => set({ auth: e.currentTarget.value as Settings["auth"] })}>
              <option value="password">{t("Passwort", "Password")}</option>
              <option value="key">{t("Privater Schlüssel", "Private key")}</option>
            </select>
          </label>
        </div>
        {form.auth === "password" ? (
          <label>
            {t("Passwort", "Password")}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              autoComplete="new-password"
              placeholder={state.settings.hasPassword ? t("Gespeichert – leer lassen zum Behalten", "Saved – leave empty to keep") : ""}
              required={!state.settings.hasPassword}
            />
          </label>
        ) : (
          <>
            <label>
              {t("Privater Schlüssel (OpenSSH oder PEM)", "Private key (OpenSSH or PEM)")}
              <textarea
                className="sftp-key"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.currentTarget.value)}
                spellCheck={false}
                autoComplete="off"
                rows={4}
                placeholder={state.settings.hasPrivateKey ? t("Gespeichert – leer lassen zum Behalten", "Saved – leave empty to keep") : "-----BEGIN OPENSSH PRIVATE KEY-----"}
                required={!state.settings.hasPrivateKey}
              />
            </label>
            <label>
              {t("Passphrase (optional)", "Passphrase (optional)")}
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.currentTarget.value)}
                autoComplete="new-password"
                placeholder={state.settings.hasPassphrase ? t("Gespeichert – leer lassen zum Behalten", "Saved – leave empty to keep") : ""}
              />
            </label>
          </>
        )}
        <div className="sftp-grid">
          <label>
            {t("Ordner auf dem Server", "Folder on the server")}
            <input value={form.directory} onChange={(e) => set({ directory: e.currentTarget.value })} placeholder="flowplan-backups" spellCheck={false} />
          </label>
          <label className="sftp-port">
            {t("Aufbewahren", "Keep")}
            <input type="number" min={1} max={365} value={form.keep} onChange={(e) => set({ keep: Math.min(365, Math.max(1, Number(e.currentTarget.value) || 1)) })} />
          </label>
        </div>
        <small>
          {t(
            "Relativ zum Anmeldeordner oder absolut (/srv/backups). Die neuesten Sicherungen bleiben, ältere werden entfernt.",
            "Relative to the login folder or absolute (/srv/backups). The newest backups stay, older ones are removed.",
          )}
        </small>
        <SwitchRow
          label={t("Dateien mitsichern", "Include files")}
          description={t(
            "Spiegelt die hochgeladenen Dateien nach uploads/ im Ordner; hier gelöschte Dateien verschwinden dort auch.",
            "Mirrors the uploaded files to uploads/ in the folder; files deleted here disappear there as well.",
          )}
          checked={form.uploads}
          onChange={(on) => set({ uploads: on })}
        />
        <SwitchRow
          label={t("SFTP-Ziel aktiv", "SFTP target active")}
          description={t("Mit jeder geplanten Sicherung übertragen.", "Transfer with every scheduled backup.")}
          checked={form.enabled}
          onChange={(on) => set({ enabled: on })}
        />
        {state.settings.hostKey && (
          <small>
            {t("Bestätigter Hostschlüssel:", "Confirmed host key:")} <code>{state.settings.hostKey}</code>
          </small>
        )}
        <div className="move-inline">
          <button type="submit" className="button primary" disabled={!!busy}>
            {busy === "save" ? t("Speichert …", "Saving …") : t("Speichern", "Save")}
          </button>
          {saved && (
            <button type="button" className="button" disabled={!!busy} onClick={() => void check()}>
              <PlugsConnected size={16} aria-hidden /> {busy === "test" ? t("Prüft …", "Checking …") : t("Verbindung testen", "Test connection")}
            </button>
          )}
          {saved && (
            <button
              type="button"
              className="button"
              disabled={!!busy}
              onClick={async () => {
                if (!confirm(t("SFTP-Ziel entfernen? Die Sicherungen auf dem Server bleiben.", "Remove the SFTP target? The backups on the server stay."))) return;
                const next = await act("remove", { action: "remove" });
                if (next) {
                  setForm(next.settings);
                  setTest(null);
                }
              }}
            >
              {t("Entfernen", "Remove")}
            </button>
          )}
        </div>
      </form>
    </SettingGroup>
  );
}
