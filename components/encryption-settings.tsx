"use client";
// Admin → Versions and backup → Encryption: the key in use, what in the
// bucket is still plain, and what leaves the server unencrypted regardless
// (Litestream replica, Git push).
import { useState } from "react";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { api } from "./ui";

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

export function EncryptionSettings({ status, onChange, onError }: { status: EncryptionStatus; onChange: () => void; onError: (message: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const objects = status.objects;
  return (
    <section className="settings-section encryption-settings">
      <h2>{t("Verschlüsselung", "Encryption")}</h2>
      {status.problem && <p className="error">{serverMessage(status.problem)}</p>}
      {status.enabled ? (
        <>
          <p>
            <strong>{t("Verschlüsselung an", "Encryption on")}</strong> · {t("Schlüssel-ID", "Key ID")} <code>{status.keyId}</code>
            {status.previous.length > 0 && (
              <>
                {" "}
                · {t("frühere Schlüssel zum Lesen:", "earlier keys for reading:")} {status.previous.map((id) => <code key={id}>{id} </code>)}
              </>
            )}
          </p>
          <p className="muted">
            {t(
              "Dateien im Bucket, geplante Sicherungen, Markdown-Exporte und die heruntergeladene Instanzsicherung werden mit AES-256-GCM verschlüsselt, bevor sie den Server verlassen. Ohne den Schlüssel sind sie nicht lesbar – bewahre ihn getrennt von den Sicherungen auf.",
              "Files in the bucket, scheduled backups, Markdown exports and the downloaded instance backup are encrypted with AES-256-GCM before they leave the server. Without the key they cannot be read – keep it apart from the backups.",
            )}
          </p>
          {objects && (
            <p>
              {objects.files === 0
                ? t("Noch keine Dateien im Bucket.", "No files in the bucket yet.")
                : objects.behind === 0
                ? t(`Alle ${objects.files} Dateien im Bucket sind verschlüsselt.`, `All ${objects.files} files in the bucket are encrypted.`)
                : t(
                    `${objects.behind} von ${objects.files} Dateien im Bucket sind noch nicht mit diesem Schlüssel verschlüsselt (von vorher oder mit einem früheren Schlüssel).`,
                    `${objects.behind} of ${objects.files} files in the bucket are not yet encrypted with this key (from before, or with an earlier key).`,
                  )}{" "}
              {objects.behind > 0 && (
                <button
                  type="button"
                  className="button compact"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setNote("");
                    try {
                      const r = await api<{ queued: number }>("/api/admin/encrypt-existing", {});
                      setNote(t(`${r.queued} Dateien werden im Hintergrund verschlüsselt hochgeladen.`, `${r.queued} files are being uploaded encrypted in the background.`));
                      onChange();
                    } catch (e) {
                      onError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {t("Bestehende verschlüsseln", "Encrypt existing objects")}
                </button>
              )}
            </p>
          )}
          {note && <p role="status" className="muted">{note}</p>}
          {status.litestream && (
            <p className={status.litestreamSseC ? "muted" : "callout warning"}>
              {status.litestreamSseC
                ? t(
                    "Litestream: Der Speicheranbieter verschlüsselt die Datenbank-Kopie (SSE-C). Den Schlüssel bekommt er bei jeder Anfrage mit.",
                    "Litestream: the storage provider encrypts the database replica (SSE-C). It receives the key with every request.",
                  )
                : t(
                    "Litestream legt die Datenbank laufend unverschlüsselt in den Bucket (Ordner db/). Litestream 0.5 kann nicht selbst verschlüsseln. Für einen Bucket, dem du nicht traust: FLOWPLAN_LITESTREAM=off setzen und oben bei „Versionen und Sicherung“ die Option „Stündlich statt täglich“ einschalten – dann liegt die Datenbank nur verschlüsselt im Bucket.",
                    "Litestream keeps putting the database unencrypted into the bucket (folder db/). Litestream 0.5 cannot encrypt by itself. For a bucket you do not trust: set FLOWPLAN_LITESTREAM=off and turn on “Hourly instead of daily” above under “Versions and backup” – then the database is only in the bucket encrypted.",
                  )}
            </p>
          )}
          {status.git && (
            <p className="muted">
              {t(
                "Der Git-Export (unten) überträgt lesbares Markdown und ist nicht verschlüsselt.",
                "The Git export (below) pushes readable Markdown and is not encrypted.",
              )}
            </p>
          )}
        </>
      ) : (
        <p className="muted">
          {t("Aus. Mit", "Off. With")} <code>FLOWPLAN_ENCRYPTION_KEY</code> {t("(32 Bytes, base64, z. B. aus", "(32 bytes, base64, e.g. from")} <code>openssl rand -base64 32</code>){" "}
          {t(
            "verschlüsselt Flowplan alles, was es in den Bucket legt, sowie Sicherungen und Exporte, bevor es den Server verlässt. Bestehende Daten bleiben lesbar und werden auf Wunsch nachträglich verschlüsselt.",
            "Flowplan encrypts everything it puts into the bucket, and backups and exports, before it leaves the server. Existing data stays readable and can be encrypted afterwards.",
          )}
          {!status.bucket && t(" (Ohne S3 betrifft das die Sicherungen und Exporte im Datenordner.)", " (Without S3 this applies to the backups and exports in the data folder.)")}
        </p>
      )}
    </section>
  );
}
