"use client";
// Administration → Instanz → Einstellungen exportieren / importieren (#447):
// the instance settings file (lib/settings-file.ts) – instance, AI and
// limits in one JSON file without secrets. Export, paste or open a file,
// "Prüfen" lists every change and every error, "Übernehmen" applies them
// all at once. Built like the limits file (./limits-file.tsx) and shares
// its wording of the limits' changes and errors.
import { useState } from "react";
import { DownloadSimple, UploadSimple } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { SettingGroup } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { SecretPath, SettingsChange, SettingsImportResult, SettingsIssue } from "@/lib/settings-file";
import { changeText, issueText } from "./limits-file";

type T = ReturnType<typeof useT>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// A value of the file in plain words.
function valueText(t: T, v: unknown): string {
  if (v === null || v === undefined) return t("nicht festgelegt", "not set");
  if (typeof v === "boolean") return v ? t("an", "on") : t("aus", "off");
  if (typeof v === "number") return v.toLocaleString(LOCALE_TAG);
  if (typeof v === "string") return v === "" ? t("leer", "empty") : t(`„${v}“`, `“${v}”`);
  if (isObj(v) && typeof v.set === "boolean" && Object.keys(v).length === 1) return v.set ? t("gesetzt", "set") : t("nicht gesetzt", "not set");
  const json = JSON.stringify(v);
  return json.length > 160 ? `${json.slice(0, 157)}…` : json;
}
export function settingsChangeText(t: T, c: SettingsChange): string {
  if (c.section === "limits") return t(`Grenzen: ${changeText(t, c.change)}`, `Limits: ${changeText(t, c.change)}`);
  if (c.before === null && c.after !== null) return t(`${c.path}: neu, ${valueText(t, c.after)}`, `${c.path}: new, ${valueText(t, c.after)}`);
  if (c.after === null && c.before !== null && typeof c.before === "object") return t(`${c.path}: entfernt (war ${valueText(t, c.before)})`, `${c.path}: removed (was ${valueText(t, c.before)})`);
  return `${c.path}: ${valueText(t, c.before)} → ${valueText(t, c.after)}`;
}
function secretText(t: T, path: SecretPath): string {
  switch (path) {
    case "ai.apiKey":
      return t("API-Schlüssel des KI-Anbieters (Einstellungen → Instanz → KI)", "API key of the AI provider (Settings → Instance → AI)");
    case "instance.sftpBackup.password":
      return t("Passwort des SFTP-Ziels (Speicher & Sicherung)", "Password of the SFTP target (Storage & backup)");
    case "instance.sftpBackup.privateKey":
      return t("Privater Schlüssel des SFTP-Ziels (Speicher & Sicherung)", "Private key of the SFTP target (Storage & backup)");
    case "instance.sftpBackup.passphrase":
      return t("Passphrase des SFTP-Schlüssels (Speicher & Sicherung)", "Passphrase of the SFTP key (Storage & backup)");
  }
}
export function settingsIssueText(t: T, e: SettingsIssue): string {
  const where = e.path || t("Datei", "file");
  const list = e.allowed?.length ? e.allowed.join(", ") : t("keine", "none");
  switch (e.code) {
    case "secret_value":
      return t(
        `${where}: hier darf kein Geheimnis stehen – nur {"set": true} oder {"set": false}. Trag es auf der Instanz selbst ein.`,
        `${where}: no secret may be here – only {"set": true} or {"set": false}. Enter it on the instance itself.`,
      );
    case "rejected":
      return t(`${where}: abgelehnt – ${e.message ?? ""}`, `${where}: refused – ${e.message ?? ""}`);
    case "limits_file":
      return t(
        "Das ist eine Datei mit Grenzen – importiere sie unter Grenzen & Aufbewahrung → Export / Import, oder nimm sie hier als „limits“ in eine Einstellungsdatei auf.",
        "This is a limits file – import it under Limits & retention → Export / import, or put it into a settings file here as “limits”.",
      );
    case "too_large":
      return t("Die Datei ist zu groß (höchstens 1 MB).", "The file is too large (at most 1 MB).");
    case "too_small":
      return t(`${where}: zu klein (mindestens ${(e.min ?? 0).toLocaleString(LOCALE_TAG)})`, `${where}: too small (at least ${(e.min ?? 0).toLocaleString(LOCALE_TAG)})`);
    case "invalid":
      return e.allowed?.length ? t(`${where}: ungültig – erlaubt: ${list}`, `${where}: invalid – allowed: ${list}`) : issueText(t, e);
    case "needs_secret":
      return t(
        `${where}: nicht übernommen – auf dieser Instanz fehlt das Geheimnis für die Anmeldung (${e.value}). Richte das SFTP-Ziel unter Speicher & Sicherung ein.`,
        `${where}: not taken over – this instance lacks the secret to sign in (${e.value}). Set up the SFTP target under Storage & backup.`,
      );
    default:
      return issueText(t, e);
  }
}

