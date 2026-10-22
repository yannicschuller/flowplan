"use client";
// Administration → Verschlüsselung: the key for bucket, backups and exports.
import { useT } from "../../i18n";
import { EncryptionSettings } from "../../encryption-settings";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, FixLink, useDocs, type StatusItem } from "./parts";

export default function SecuritySection() {
  const t = useT();
  const docs = useDocs();
  const { data, load } = useAdminData();
  if (!data) return <AdminLoading />;
  const e = data.encryption;
  const items: StatusItem[] = [
    e.problem
      ? {
          tone: "error",
          label: t("Schlüssel nicht lesbar", "Key not readable"),
        }
      : e.enabled
        ? { tone: "ok", label: t("Verschlüsselung an", "Encryption on") }
        : { tone: "off", label: t("Kein Schlüssel", "No key") },
  ];
  if (e.enabled && e.objects?.behind)
    items.push({
      tone: "warn",
      label: t(`${e.objects.behind} Dateien unverschlüsselt`, `${e.objects.behind} files unencrypted`),
    });
  if (e.enabled && e.litestream && !e.litestreamSseC)
    items.push({
      tone: "warn",
      label: t("Litestream unverschlüsselt", "Litestream unencrypted"),
    });
  return (
    <>
      <AdminStatus
        items={items}
        action={
          !e.enabled ? (
            <FixLink
              href={docs("configuration", "verschluesselung", "encryption")}
            >
              {t("So schaltest du sie ein", "How to turn it on")}
            </FixLink>
          ) : undefined
        }
      >
        {e.enabled
          ? t("Was den Server verlässt, ist verschlüsselt – bis auf die unten genannten Ausnahmen.", "What leaves the server is encrypted – except for the exceptions below.")
          : t("Sicherungen, Exporte und Dateien im Bucket verlassen den Server unverschlüsselt.", "Backups, exports and files in the bucket leave the server unencrypted.")}
      </AdminStatus>
      <EncryptionSettings status={e} onChange={load} />
    </>
  );
}
