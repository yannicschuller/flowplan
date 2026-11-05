"use client";
// Import from AFFiNE, Confluence, Evernote, Google Docs, Microsoft Word and
// Obsidian (lib/importers): the file is uploaded once – as the raw request body,
// streamed to disk on the server (#76) – for a preview (counts and
// warnings); the import then names that upload instead of sending it again.
import { useState } from "react";
import { FileDoc, UploadSimple } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { Select } from "./select";

type Preview = {
  source: string;
  title: string;
  pages: number;
  folders: number;
  files: number;
  bytes: number;
  tags: number;
  warnings: string[];
  // AFFiNE only.
  whiteboards?: number;
  databases?: number;
  journalDays?: number;
  collections?: number;
  // Page properties (by name) and page icons the import sets.
  properties?: number;
  icons?: number;
  // Documents that become the content of a database record (AFFiNE).
  rowDocuments?: number;
  // Templates saved as templates (AFFiNE).
  templates?: number;
  // More pages than one import may bring: importing is refused.
  tooMany?: boolean;
  // The page everything lands below (an AFFiNE workspace with structure).
  wrapper?: string;
  // The kept upload, for the import.
  upload?: string;
};
type Result = Preview & { rootIds: string[]; rows: number; databaseId?: string };

// Warnings carry a count ("… (3×)"); the text before it is translated.
const warningText = (warning: string) => {
  const counted = /^(.*) \((\d+)×\)$/.exec(warning);
  return counted ? `${serverMessage(counted[1])} (${counted[2]}×)` : serverMessage(warning);
};