export function SettingsFile() {
  const t = useT();
  const { mutate, onError, load } = useAdminData();
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<{ text: string; result: SettingsImportResult } | null>(null);
  const [applied, setApplied] = useState<SettingsImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRun = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const exportFile = () =>
    busyRun(async () => {
      const file = await mutate({ action: "admin.settingsExport" });
      const json = JSON.stringify(file, null, 2);
      setText(json);
      setChecked(null);
      setApplied(null);
      const url = URL.createObjectURL(new Blob([json + "\n"], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      const host = window.location.host.replace(/[^A-Za-z0-9.-]+/g, "-") || "instance";
      a.download = `flowplan-settings-${host}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  const check = () =>
    busyRun(async () => {
      setApplied(null);
      const result = (await mutate({ action: "admin.settingsImport", file: text, dryRun: true })) as SettingsImportResult;
      setChecked({ text, result });
    });
  const apply = () => {
    if (!checked || checked.text !== text || !checked.result.ok) return;
    const n = checked.result.changes.length;
    if (!window.confirm(t(`${n} Änderungen jetzt übernehmen? Alle oder keine werden gespeichert.`, `Apply ${n} changes now? All or none are saved.`))) return;
    void busyRun(async () => {
      const result = (await mutate({ action: "admin.settingsImport", file: text, dryRun: false })) as SettingsImportResult;
      setApplied(result);
      setChecked(null);
      await load();
    });
  };
  const current = checked && checked.text === text ? checked.result : null;
  return (
    <SettingGroup
      id="settings-file"
      title={t("Einstellungen exportieren / importieren", "Export / import settings")}
      description={t(
        "Die Einstellungen der Instanz, der KI und die Grenzen als eine JSON-Datei – um sie auf eine andere Instanz zu übertragen, aufzubewahren oder nach einem Fehler wiederherzustellen. Passwörter und Schlüssel stehen nie darin, nur ob einer gesetzt ist. Anmeldung & SSO, Arbeitsbereiche und Konten gehören nicht dazu. „Prüfen“ zeigt jede Änderung, ohne etwas zu speichern; „Übernehmen“ speichert alle auf einmal. Was nicht in der Datei steht, bleibt, wie es ist.",
        "The instance's settings, the AI settings and the limits as one JSON file – to move them to another instance, keep them or restore them after a mistake. Passwords and keys are never in it, only whether one is set. Sign-in & SSO, workspaces and accounts are not part of it. “Check” shows every change without saving anything; “Apply” saves all of them at once. What is not in the file stays as it is.",
      )}
    >
      <div className="setting-row wide limits-file">
        <div className="limits-file-actions">
          <button type="button" className="button" disabled={busy} onClick={() => void exportFile()}>
            <DownloadSimple size={16} aria-hidden />
            {t("Exportieren", "Export")}
          </button>
          <label className={`button file-label${busy ? " disabled" : ""}`}>
            <UploadSimple size={16} aria-hidden />
            {t("Datei öffnen", "Open file")}
            <input
              type="file"
              accept=".json,application/json"
              hidden
              aria-label={t("Datei mit Einstellungen öffnen", "Open a file with settings")}
              disabled={busy}
              onChange={async (e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (!file) return;
                setText(await file.text());
                setChecked(null);
                setApplied(null);
              }}
            />
          </label>
        </div>
        <label className="limits-file-label">
          {t("Einstellungsdatei (JSON)", "Settings file (JSON)")}
          <textarea
            className="limits-file-text"
            rows={12}
            spellCheck={false}
            autoComplete="off"
            value={text}
            placeholder={'{ "format": "flowplan-settings", "version": 1, "instance": { … }, "ai": { … }, "limits": { … } }'}
            onChange={(e) => {
              setText(e.currentTarget.value);
              setApplied(null);
            }}
          />
        </label>
        <div className="limits-file-actions">
          <button type="button" className="button" disabled={busy || !text.trim()} onClick={() => void check()}>
            {t("Prüfen", "Check")}
          </button>
          <button type="button" className="button primary" disabled={busy || !current?.ok || !current.changes.length} onClick={apply}>
            {t("Übernehmen", "Apply")}
          </button>
        </div>
        {current && (
          <div className="limits-file-result" role="status" aria-label={t("Ergebnis der Prüfung", "Result of the check")}>
            {!current.ok ? (
              <>
                <p className="limits-file-head" data-tone="error">
                  {t(`Die Datei enthält ${current.errorCount} Fehler – nichts wird geändert:`, `The file has ${current.errorCount} error(s) – nothing will be changed:`)}
                </p>
                <ul className="limits-file-list">
                  {current.errors.map((e, i) => (
                    <li key={i}>{settingsIssueText(t, e)}</li>
                  ))}
                </ul>
              </>
            ) : current.changes.length ? (
              <>
                <p className="limits-file-head">{t(`${current.changes.length} Änderungen:`, `${current.changes.length} changes:`)}</p>
                <ul className="limits-file-list">
                  {current.changes.map((c, i) => (
                    <li key={i}>{settingsChangeText(t, c)}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="limits-file-head">{t("Keine Änderungen – alles ist schon so eingestellt.", "No changes – everything is already set this way.")}</p>
            )}
            {current.secrets.length > 0 && (
              <>
                <p className="limits-file-head">{t("Noch einzutragen (stehen nie in der Datei):", "Still to enter (never in the file):")}</p>
                <ul className="limits-file-list" aria-label={t("Noch einzutragen", "Still to enter")}>
                  {current.secrets.map((s) => (
                    <li key={s}>{secretText(t, s)}</li>
                  ))}
                </ul>
              </>
            )}
            {current.notes.length > 0 && (
              <ul className="limits-file-list limits-file-notes">
                {current.notes.map((e, i) => (
                  <li key={i}>{settingsIssueText(t, e)}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {applied && (
          <p className="limits-file-head" role="status" data-tone="ok">
            {applied.applied ? t(`${applied.changes.length} Änderungen übernommen.`, `${applied.changes.length} changes applied.`) : t("Keine Änderungen.", "No changes.")}
          </p>
        )}
      </div>
    </SettingGroup>
  );
}
