"use client";
// "Restore from a backup" on the setup screen of a new instance (#128,
// lib/setup-restore.ts): upload a backup file, or fetch the newest one from
// an S3 bucket or SFTP server, with the key when it is encrypted. Only
// offered while the instance has no account; the setup link's token (when
// FLOWPLAN_SETUP_TOKEN is set) goes along with every request.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle, CloudArrowDown, ShieldCheck, SpinnerGap, UploadSimple } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { RestoreProgress, RestoreResult } from "@/lib/setup-restore";
import { useT } from "./i18n";

type Source = "file" | "s3" | "sftp";
const ENDPOINT = "/api/setup/restore";

const size = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function SetupRestore({ onCancel }: { onCancel: () => void }) {
  const t = useT();
  const [source, setSource] = useState<Source>("file");
  const [key, setKey] = useState("");
  const [askKey, setAskKey] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState<{ done: number; total: number } | null>(null);
  const [progress, setProgress] = useState<RestoreProgress | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [fingerprint, setFingerprint] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const setup = useRef("");
  useEffect(() => {
    setup.current = new URLSearchParams(location.search).get("setup") || "";
  }, []);
  const headers = useCallback((extra: Record<string, string> = {}) => ({ "X-Flowplan-Setup": setup.current, ...extra }), []);
  const fail = (message: string, needsKey = false) => {
    setError(message);
    setBusy(false);
    if (needsKey) setAskKey(true);
  };
  // Asked for the key: the field takes the focus once it is enabled again.
  useEffect(() => {
    if (askKey && !busy) keyInput.current?.focus();
  }, [askKey, busy, error]);

  // A restore from S3 or SFTP runs on the server: its progress every second.
  const running = !!progress && progress.phase !== "done" && progress.phase !== "error";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      try {
        const r = await fetch(ENDPOINT, { headers: headers(), cache: "no-store" });
        const data = await r.json();
        if (!r.ok) return fail(serverMessage(data.error));
        const next = data.progress as RestoreProgress | null;
        setProgress(next);
        if (next?.phase === "done") {
          setResult(next.result);
          setBusy(false);
        } else if (next?.phase === "error") fail(serverMessage(next.error || ""), next.needsKey);
      } catch {}
    }, 1000);
    return () => clearInterval(timer);
  }, [running, headers]);

  const upload = (file: File) => {
    setError("");
    setBusy(true);
    setUploaded({ done: 0, total: file.size });
    // XMLHttpRequest for the upload's progress; the file is streamed.
    const xhr = new XMLHttpRequest();
    xhr.open("POST", ENDPOINT);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    for (const [name, value] of Object.entries(headers({ "X-Flowplan-Backup-Key": key.trim(), "X-Flowplan-File-Name": encodeURIComponent(file.name) }))) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => setUploaded({ done: e.loaded, total: e.total || file.size });
    xhr.onload = () => {
      let data: { result?: RestoreResult; error?: string; needsKey?: boolean } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      setUploaded(null);
      if (xhr.status >= 200 && xhr.status < 300 && data.result) {
        setResult(data.result);
        setBusy(false);
      } else fail(serverMessage(data.error || t("Wiederherstellung fehlgeschlagen.", "Restore failed.")), data.needsKey);
    };
    xhr.onerror = () => {
      setUploaded(null);
      fail(t("Keine Verbindung – bitte erneut versuchen.", "No connection – try again."));
    };
    xhr.send(file);
  };

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch(ENDPOINT, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(serverMessage(data.error) || r.statusText), { needsKey: !!data.needsKey });
    return data;
  };
  const target = (form: HTMLFormElement) => {
    const value = (name: string) => String(new FormData(form).get(name) ?? "");
    return source === "s3"
      ? { endpoint: value("endpoint"), bucket: value("bucket"), region: value("region"), prefix: value("prefix"), accessKeyId: value("accessKeyId"), secretAccessKey: value("secretAccessKey") }
      : {
          host: value("host"),
          port: Number(value("port")) || 22,
          username: value("username"),
          password: value("password"),
          privateKey: value("privateKey"),
          passphrase: value("passphrase"),
          directory: value("directory"),
          fingerprint,
        };
  };
  const remote = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (source === "sftp" && !(fingerprint && confirmed)) {
        const data = await post({ action: "probe-sftp", target: target(e.currentTarget) });
        setFingerprint(String(data.fingerprint));
        setConfirmed(false);
        setBusy(false);
        return;
      }
      const data = await post({ action: source, target: target(e.currentTarget), key: key.trim() });
      setProgress(data.progress);
    } catch (err) {
      fail((err as Error).message, (err as { needsKey?: boolean }).needsKey);
    }
  };

  if (result)
    return (
      <div className="setup-restore" role="status">
        <p className="setup-restore-done">
          <CheckCircle size={22} weight="fill" aria-hidden />
          {result.restart ? t("Sicherung geprüft – fast fertig.", "Backup checked – almost done.") : t("Wiederhergestellt.", "Restored.")}
        </p>
        <p>
          {result.createdAt ? `${t("Stand vom", "State of")} ${new Date(result.createdAt).toLocaleString(LOCALE_TAG)}: ` : ""}
          {t(
            `${result.users} Konten, ${result.workspaces} Arbeitsbereiche, ${result.pages} Seiten, ${result.files} Dateien.`,
            `${result.users} accounts, ${result.workspaces} workspaces, ${result.pages} pages, ${result.files} files.`,
          )}
        </p>
        {result.missingFiles > 0 && (
          <p className="callout">
            {t(
              `${result.missingFiles} Dateien fehlten am Ziel. Mit denselben S3_*-Variablen holt Flowplan sie aus dem Bucket nach.`,
              `${result.missingFiles} files were missing at the target. With the same S3_* variables, Flowplan fetches them from the bucket later.`,
            )}
          </p>
        )}
        {result.restart && (
          <p className="callout">
            {t(
              "Litestream läuft: Bitte den Container jetzt neu starten (docker compose restart). Beim Start wird die Sicherung übernommen.",
              "Litestream is running: please restart the container now (docker compose restart). The backup is applied on start.",
            )}
          </p>
        )}
        {result.keyHint && (
          <p className="callout">
            {t(
              "Trage den eingegebenen Schlüssel als FLOWPLAN_ENCRYPTION_KEY ein, damit neue Sicherungen wieder verschlüsselt sind und gespeicherte Geheimnisse lesbar bleiben.",
              "Set the key you entered as FLOWPLAN_ENCRYPTION_KEY so new backups are encrypted again and stored secrets stay readable.",
            )}
          </p>
        )}
        {!result.restart && (
          <a className="button primary wide" href="/login">
            {t("Mit einem Konto der Sicherung anmelden", "Sign in with an account of the backup")}
          </a>
        )}
      </div>
    );

  const share = uploaded ? (uploaded.total ? uploaded.done / uploaded.total : 0) : progress && progress.bytesTotal ? progress.bytesDone / progress.bytesTotal : 0;
  const phase = uploaded
    ? uploaded.done < uploaded.total
      ? t("Wird hochgeladen …", "Uploading …")
      : t("Wird geprüft …", "Checking …")
    : progress
      ? {
          connect: t("Verbindet …", "Connecting …"),
          download: t("Lädt die Sicherung …", "Downloading the backup …"),
          check: t("Wird geprüft …", "Checking …"),
          files: t(`Dateien ${progress.filesDone} / ${progress.filesTotal}`, `Files ${progress.filesDone} / ${progress.filesTotal}`),
          apply: t("Wird übernommen …", "Applying …"),
          done: t("Fertig", "Done"),
          error: t("Fehlgeschlagen", "Failed"),
        }[progress.phase]
      : "";
  return (
    <div className="setup-restore">
      <p>
        {t(
          "Übernimm eine bestehende Instanz: eine geplante Sicherung (.sqlite, .sqlite.enc) oder die Sicherung der gesamten Instanz (.zip, .zip.enc) – hochgeladen oder direkt aus S3 oder per SFTP. Danach meldest du dich mit den Konten der Sicherung an.",
          "Take over an existing instance: a scheduled backup (.sqlite, .sqlite.enc) or the backup of the whole instance (.zip, .zip.enc) – uploaded or straight from S3 or via SFTP. Afterwards you sign in with the accounts of the backup.",
        )}
      </p>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <div className="setup-restore-tabs" role="tablist" aria-label={t("Woher die Sicherung kommt", "Where the backup comes from")}>
        {(
          [
            ["file", t("Datei", "File")],
            ["s3", "S3"],
            ["sftp", "SFTP"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={source === value}
            className={source === value ? "active" : ""}
            disabled={busy}
            onClick={() => {
              setSource(value);
              setError("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <label className={askKey ? "setup-restore-key asked" : "setup-restore-key"}>
        {askKey ? t("Schlüssel der Sicherung", "Key of the backup") : t("Schlüssel, falls verschlüsselt (optional)", "Key if encrypted (optional)")}
        <input
          ref={keyInput}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.currentTarget.value)}
          placeholder="FLOWPLAN_ENCRYPTION_KEY"
          disabled={busy}
        />
      </label>
      {source === "file" ? (
        <label className={`button primary wide file-label${busy ? " disabled" : ""}`}>
          {busy ? <SpinnerGap className="spin" aria-hidden /> : <UploadSimple size={18} aria-hidden />}
          {busy ? t("Läuft …", "Working …") : t("Sicherung auswählen", "Choose backup")}
          <input
            type="file"
            accept=".sqlite,.enc,.zip,application/zip,application/octet-stream"
            hidden
            aria-label={t("Sicherung hochladen", "Upload backup")}
            disabled={busy}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) upload(file);
            }}
          />
        </label>
      ) : (
        <form method="post" action="/api/auth/no-script" className="login-form setup-restore-form" onSubmit={remote} key={source}>
          {source === "s3" ? (
            <>
              <label>
                {t("Adresse (Endpoint)", "Address (endpoint)")}
                <input name="endpoint" type="url" required placeholder="https://s3.eu-central-1.amazonaws.com" />
              </label>
              <label>
                Bucket
                <input name="bucket" required />
              </label>
              <div className="setup-restore-row">
                <label>
                  {t("Region", "Region")}
                  <input name="region" placeholder="us-east-1" />
                </label>
                <label>
                  {t("Ordner (Präfix)", "Folder (prefix)")}
                  <input name="prefix" defaultValue="flowplan" />
                </label>
              </div>
              <label>
                {t("Zugangsschlüssel (Access Key ID)", "Access key ID")}
                <input name="accessKeyId" required autoComplete="off" spellCheck={false} />
              </label>
              <label>
                {t("Geheimer Schlüssel", "Secret access key")}
                <input name="secretAccessKey" type="password" required autoComplete="off" />
              </label>
            </>
          ) : (
            <>
              <div className="setup-restore-row">
                <label>
                  {t("Server", "Server")}
                  <input name="host" required spellCheck={false} onChange={() => setFingerprint("")} />
                </label>
                <label className="setup-restore-port">
                  Port
                  <input name="port" type="number" min={1} max={65535} defaultValue={22} onChange={() => setFingerprint("")} />
                </label>
              </div>
              <label>
                {t("Benutzer", "User")}
                <input name="username" required autoComplete="off" spellCheck={false} />
              </label>
              <label>
                {t("Passwort", "Password")}
                <input name="password" type="password" autoComplete="off" />
              </label>
              <details>
                <summary>{t("Stattdessen mit privatem Schlüssel", "With a private key instead")}</summary>
                <label>
                  {t("Privater Schlüssel", "Private key")}
                  <textarea name="privateKey" rows={3} spellCheck={false} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                </label>
                <label>
                  {t("Passphrase (optional)", "Passphrase (optional)")}
                  <input name="passphrase" type="password" autoComplete="off" />
                </label>
              </details>
              <label>
                {t("Ordner auf dem Server", "Folder on the server")}
                <input name="directory" defaultValue="flowplan-backups" spellCheck={false} />
              </label>
              {fingerprint && (
                <div className="setup-restore-hostkey">
                  <ShieldCheck size={18} aria-hidden />
                  <div>
                    <small>{t("Hostschlüssel des Servers – vergleiche ihn, bevor du dich anmeldest:", "The server's host key – compare it before you sign in:")}</small>
                    <code>{fingerprint}</code>
                    <label className="setup-restore-confirm">
                      <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.currentTarget.checked)} />
                      {t("Der Fingerabdruck stimmt", "The fingerprint matches")}
                    </label>
                  </div>
                </div>
              )}
            </>
          )}
          <button className="button primary wide" disabled={busy || (source === "sftp" && !!fingerprint && !confirmed)}>
            {busy ? <SpinnerGap className="spin" aria-hidden /> : source === "sftp" && !fingerprint ? <ShieldCheck size={18} aria-hidden /> : <CloudArrowDown size={18} aria-hidden />}
            {source === "sftp" && !fingerprint ? t("Hostschlüssel prüfen", "Check the host key") : t("Neueste Sicherung holen", "Fetch the newest backup")}
          </button>
        </form>
      )}
      {(uploaded || running) && (
        <div className="move-progress" role="status" aria-live="polite">
          <div className="move-progress-head">
            <span>{phase}</span>
            {uploaded ? <span>{`${size(uploaded.done)} / ${size(uploaded.total)}`}</span> : progress && progress.bytesTotal ? <span>{`${size(progress.bytesDone)} / ${size(progress.bytesTotal)}`}</span> : null}
          </div>
          <span className="admin-usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={t("Fortschritt", "Progress")}>
            <span style={{ width: `${Math.max(2, share * 100)}%` }} />
          </span>
        </div>
      )}
      <small className="muted">
        {t(
          "Gespeicherte Geheimnisse (Authenticator-Apps, API-Schlüssel) lassen sich nur mit demselben FLOWPLAN_ENCRYPTION_KEY oder FLOWPLAN_SECRETS_KEY lesen wie vorher.",
          "Stored secrets (authenticator apps, API keys) can only be read with the same FLOWPLAN_ENCRYPTION_KEY or FLOWPLAN_SECRETS_KEY as before.",
        )}
      </small>
      <p className="login-switch">
        <button type="button" className="text-button" onClick={onCancel} disabled={busy}>
          {t("Zurück zum ersten Konto", "Back to the first account")}
        </button>
      </p>
    </div>
  );
}
