"use client";
// Settings → Arbeitsbereich → Import & Export: archives of the workspace,
// Markdown of a space, and imports from files, Jira/Trello, Notion-style
// ZIPs, other tools and Flowplan backups.
import { useState } from "react";
import { DownloadSimple, UploadSimple } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "../../i18n";
import { api, download, downloadBlob } from "../../ui";
import { Select } from "../../select";
import { SpaceExportDialog } from "../../space-export";
import { ImportSources } from "../../import-sources";
import { useUserSettings } from "../user-context";

export default function DataSection() {
  const t = useT();
  const { boot, mutate, onError, onRefresh } = useUserSettings();
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [spaceExport, setSpaceExport] = useState(false);
  const [trackerBusy, setTrackerBusy] = useState(false);
  const [zipBusy, setZipBusy] = useState(false),
    [zipResult, setZipResult] = useState(""),
    [importSpace, setImportSpace] = useState("");
  return (
    <>
      <section className="settings-section">
        <h2>{t("Arbeitsbereich exportieren", "Export workspace")}</h2>
        <p>
          {t("Das ZIP-Inhaltsarchiv enthält zugängliche Seiten einschließlich Papierkorb, Datenbanken, interne Verknüpfungen, Seiten- und Datensatzvorlagen, Kommentare, Versionen, Favoriten und hochgeladene Dateien.", "The ZIP content archive contains accessible pages including the trash, databases, internal links, page and record templates, comments, versions, favourites and uploaded files.")}
        </p>
        <div className="archive-actions">
          <button
            className="button primary"
            disabled={archiveBusy}
            onClick={async () => {
              setArchiveBusy(true);
              try {
                const response = await fetch(`/api/backup?workspace=${boot.workspace.id}`);
                if (!response.ok) throw new Error(serverMessage((await response.json()).error));
                downloadBlob(`flowplan-${new Date().toISOString().slice(0, 10)}.zip`, await response.blob());
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setArchiveBusy(false);
              }
            }}
          >
            <DownloadSimple />
            {archiveBusy ? t("Archiv wird verarbeitet …", "Processing archive …") : t("ZIP mit Dateien exportieren", "Export ZIP with files")}
          </button>
          <button
            className="button"
            onClick={async () => {
              try {
                const data = await api(`/api/export?workspace=${boot.workspace.id}`);
                download("flowplan-export.json", JSON.stringify(data, null, 2), "application/json");
              } catch (e) {
                onError((e as Error).message);
              }
            }}
          >
            <DownloadSimple />
            {t("JSON ohne Dateien exportieren", "Export JSON without files")}
          </button>
        </div>
      </section>
      <section className="settings-section">
        <h2>{t("Bereich als Markdown exportieren", "Export space as Markdown")}</h2>
        <p>
          {t(
            "Eine lesbare Kopie eines Bereichs: alle Seiten und Datenbanken, die du lesen darfst, als Markdown in einem ZIP – zum Archivieren, offline Lesen oder für ein eigenes Git-Repository.",
            "A readable copy of a space: all pages and databases you may read, as Markdown in one ZIP – to archive, read offline or put into your own Git repository.",
          )}
        </p>
        <button className="button" disabled={!boot.spaces.length} onClick={() => setSpaceExport(true)}>
          <DownloadSimple />
          {t("Bereich exportieren …", "Export space …")}
        </button>
        {spaceExport && <SpaceExportDialog spaces={boot.spaces} onClose={() => setSpaceExport(false)} />}
      </section>
      <section className="settings-section">
        <h2>{t("Markdown oder Text importieren", "Import Markdown or text")}</h2>
        <p>{t("Jede Datei wird als neue Seite in deinem Arbeitsbereich angelegt.", "Every file becomes a new page in your workspace.")}</p>
        <label className="button file-label">
          <UploadSimple />
          {t("Dateien auswählen", "Choose files")}
          <input
            type="file"
            accept=".md,.txt,.html"
            multiple
            hidden
            disabled={boot.workspace.role === "viewer"}
            onChange={async (e) => {
              for (const file of Array.from(e.target.files || [])) {
                if (file.size > 2_000_000) {
                  onError(t("Datei zu groß (max. 2 MB)", "File too large (max. 2 MB)"));
                  continue;
                }
                try {
                  await mutate({
                    action: "page.import",
                    workspaceId: boot.workspace.id,
                    spaceId: boot.spaces[0].id,
                    title: file.name.replace(/\.[^.]+$/, ""),
                    content: await file.text(),
                    format: file.name.endsWith(".html") ? "html" : file.name.endsWith(".md") ? "markdown" : "text",
                  });
                } catch (err) {
                  onError((err as Error).message);
                }
              }
              e.target.value = "";
            }}
          />
        </label>
      </section>
      <section className="settings-section">
        <h2>{t("Aus Jira oder Trello importieren", "Import from Jira or Trello")}</h2>
        <p>
          {t(
            "Jira: Vorgänge als CSV exportieren (alle Felder). Trello: Board-Menü → Drucken, exportieren und teilen → Als JSON exportieren. Daraus wird eine neue Datenbank mit Status, Priorität, Zuständigen, Labels, Story Points und Unteraufgaben; Beschreibungen werden zum Inhalt, Kommentare zu Kommentaren, Anhänge zu Links.",
            "Jira: export issues as CSV (all fields). Trello: board menu → Print, export and share → Export as JSON. This becomes a new database with status, priority, assignees, labels, story points and subtasks; descriptions become the content, comments comments, attachments links.",
          )}
        </p>
        <label className="button file-label">
          <UploadSimple />
          {trackerBusy ? t("Import läuft …", "Importing …") : t("CSV oder JSON auswählen", "Choose CSV or JSON")}
          <input
            type="file"
            accept=".csv,.json,text/csv,application/json"
            hidden
            aria-label={t("Jira- oder Trello-Export importieren", "Import Jira or Trello export")}
            disabled={boot.workspace.role === "viewer" || trackerBusy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setTrackerBusy(true);
              try {
                const body = new FormData();
                body.set("workspaceId", boot.workspace.id);
                body.set("spaceId", importSpace || boot.spaces[0]?.id || "");
                body.set("file", file);
                const response = await fetch("/api/import/tracker", { method: "POST", body });
                const result = await response.json();
                if (!response.ok) throw new Error(serverMessage(result.error) || t("Import fehlgeschlagen.", "Import failed."));
                await onRefresh();
                onError(t(`${result.rows} Einträge und ${result.comments} Kommentare importiert.`, `${result.rows} records and ${result.comments} comments imported.`));
                location.hash = `#page=${result.pageId}`;
              } catch (err) {
                onError((err as Error).message);
              } finally {
                setTrackerBusy(false);
              }
            }}
          />
        </label>
      </section>
      <section className="settings-section">
        <h2>{t("Notion-, AppFlowy- oder Markdown-Export importieren", "Import a Notion, AppFlowy or Markdown export")}</h2>
        <p>
          {t("ZIP mit Markdown- und CSV-Dateien: Markdown wird zu Seiten, CSV zu Datenbanken, Excalidraw- und draw.io-Zeichnungen zu Whiteboards, Ordner zu Unterseiten. Bilder und Dateien, auf die Markdown verweist, werden hochgeladen; Datensatzseiten aus Notion werden den Einträgen zugeordnet. Maximal 100 MB, 500 Seiten und 5.000 Einträge je Tabelle.", "A ZIP with Markdown and CSV files: Markdown becomes pages, CSV databases, Excalidraw and draw.io drawings whiteboards, folders sub-pages. Images and files referenced in Markdown are uploaded; Notion record pages are matched to their records. At most 100 MB, 500 pages and 5,000 records per table.")}
        </p>
        <label>
          {t("Zielbereich", "Target space")}
          <Select aria-label={t("Zielbereich für den Import", "Target space for the import")} value={importSpace || boot.spaces[0]?.id || ""} onChange={(e) => setImportSpace(e.target.value)}>
            {boot.spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="button file-label">
          <UploadSimple />
          {zipBusy ? t("Import läuft …", "Importing …") : t("ZIP auswählen", "Choose ZIP")}
          <input
            type="file"
            accept=".zip,application/zip"
            hidden
            aria-label={t("Export-ZIP importieren", "Import export ZIP")}
            disabled={boot.workspace.role === "viewer" || zipBusy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setZipBusy(true);
              setZipResult("");
              try {
                const body = new FormData();
                body.set("workspaceId", boot.workspace.id);
                body.set("spaceId", importSpace || boot.spaces[0]?.id || "");
                body.set("file", file);
                const response = await fetch("/api/import/zip", { method: "POST", body });
                const result = await response.json();
                if (!response.ok) throw new Error(serverMessage(result.error) || t("Import fehlgeschlagen.", "Import failed."));
                setZipResult(t(`${result.pages} Seiten, ${result.rows} Einträge und ${result.files} Dateien importiert.`, `${result.pages} pages, ${result.rows} records and ${result.files} files imported.`));
                await onRefresh();
              } catch (err) {
                onError((err as Error).message);
              } finally {
                setZipBusy(false);
              }
            }}
          />
        </label>
        {zipResult && <p role="status">{zipResult}</p>}
      </section>
      <ImportSources workspaceId={boot.workspace.id} spaces={boot.spaces} canWrite={boot.workspace.role !== "viewer"} onRefresh={onRefresh} onError={onError} />
      <section className="settings-section">
        <h2>{t("Flowplan-Backup importieren", "Import a Flowplan backup")}</h2>
        <p>
          {t("ZIP-Archive werden als Kopien in neuen privaten Bereichen wiederhergestellt. Alte Freigaben und Anmeldedaten werden nicht aktiviert. Maximal 2 GB ZIP / 4 GB entpackt. JSON-Dateien bleiben als älteres Importformat verfügbar.", "ZIP archives are restored as copies in new private spaces. Old shares and sign-in data are not activated. At most 2 GB ZIP / 4 GB unpacked. JSON files remain available as an older import format.")}
        </p>
        <label className="button file-label">
          <UploadSimple />
          {archiveBusy ? t("Archiv wird verarbeitet …", "Processing archive …") : t("ZIP-Archiv auswählen", "Choose ZIP archive")}
          <input
            type="file"
            accept=".zip"
            hidden
            disabled={archiveBusy || boot.workspace.role === "viewer"}
            onChange={async (e) => {
              const input = e.currentTarget,
                file = input.files?.[0];
              if (!file) return;
              setArchiveBusy(true);
              try {
                if (file.size > 2 * 1024 * 1024 * 1024) throw new Error(t("ZIP darf maximal 2 GB groß sein.", "The ZIP may be at most 2 GB."));
                const r = await fetch(`/api/backup?workspace=${boot.workspace.id}`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
                const result = await r.json();
                if (!r.ok) throw new Error(serverMessage(result.error));
                await onRefresh();
                onError(
                  t(`${result.pages} ${result.pages === 1 ? "Seite" : "Seiten"} und ${result.files} ${result.files === 1 ? "Datei" : "Dateien"} importiert.${result.omittedRelations ? ` ${result.omittedRelations} Verknüpfungen zu nicht enthaltenen Einträgen konnten nicht übernommen werden.` : ""}`, `${result.pages} ${result.pages === 1 ? "page" : "pages"} and ${result.files} ${result.files === 1 ? "file" : "files"} imported.${result.omittedRelations ? ` ${result.omittedRelations} links to records not included could not be kept.` : ""}`),
                );
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setArchiveBusy(false);
                input.value = "";
              }
            }}
          />
        </label>
        <label className="button file-label">
          <UploadSimple />
          {t("JSON-Backup auswählen", "Choose JSON backup")}
          <input
            type="file"
            accept=".json"
            hidden
            disabled={boot.workspace.role === "viewer"}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) {
                try {
                  await mutate({ action: "workspace.import", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, backup: JSON.parse(await f.text()) });
                  onError(t("Backup importiert", "Backup imported"));
                } catch (err) {
                  onError((err as Error).message);
                }
              }
              e.target.value = "";
            }}
          />
        </label>
      </section>
    </>
  );
}
