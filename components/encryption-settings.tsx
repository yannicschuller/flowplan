"use client";
// Administration → Verschlüsselung: the key in use, what in the bucket is
// still plain, and what leaves the server unencrypted regardless
// (Litestream replica, Git push).
import { useState } from "react";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { api } from "./ui";
import { SaveState, SettingGroup, SettingRow, StatusBadge, useSaveState } from "./settings-ui";

export type EncryptionStatus = {
  enabled: boolean;
  keyId: string | null;
  previous: string[];
  problem: string | null;
  bucket: boolean;
  objects: { files: number; behind: number } | null;
  litestream: boolean;
  litestreamSseC: boolean;
  git: boolean;
};

export function EncryptionSettings({ status, onChange }: { status: EncryptionStatus; onChange: () => void; onError?: (message: string) => void }) {
  const t = useT();
  const [saving, run] = useSaveState();
  const [note, setNote] = useState("");
  const objects = status.objects;
  return (
    <div className="encryption-settings">
      <SettingGroup
        id="key"
        title={t("Schlüssel", "Key")}
        description={
          status.enabled
            ? t(
                "Dateien im Bucket, geplante Sicherungen, Markdown-Exporte und die heruntergeladene Instanzsicherung werden mit AES-256-GCM verschlüsselt, bevor sie den Server verlassen. Ohne den Schlüssel sind sie nicht lesbar – bewahre ihn getrennt von den Sicherungen auf.",
                "Files in the bucket, scheduled backups, Markdown exports and the downloaded instance backup are encrypted with AES-256-GCM before they leave the server. Without the key they cannot be read – keep it apart from the backups.",
              )
            : t(
                "Aus. Mit FLOWPLAN_ENCRYPTION_KEY (32 Bytes, base64, z. B. aus openssl rand -base64 32) verschlüsselt Flowplan alles, was es in den Bucket legt, sowie Sicherungen und Exporte, bevor es den Server verlässt. Bestehende Daten bleiben lesbar und werden auf Wunsch nachträglich verschlüsselt.",
                "Off. With FLOWPLAN_ENCRYPTION_KEY (32 bytes, base64, e.g. from openssl rand -base64 32) Flowplan encrypts everything it puts into the bucket, and backups and exports, before it leaves the server. Existing data stays readable and can be encrypted afterwards.",
              ) + (!status.bucket ? t(" Ohne S3 betrifft das die Sicherungen und Exporte im Datenordner.", " Without S3 this applies to the backups and exports in the data folder.") : "")
        }
        actions={
          status.problem ? (
            <StatusBadge tone="error">{t("Problem", "Problem")}</StatusBadge>
          ) : status.enabled ? (
            <StatusBadge tone="ok">{t("Verschlüsselung an", "Encryption on")}</StatusBadge>
          ) : (
            <StatusBadge tone="off">{t("Aus", "Off")}</StatusBadge>
          )
        }
      >
        {status.problem && (
          <SettingRow label={t("Problem", "Problem")}>
            <span className="error">{serverMessage(status.problem)}</span>
          </SettingRow>
        )}
        {status.enabled && (
          <>
            <SettingRow label={t("Schlüssel-ID", "Key ID")} description={t("Aus FLOWPLAN_ENCRYPTION_KEY.", "From FLOWPLAN_ENCRYPTION_KEY.")}>
              <code>{status.keyId}</code>
            </SettingRow>
            {status.previous.length > 0 && (
              <SettingRow label={t("Frühere Schlüssel", "Earlier keys")} description={t("Nur zum Lesen älterer Daten.", "Only for reading older data.")}>
                <span className="admin-break">
                  {status.previous.map((id) => (
                    <code key={id}>{id} </code>
                  ))}
                </span>
              </SettingRow>
            )}
          </>
        )}
      </SettingGroup>
      {status.enabled && objects && (
        <SettingGroup id="bucket" title={t("Dateien im Bucket", "Files in the bucket")}>
          <SettingRow
            label={t("Verschlüsselt", "Encrypted")}
            description={
              note ||
              (objects.files === 0
                ? t("Noch keine Dateien im Bucket.", "No files in the bucket yet.")
                : objects.behind === 0
                  ? t(`Alle ${objects.files} Dateien im Bucket sind verschlüsselt.`, `All ${objects.files} files in the bucket are encrypted.`)
                  : t(
                      `${objects.behind} von ${objects.files} Dateien im Bucket sind noch nicht mit diesem Schlüssel verschlüsselt (von vorher oder mit einem früheren Schlüssel).`,
                      `${objects.behind} of ${objects.files} files in the bucket are not yet encrypted with this key (from before, or with an earlier key).`,
                    ))
            }
          >
            <SaveState status={saving} />
            {objects.behind > 0 ? (
              <button
                type="button"
                className="button"
                disabled={saving.state === "saving"}
                onClick={() =>
                  void run(async () => {
                    setNote("");
                    const r = await api<{ queued: number }>("/api/admin/encrypt-existing", {});
                    setNote(t(`${r.queued} Dateien werden im Hintergrund verschlüsselt hochgeladen.`, `${r.queued} files are being uploaded encrypted in the background.`));
                    onChange();
                  })
                }
              >
                {t("Bestehende verschlüsseln", "Encrypt existing objects")}
              </button>
            ) : (
              <StatusBadge tone="ok">{t("Alle", "All")}</StatusBadge>
            )}
          </SettingRow>
        </SettingGroup>
      )}
      {status.enabled && (status.litestream || status.git) && (
        <SettingGroup id="plain" title={t("Was unverschlüsselt hinausgeht", "What leaves unencrypted")}>
          {status.litestream && (
            <SettingRow
              label="Litestream"
              description={
                status.litestreamSseC ? (
                  t(
                    "Der Speicheranbieter verschlüsselt die Datenbank-Kopie (SSE-C). Den Schlüssel bekommt er bei jeder Anfrage mit.",
                    "The storage provider encrypts the database replica (SSE-C). It receives the key with every request.",
                  )
                ) : (
                  <span className="callout warning">
                    {t(
                      "Litestream legt die Datenbank laufend unverschlüsselt in den Bucket (Ordner db/); Litestream 0.5 kann nicht selbst verschlüsseln. Für einen Bucket, dem du nicht traust: FLOWPLAN_LITESTREAM=off setzen und unter Speicher & Sicherung „Stündlich statt täglich“ einschalten – dann liegt die Datenbank nur verschlüsselt im Bucket.",
                      "Litestream keeps putting the database unencrypted into the bucket (folder db/); Litestream 0.5 cannot encrypt by itself. For a bucket you do not trust: set FLOWPLAN_LITESTREAM=off and turn on “Hourly instead of daily” under Storage & backup – then the database is only in the bucket encrypted.",
                    )}{" "}
                    <a href="#admin/storage/backup">{t("Zu den Sicherungen", "To the backups")}</a>
                  </span>
                )
              }
            >
              <StatusBadge tone={status.litestreamSseC ? "ok" : "warn"}>{status.litestreamSseC ? "SSE-C" : t("Unverschlüsselt", "Unencrypted")}</StatusBadge>
            </SettingRow>
          )}
          {status.git && (
            <SettingRow label={t("Git-Export", "Git export")} description={t("Überträgt lesbares Markdown und ist nicht verschlüsselt.", "Pushes readable Markdown and is not encrypted.")}>
              <StatusBadge tone="warn">{t("Unverschlüsselt", "Unencrypted")}</StatusBadge>
            </SettingRow>
          )}
        </SettingGroup>
      )}
    </div>
  );
}