function send(query: URLSearchParams, body: File | null, onProgress: (share: number) => void) {
  return new Promise<unknown>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/import/source?${query}`);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.responseType = "json";
    request.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    request.upload.onload = () => onProgress(1);
    request.onload = () => {
      const data = request.response as { error?: string } | null;
      if (request.status >= 200 && request.status < 300) resolve(data);
      else reject(new Error(serverMessage(data?.error) || String(request.status)));
    };
    request.onerror = () => reject(new Error("network"));
    request.send(body);
  });
}

export function ImportSources({
  workspaceId,
  spaces,
  spaceId,
  canWrite,
  onRefresh,
  onError,
}: {
  workspaceId: string;
  spaces: { id: string; name: string }[];
  // The target space chosen outside (Settings → Import & Export); without
  // it the panel offers its own choice.
  spaceId?: string;
  canWrite: boolean;
  onRefresh: () => Promise<unknown> | unknown;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [source, setSource] = useState("auto");
  const [ownSpace, setSpace] = useState(spaces[0]?.id || "");
  const space = spaceId ?? ownSpace;
  const [mode, setMode] = useState<"pages" | "database">("pages");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [progress, setProgress] = useState<{ phase: "upload" | "work"; share: number } | null>(null);
  const [done, setDone] = useState("");
  const names: Record<string, string> = {
    affine: "AFFiNE",
    confluence: "Confluence",
    evernote: "Evernote",
    gdocs: "Google Docs",
    word: "Microsoft Word",
    obsidian: "Obsidian",
  };
  const request = async (chosen: File, dryRun: boolean, upload?: string) => {
    const query = new URLSearchParams({ workspaceId, spaceId: space || spaces[0]?.id || "", source, mode, name: chosen.name });
    if (dryRun) query.set("dryRun", "1");
    // The import uses the upload of the preview.
    if (upload) query.set("upload", upload);
    setProgress(upload ? { phase: "work", share: 1 } : { phase: "upload", share: 0 });
    try {
      return await send(query, upload ? null : chosen, (share) => setProgress({ phase: share >= 1 ? "work" : "upload", share }));
    } finally {
      setProgress(null);
    }
  };
  // Drops the kept upload when the preview is left without importing.
  const discard = (upload?: string) => {
    if (upload) void send(new URLSearchParams({ upload, discard: "1" }), null, () => {}).catch(() => {});
  };
  const choose = async (chosen: File) => {
    discard(preview?.upload);
    setFile(chosen);
    setPreview(null);
    setDone("");
    try {
      setPreview((await request(chosen, true)) as Preview);
    } catch (error) {
      setFile(null);
      onError((error as Error).message === "network" ? t("Keine Verbindung zum Server.", "No connection to the server.") : (error as Error).message);
    }
  };
  const start = async () => {
    if (!file) return;
    try {
      const result = (await request(file, false, preview?.upload)) as Result;
      setPreview(null);
      setFile(null);
      const extra = (result.whiteboards || 0) + (result.databases || 0) + (result.wrapper ? 1 : 0);
      setDone(
        mode === "database"
          ? t(`${result.rows} Einträge und ${result.files} Dateien importiert.`, `${result.rows} records and ${result.files} files imported.`)
          : t(
              `${result.pages + result.folders + extra} Seiten, ${result.rows} Datenbankeinträge und ${result.files} Dateien importiert.`,
              `${result.pages + result.folders + extra} pages, ${result.rows} database records and ${result.files} files imported.`,
            ),
      );
      await onRefresh();
      if (result.rootIds[0]) location.hash = `#page=${result.rootIds[0]}`;
    } catch (error) {
      onError((error as Error).message === "network" ? t("Keine Verbindung zum Server.", "No connection to the server.") : (error as Error).message);
      // A failed import drops the kept upload on the server: choose again.
      if (preview?.upload) {
        setPreview(null);
        setFile(null);
      }
    }
  };
  const busy = !!progress;
  return (
    <div className="setting-row wide import-sources" id="import-tools">
      <div className="setting-text">
        <span className="setting-label">{t("AFFiNE, Confluence, Evernote, Google Docs, Microsoft Word oder Obsidian", "AFFiNE, Confluence, Evernote, Google Docs, Microsoft Word or Obsidian")}</span>
        <small>
          {t(
            "AFFiNE: die Arbeitsbereichsdatei (.affine) mit Ordnern, Sammlungen, Datenbanken, Whiteboards und Journal oder ein Snapshot-Export (ZIP). Confluence: Bereichsexport als HTML oder XML (ZIP). Evernote: Notizbuch als ENEX-Datei (mehrere als ZIP). Google Docs: Google-Takeout-ZIP oder einzelne Dokumente als HTML oder Word. Microsoft Word: ein Dokument (.docx) oder mehrere als ZIP, Ordner werden zu Seiten. Obsidian: der Tresor als ZIP. Seitenbaum, Bilder, Anhänge, Links zwischen Seiten, Hinweisboxen, Aufgaben und Tags werden übernommen. Vor dem Import siehst du, was übernommen wird.",
            "AFFiNE: the workspace file (.affine) with folders, collections, databases, whiteboards and journal, or a snapshot export (ZIP). Confluence: space export as HTML or XML (ZIP). Evernote: notebook as an ENEX file (several as a ZIP). Google Docs: a Google Takeout ZIP or single documents as HTML or Word. Microsoft Word: one document (.docx) or several as a ZIP, folders become pages. Obsidian: the vault as a ZIP. The page tree, images, attachments, links between pages, callouts, tasks and tags come along. Before the import you see what will be imported.",
          )}
        </small>
      </div>
      <div className="ws-form ws-form-inline">
        <div className="ws-field">
          <label htmlFor="import-source">{t("Quelle", "Source")}</label>
          <Select id="import-source" value={source} onChange={(e) => setSource(e.target.value)} disabled={busy} aria-label={t("Quelle des Imports", "Source of the import")}>
            <option value="auto">{t("Automatisch erkennen", "Detect automatically")}</option>
            {Object.entries(names).map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </Select>
        </div>
        {spaceId === undefined && (
          <div className="ws-field">
            <label htmlFor="import-source-space">{t("Zielbereich", "Target space")}</label>
            <Select id="import-source-space" value={space} onChange={(e) => setSpace(e.target.value)} disabled={busy} aria-label={t("Zielbereich des Imports", "Target space of the import")}>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="ws-field">
          <label htmlFor="import-source-mode">{t("Importieren als", "Import as")}</label>
          <Select id="import-source-mode" value={mode} onChange={(e) => setMode(e.target.value as "pages" | "database")} disabled={busy} aria-label={t("Importieren als", "Import as")}>
            <option value="pages">{t("Seiten (Ordner als Unterseiten)", "Pages (folders as sub-pages)")}</option>
            <option value="database">{t("Neue Datenbank (Tags, Daten, Ordner als Eigenschaften)", "New database (tags, dates, folders as properties)")}</option>
          </Select>
        </div>
        <div className="ws-form-actions">
          <label className={`button file-label ws-file${canWrite && !busy ? "" : " disabled"}`}>
            <UploadSimple aria-hidden />
            {t("Datei auswählen und prüfen", "Choose and check file")}
            <input
              type="file"
              accept=".zip,.affine,.enex,.html,.htm,.docx,.doc,.one,.onetoc2,.onepkg,application/zip"
              hidden
              disabled={!canWrite || busy}
              aria-label={t("Datei für den Import", "File to import")}
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                e.target.value = "";
                if (chosen) void choose(chosen);
              }}
            />
          </label>
        </div>
      </div>
      {source === "word" && (
        <p className="import-sources-hint">
          <FileDoc aria-hidden />
          <span>
            {t(
              "Ein Word-Dokument (.docx) wird eine Seite mit dem Dateinamen als Titel; ein ZIP mit mehreren .docx-Dateien wird ein Seitenbaum, Ordner werden zu übergeordneten Seiten. Ältere Word-Dateien (.doc) bitte vorher als .docx speichern. OneNote: Seite oder Abschnitt in OneNote als Word-Dokument (.docx) exportieren.",
              "A Word document (.docx) becomes a page titled by its file name; a ZIP with several .docx files becomes a page tree, folders become parent pages. Please save older Word files (.doc) as .docx first. OneNote: export the page or section from OneNote as a Word document (.docx).",
            )}
          </span>
        </p>
      )}
      {progress && (
        <div className="import-sources-progress" role="status">
          <progress max={1} value={progress.phase === "upload" ? progress.share : undefined} />
          <span>
            {progress.phase === "upload"
              ? t(`Hochladen … ${Math.round(progress.share * 100)} %`, `Uploading … ${Math.round(progress.share * 100)} %`)
              : t("Wird verarbeitet …", "Processing …")}
          </span>
        </div>
      )}
      {preview && file && !busy && (
        <div className="import-sources-preview" role="region" aria-label={t("Vorschau des Imports", "Preview of the import")}>
          <strong className="ws-break">
            {t("Vorschau", "Preview")} · {names[preview.source] || preview.source}: {preview.title}
          </strong>
          <ul>
            {mode === "pages" && preview.wrapper && (
              <li>{t(`Alles unter einer Seite „${preview.wrapper}“`, `Everything below a page “${preview.wrapper}”`)}</li>
            )}
            <li>{mode === "database" ? t(`${preview.pages} Einträge`, `${preview.pages} records`) : t(`${preview.pages} Seiten`, `${preview.pages} pages`)}</li>
            {preview.folders > 0 && mode === "pages" && <li>{t(`${preview.folders} Ordner als Seiten`, `${preview.folders} folders as pages`)}</li>}
            <li>{t(`${preview.files} Dateien (${(preview.bytes / 1048576).toFixed(1)} MB)`, `${preview.files} files (${(preview.bytes / 1048576).toFixed(1)} MB)`)}</li>
            {preview.tags > 0 && <li>{t(`${preview.tags} Tags`, `${preview.tags} tags`)}</li>}
            {mode === "pages" && !!preview.whiteboards && <li>{t(`${preview.whiteboards} Whiteboards`, `${preview.whiteboards} whiteboards`)}</li>}
            {mode === "pages" && !!preview.databases && <li>{t(`${preview.databases} Datenbanken`, `${preview.databases} databases`)}</li>}
            {!!preview.collections && <li>{t(`${preview.collections} Sammlungen als Seiten`, `${preview.collections} collections as pages`)}</li>}
            {!!preview.journalDays && <li>{t(`${preview.journalDays} Tage ins Journal`, `${preview.journalDays} days into the journal`)}</li>}
            {mode === "pages" && !!preview.properties && <li>{t(`${preview.properties} Eigenschaften`, `${preview.properties} properties`)}</li>}
            {mode === "pages" && !!preview.icons && <li>{t(`${preview.icons} Seitensymbole`, `${preview.icons} page icons`)}</li>}
            {mode === "pages" && !!preview.rowDocuments && (
              <li>{t(`${preview.rowDocuments} Dokumente als Inhalt von Datenbankeinträgen`, `${preview.rowDocuments} documents as content of database records`)}</li>
            )}
            {!!preview.templates && <li>{t(`${preview.templates} Vorlagen`, `${preview.templates} templates`)}</li>}
          </ul>
          {preview.warnings.length > 0 && (
            <ul className="import-sources-warnings">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warningText(warning)}</li>
              ))}
            </ul>
          )}
          <div className="import-sources-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                discard(preview.upload);
                setPreview(null);
                setFile(null);
              }}
            >
              {t("Abbrechen", "Cancel")}
            </button>
            <button type="button" className="button primary" onClick={() => void start()} disabled={!canWrite || preview.tooMany || (!preview.pages && !preview.folders && !preview.templates)}>
              {t("Importieren", "Import")}
            </button>
          </div>
        </div>
      )}
      {done && (
        <p role="status" className="ws-result">
          {done}
        </p>
      )}
    </div>
  );
}
