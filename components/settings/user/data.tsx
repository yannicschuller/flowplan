"use client";
// Settings → Arbeitsbereich → Import & Export, in four groups:
// Import (a target space for all imports; files, Notion/AppFlowy ZIPs,
// Jira/Trello, Confluence/Evernote/Google Docs/Obsidian with a preview),
// Export (the workspace as ZIP or JSON, a space as Markdown, PDF or EPUB),
// Sicherungen (restoring a Flowplan archive; the instance's backups live in
// the administration) and Papierkorb & Aufbewahrung.
import { useState, type ReactNode } from "react";
import { ArrowRight, DownloadSimple, UploadSimple } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "../../i18n";
import { api, download, downloadBlob } from "../../ui";
import { Select } from "../../select";
import { SpaceExportDialog } from "../../space-export";
import { ImportSources } from "../../import-sources";
import { CONTROL, SettingGroup, SettingRow } from "../../settings-ui";
import { useUserSettings } from "../user-context";

type Result = { tone: "ok" | "error"; text: string } | null;

// What an import or export said, next to its button.
function Outcome({ result }: { result: Result }) {
  return (
    <p role="status" className={`ws-result${result?.tone === "error" ? " error" : ""}`} hidden={!result}>
      {result?.text}
    </p>
  );
}

function FileButton({ label, busyLabel, busy, disabled, accept, multiple, inputLabel, onFiles }: { label: string; busyLabel?: string; busy?: boolean; disabled?: boolean; accept: string; multiple?: boolean; inputLabel?: string; onFiles: (files: File[], input: HTMLInputElement) => void }) {
  return (
    <label className={`button file-label ws-file${disabled || busy ? " disabled" : ""}`}>
      <UploadSimple aria-hidden />
      {busy && busyLabel ? busyLabel : label}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        aria-label={inputLabel}
        disabled={disabled || busy}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files || []);
          if (files.length) onFiles(files, e.currentTarget);
        }}
      />
    </label>
  );
}

function Stack({ children }: { children: ReactNode }) {
  return <div className="ws-stack">{children}</div>;
}

