"use client";
// Administration → Markdown- & Git-Export: chosen pages as Markdown with
// every backup, the Git export of spaces and the deprecated instance Git
// export.
import { useT } from "../../i18n";
import { MarkdownExportSettings } from "../../markdown-export-settings";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, FixLink, type StatusItem } from "./parts";
import { ago } from "./format";

export default function ExportSection() {
  const t = useT();
  const { data, load, onError } = useAdminData();
  if (!data) return <AdminLoading />;
  const m = data.markdownExport;
  const last = m.runs.reduce<(typeof m.runs)[number] | null>((a, r) => (!a || r.at > a.at ? r : a), null);
  const items: StatusItem[] = [
    m.pages.length
      ? {
          tone: "ok",
          label: t(`${m.pages.length} Seiten bei jeder Sicherung`, `${m.pages.length} pages with every backup`),
        }
      : { tone: "off", label: t("Markdown-Export aus", "Markdown export off") },
  ];
  if (last)
    items.push(
      last.error
        ? {
            tone: "error",
            label: t("Letzter Export fehlgeschlagen", "Last export failed"),
          }
        : {
            tone: "ok",
            label: t(`Letzter Export ${ago(last.at, t)}`, `Last export ${ago(last.at, t)}`),
          },
    );
  items.push(
    data.spaceGitExport.enabled
      ? {
          tone: data.spaceGitExport.failing.length ? "error" : "ok",
          label: t("Git-Export der Bereiche an", "Git export of spaces on"),
        }
      : {
          tone: "off",
          label: t("Git-Export der Bereiche aus", "Git export of spaces off"),
        },
  );
  return (
    <>
      <AdminStatus items={items} action={!data.backup.enabled ? <FixLink href="#admin/storage/backup">{t("Geplante Sicherung einschalten", "Turn on the scheduled backup")}</FixLink> : undefined}>
        {data.backup.enabled
          ? t("Der Export läuft mit jeder geplanten Sicherung.", "The export runs with every scheduled backup.")
          : t("Die geplante Sicherung ist aus – ohne sie entsteht kein Export.", "The scheduled backup is off – without it there is no export.")}
      </AdminStatus>
      <MarkdownExportSettings status={m} spaceGit={data.spaceGitExport} onChange={load} onError={onError} />
    </>
  );
}