export default function DataSection() {
  const t = useT();
  const { boot, mutate, onError, onRefresh } = useUserSettings();
  const canWrite = boot.workspace.role !== "viewer";
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [spaceExport, setSpaceExport] = useState(false);
  const [trackerBusy, setTrackerBusy] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const [importSpace, setImportSpace] = useState("");
  const [results, setResults] = useState<Record<string, Result>>({});
  const report = (key: string, result: Result) => setResults((all) => ({ ...all, [key]: result }));
  const target = importSpace || boot.spaces[0]?.id || "";
  const fail = (key: string) => (e: unknown) => report(key, { tone: "error", text: (e as Error).message });
  return (
    <>
      <SettingGroup
        id="import"
        title={t("Import", "Import||section")}
        description={canWrite ? t("Inhalte aus Dateien und anderen Werkzeugen übernehmen.", "Bring in content from files and other tools.") : t("Importieren dürfen nur Mitglieder mit Bearbeitungsrechten.", "Only members who may edit can import.")}
      >
        <SettingRow label={t("Zielbereich", "Target space")} id="import-space" description={t("Wohin importierte Seiten und Datenbanken kommen.", "Where imported pages and databases go.")}>
          <Select id="import-space" className={CONTROL.md} aria-label={t("Zielbereich für den Import", "Target space for the import")} value={target} onChange={(e) => setImportSpace(e.target.value)}>
            {boot.spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.name}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          label={t("Notion, AppFlowy oder Markdown-Export (ZIP)", "Notion, AppFlowy or Markdown export (ZIP)")}
          description={t(
            "Markdown wird zu Seiten, CSV zu Datenbanken, Excalidraw- und draw.io-Zeichnungen zu Whiteboards, Ordner zu Unterseiten. Bilder und Dateien, auf die Markdown verweist, werden hochgeladen; Datensatzseiten aus Notion werden den Einträgen zugeordnet. Maximal 100 MB, 500 Seiten und 5.000 Einträge je Tabelle.",
            "Markdown becomes pages, CSV databases, Excalidraw and draw.io drawings whiteboards, folders sub-pages. Images and files referenced in Markdown are uploaded; Notion record pages are matched to their records. At most 100 MB, 500 pages and 5,000 records per table.",
          )}
        >
          <Stack>
            <FileButton
              label={t("ZIP auswählen", "Choose ZIP")}
              busyLabel={t("Import läuft …", "Importing …")}
              busy={zipBusy}
              disabled={!canWrite}
              accept=".zip,application/zip"
              inputLabel={t("Export-ZIP importieren", "Import export ZIP")}
              onFiles={async ([file], input) => {
                input.value = "";
                setZipBusy(true);
                report("zip", null);
                try {
                  const body = new FormData();
                  body.set("workspaceId", boot.workspace.id);
                  body.set("spaceId", target);
                  body.set("file", file);
                  const response = await fetch("/api/import/zip", { method: "POST", body });
                  const result = await response.json();
                  if (!response.ok) throw new Error(serverMessage(result.error) || t("Import fehlgeschlagen.", "Import failed."));
                  report("zip", { tone: "ok", text: t(`${result.pages} Seiten, ${result.rows} Einträge und ${result.files} Dateien importiert.`, `${result.pages} pages, ${result.rows} records and ${result.files} files imported.`) });
                  await onRefresh();
                } catch (e) {
                  fail("zip")(e);
                } finally {
                  setZipBusy(false);
                }
              }}
            />
            <Outcome result={results.zip} />
          </Stack>
        </SettingRow>
        <ImportSources workspaceId={boot.workspace.id} spaces={boot.spaces} spaceId={target} canWrite={canWrite} onRefresh={onRefresh} onError={onError} />
        <SettingRow
          label={t("Jira oder Trello", "Jira or Trello")}
          description={t(
            "Jira: Vorgänge als CSV exportieren (alle Felder). Trello: Board-Menü → Drucken, exportieren und teilen → Als JSON exportieren. Daraus wird eine neue Datenbank mit Status, Priorität, Zuständigen, Labels, Story Points und Unteraufgaben; Beschreibungen werden zum Inhalt, Kommentare zu Kommentaren, Anhänge zu Links.",
            "Jira: export issues as CSV (all fields). Trello: board menu → Print, export and share → Export as JSON. This becomes a new database with status, priority, assignees, labels, story points and subtasks; descriptions become the content, comments comments, attachments links.",
          )}
        >
          <Stack>
            <FileButton
              label={t("CSV oder JSON auswählen", "Choose CSV or JSON")}
              busyLabel={t("Import läuft …", "Importing …")}
              busy={trackerBusy}
              disabled={!canWrite}
              accept=".csv,.json,text/csv,application/json"
              inputLabel={t("Jira- oder Trello-Export importieren", "Import Jira or Trello export")}
              onFiles={async ([file], input) => {
                input.value = "";
                setTrackerBusy(true);
                report("tracker", null);
                try {
                  const body = new FormData();
                  body.set("workspaceId", boot.workspace.id);
                  body.set("spaceId", target);
                  body.set("file", file);
                  const response = await fetch("/api/import/tracker", { method: "POST", body });
                  const result = await response.json();
                  if (!response.ok) throw new Error(serverMessage(result.error) || t("Import fehlgeschlagen.", "Import failed."));
                  await onRefresh();
                  // The new database opens: the note goes with it.
                  onError(t(`${result.rows} Einträge und ${result.comments} Kommentare importiert.`, `${result.rows} records and ${result.comments} comments imported.`));
                  location.hash = `#page=${result.pageId}`;
                } catch (e) {
                  fail("tracker")(e);
                } finally {
                  setTrackerBusy(false);
                }
              }}
            />
            <Outcome result={results.tracker} />
          </Stack>
        </SettingRow>
        <SettingRow label={t("Markdown-, Text- oder HTML-Dateien", "Markdown, text or HTML files")} description={t("Jede Datei wird eine neue Seite im Zielbereich, höchstens 2 MB je Datei.", "Every file becomes a new page in the target space, at most 2 MB per file.")}>
          <Stack>
            <FileButton
              label={t("Dateien auswählen", "Choose files")}
              disabled={!canWrite}
              accept=".md,.txt,.html"
              multiple
              onFiles={async (files, input) => {
                input.value = "";
                let done = 0;
                const errors: string[] = [];
                for (const file of files) {
                  if (file.size > 2_000_000) {
                    errors.push(t(`${file.name}: Datei zu groß (max. 2 MB)`, `${file.name}: file too large (max. 2 MB)`));
                    continue;
                  }
                  try {
                    await mutate({
                      action: "page.import",
                      workspaceId: boot.workspace.id,
                      spaceId: target,
                      title: file.name.replace(/\.[^.]+$/, ""),
                      content: await file.text(),
                      format: file.name.endsWith(".html") ? "html" : file.name.endsWith(".md") ? "markdown" : "text",
                    });
                    done++;
                  } catch (err) {
                    errors.push(`${file.name}: ${(err as Error).message}`);
                  }
                }
                report("files", errors.length ? { tone: "error", text: [done ? t(`${done} Seiten angelegt.`, `${done} pages created.`) : "", ...errors].filter(Boolean).join(" ") } : { tone: "ok", text: done === 1 ? t("1 Seite angelegt.", "1 page created.") : t(`${done} Seiten angelegt.`, `${done} pages created.`) });
              }}
            />
            <Outcome result={results.files} />
          </Stack>
        </SettingRow>
      </SettingGroup>

      <SettingGroup id="export" title={t("Export", "Export||section")} description={t("Eine Kopie von allem, was du lesen darfst – zum Archivieren oder für einen Umzug.", "A copy of everything you may read – to archive or to move.")}>
        <SettingRow
          label={t("Arbeitsbereich als ZIP", "Workspace as ZIP")}
          description={t(
            "Das ZIP-Inhaltsarchiv enthält zugängliche Seiten einschließlich Papierkorb, Datenbanken, interne Verknüpfungen, Seiten- und Datensatzvorlagen, Kommentare, Versionen, Favoriten und hochgeladene Dateien.",
            "The ZIP content archive contains accessible pages including the trash, databases, internal links, page and record templates, comments, versions, favourites and uploaded files.",
          )}
        >
          <Stack>
            <button
              className="button primary"
              disabled={archiveBusy}
              onClick={async () => {
                setArchiveBusy(true);
                report("archive", null);
                try {
                  const response = await fetch(`/api/backup?workspace=${boot.workspace.id}`);
                  if (!response.ok) throw new Error(serverMessage((await response.json()).error));
                  downloadBlob(`flowplan-${new Date().toISOString().slice(0, 10)}.zip`, await response.blob());
                } catch (e) {
                  fail("archive")(e);
                } finally {
                  setArchiveBusy(false);
                }
              }}
            >
              <DownloadSimple aria-hidden />
              {archiveBusy ? t("Archiv wird verarbeitet …", "Processing archive …") : t("ZIP mit Dateien exportieren", "Export ZIP with files")}
            </button>
            <Outcome result={results.archive} />
          </Stack>
        </SettingRow>
        <SettingRow label={t("Arbeitsbereich als JSON", "Workspace as JSON")} description={t("Seiten und Datenbanken ohne Dateien, für Skripte und ältere Importe.", "Pages and databases without files, for scripts and older imports.")}>
          <Stack>
            <button
              className="button"
              onClick={async () => {
                report("json", null);
                try {
                  const data = await api(`/api/export?workspace=${boot.workspace.id}`);
                  download("flowplan-export.json", JSON.stringify(data, null, 2), "application/json");
                } catch (e) {
                  fail("json")(e);
                }
              }}
            >
              <DownloadSimple aria-hidden />
              {t("JSON ohne Dateien exportieren", "Export JSON without files")}
            </button>
            <Outcome result={results.json} />
          </Stack>
        </SettingRow>
        <SettingRow
          label={t("Einen Bereich", "One space")}
          description={t(
            "Eine lesbare Kopie eines Bereichs als Markdown-ZIP, PDF oder E-Book – zum Archivieren, offline Lesen oder für ein eigenes Git-Repository.",
            "A readable copy of a space as a Markdown ZIP, PDF or e-book – to archive, read offline or put into your own Git repository.",
          )}
        >
          <button className="button" disabled={!boot.spaces.length} onClick={() => setSpaceExport(true)}>
            <DownloadSimple aria-hidden />
            {t("Bereich exportieren …", "Export space …")}
          </button>
        </SettingRow>
        {spaceExport && <SpaceExportDialog spaces={boot.spaces} onClose={() => setSpaceExport(false)} />}
      </SettingGroup>

      <SettingGroup id="backups" title={t("Sicherungen", "Backups")} description={t("Ein Archiv dieses Arbeitsbereichs zurückholen. Die Sicherung der ganzen Instanz ist Sache der Administration.", "Bring back an archive of this workspace. Backing up the whole instance is up to the administration.")}>
        <SettingRow
          label={t("Flowplan-Archiv wiederherstellen", "Restore a Flowplan archive")}
          description={t(
            "ZIP-Archive (aus „Arbeitsbereich als ZIP“) werden als Kopien in neuen privaten Bereichen wiederhergestellt. Alte Freigaben und Anmeldedaten werden nicht aktiviert. Maximal 2 GB ZIP / 4 GB entpackt. JSON-Dateien bleiben als älteres Importformat verfügbar.",
            "ZIP archives (from “Workspace as ZIP”) are restored as copies in new private spaces. Old shares and sign-in data are not activated. At most 2 GB ZIP / 4 GB unpacked. JSON files remain available as an older import format.",
          )}
        >
          <Stack>
            <span className="ws-buttons">
              <FileButton
                label={t("ZIP-Archiv auswählen", "Choose ZIP archive")}
                busyLabel={t("Archiv wird verarbeitet …", "Processing archive …")}
                busy={restoreBusy}
                disabled={!canWrite}
                accept=".zip"
                onFiles={async ([file], input) => {
                  setRestoreBusy(true);
                  report("restore", null);
                  try {
                    if (file.size > 2 * 1024 * 1024 * 1024) throw new Error(t("ZIP darf maximal 2 GB groß sein.", "The ZIP may be at most 2 GB."));
                    const r = await fetch(`/api/backup?workspace=${boot.workspace.id}`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
                    const result = await r.json();
                    if (!r.ok) throw new Error(serverMessage(result.error));
                    await onRefresh();
                    report("restore", {
                      tone: "ok",
                      text: t(`${result.pages} ${result.pages === 1 ? "Seite" : "Seiten"} und ${result.files} ${result.files === 1 ? "Datei" : "Dateien"} importiert.${result.omittedRelations ? ` ${result.omittedRelations} Verknüpfungen zu nicht enthaltenen Einträgen konnten nicht übernommen werden.` : ""}`, `${result.pages} ${result.pages === 1 ? "page" : "pages"} and ${result.files} ${result.files === 1 ? "file" : "files"} imported.${result.omittedRelations ? ` ${result.omittedRelations} links to records not included could not be kept.` : ""}`),
                    });
                  } catch (e) {
                    fail("restore")(e);
                  } finally {
                    setRestoreBusy(false);
                    input.value = "";
                  }
                }}
              />
              <FileButton
                label={t("JSON-Backup auswählen", "Choose JSON backup")}
                disabled={!canWrite}
                accept=".json"
                onFiles={async ([file], input) => {
                  input.value = "";
                  report("restore", null);
                  try {
                    await mutate({ action: "workspace.import", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, backup: JSON.parse(await file.text()) });
                    report("restore", { tone: "ok", text: t("Backup importiert.", "Backup imported.") });
                  } catch (e) {
                    fail("restore")(e);
                  }
                }}
              />
            </span>
            <Outcome result={results.restore} />
          </Stack>
        </SettingRow>
        <SettingRow
          label={t("Sicherung der Instanz", "Backup of the instance")}
          description={
            boot.user.isAdmin
              ? t("Geplante Sicherungen, S3 und die Wiederherstellung der ganzen Instanz findest du in der Administration.", "Scheduled backups, S3 and restoring the whole instance are in the administration.")
              : t("Regelmäßige Sicherungen der ganzen Instanz richtet die Administration ein; dafür ist hier nichts zu tun.", "Regular backups of the whole instance are set up by the administration; nothing to do here.")
          }
        >
          {boot.user.isAdmin ? (
            <a className="button" href="#admin/storage">
              {t("Speicher & Sicherung", "Storage & backup")}
              <ArrowRight aria-hidden />
            </a>
          ) : null}
        </SettingRow>
      </SettingGroup>

      <SettingGroup id="trash" title={t("Papierkorb & Aufbewahrung", "Trash & retention")}>
        <SettingRow
          label={t("Papierkorb", "Trash")}
          description={t(
            "Gelöschte Seiten und Bereiche bleiben im Papierkorb, bis jemand sie endgültig löscht. Gelöschte Einträge aus Datenbanken bleiben 30 Tage.",
            "Deleted pages and spaces stay in the trash until someone deletes them permanently. Deleted database records stay for 30 days.",
          )}
        >
          <a className="button" href="#trash">
            {t("Papierkorb öffnen", "Open trash")}
          </a>
        </SettingRow>
        <SettingRow label={t("Frühere Versionen", "Earlier versions")} description={t("Wie lange frühere Versionen von Seiten aufbewahrt werden, legt die Administration der Instanz fest.", "How long earlier versions of pages are kept is set by the instance's administration.")}>
          {boot.user.isAdmin ? (
            <a className="button" href="#admin/general">
              {t("Instanz", "Instance")}
              <ArrowRight aria-hidden />
            </a>
          ) : null}
        </SettingRow>
      </SettingGroup>
    </>
  );
}
