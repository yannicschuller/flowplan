"use client";
// Import from Confluence, Evernote, Google Docs and Obsidian
// (lib/importers): the file is uploaded once for a preview (counts and
// warnings), then again for the import; both show the upload progress.
import { useState } from "react";
import { UploadSimple } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { Select } from "./select";

type Preview = { source: string; title: string; pages: number; folders: number; files: number; bytes: number; tags: number; warnings: string[] };
type Result = Preview & { rootIds: string[]; rows: number; databaseId?: string };

// Warnings carry a count ("… (3×)"); the text before it is translated.
const warningText = (warning: string) => {
  const counted = /^(.*) \((\d+)×\)$/.exec(warning);
  return counted ? `${serverMessage(counted[1])} (${counted[2]}×)` : serverMessage(warning);
};

function send(body: FormData, onProgress: (share: number) => void) {
  return new Promise<unknown>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/import/source");
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
  canWrite,
  onRefresh,
  onError,
}: {
  workspaceId: string;
  spaces: { id: string; name: string }[];
  canWrite: boolean;
  onRefresh: () => Promise<unknown> | unknown;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [source, setSource] = useState("auto");
  const [space, setSpace] = useState(spaces[0]?.id || "");
  const [mode, setMode] = useState<"pages" | "database">("pages");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [progress, setProgress] = useState<{ phase: "upload" | "work"; share: number } | null>(null);
  const [done, setDone] = useState("");
  const names: Record<string, string> = {
    confluence: "Confluence",
    evernote: "Evernote",
    gdocs: "Google Docs",
    obsidian: "Obsidian",
  };
  const request = async (chosen: File, dryRun: boolean) => {
    const body = new FormData();
    body.set("workspaceId", workspaceId);
    body.set("spaceId", space || spaces[0]?.id || "");
    body.set("source", source);
    body.set("mode", mode);
    if (dryRun) body.set("dryRun", "1");
    body.set("file", chosen);
    setProgress({ phase: "upload", share: 0 });
    try {
      return await send(body, (share) => setProgress({ phase: share >= 1 ? "work" : "upload", share }));
    } finally {
      setProgress(null);
    }
  };
  const choose = async (chosen: File) => {
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
      const result = (await request(file, false)) as Result;
      setPreview(null);
      setFile(null);
      setDone(
        mode === "database"
          ? t(`${result.rows} Einträge und ${result.files} Dateien importiert.`, `${result.rows} records and ${result.files} files imported.`)
          : t(`${result.pages + result.folders} Seiten und ${result.files} Dateien importiert.`, `${result.pages + result.folders} pages and ${result.files} files imported.`),
      );
      await onRefresh();
      if (result.rootIds[0]) location.hash = `#page=${result.rootIds[0]}`;
    } catch (error) {
      onError((error as Error).message === "network" ? t("Keine Verbindung zum Server.", "No connection to the server.") : (error as Error).message);
    }
  };
  const busy = !!progress;
  return (
    <section className="settings-section import-sources">
      <h2>{t("Aus Confluence, Evernote, Google Docs oder Obsidian importieren", "Import from Confluence, Evernote, Google Docs or Obsidian")}</h2>
      <p>
        {t(
          "Confluence: Bereichsexport als HTML oder XML (ZIP). Evernote: Notizbuch als ENEX-Datei (mehrere als ZIP). Google Docs: Google-Takeout-ZIP oder einzelne Dokumente als HTML oder Word. Obsidian: der Tresor als ZIP. Seitenbaum, Bilder, Anhänge, Links zwischen Seiten, Hinweisboxen, Aufgaben und Tags werden übernommen. Vor dem Import siehst du, was übernommen wird.",
          "Confluence: space export as HTML or XML (ZIP). Evernote: notebook as an ENEX file (several as a ZIP). Google Docs: a Google Takeout ZIP or single documents as HTML or Word. Obsidian: the vault as a ZIP. The page tree, images, attachments, links between pages, callouts, tasks and tags come along. Before the import you see what will be imported.",
        )}
      </p>
      <div className="import-sources-options">
        <label>
          {t("Quelle", "Source")}
          <Select value={source} onChange={(e) => setSource(e.target.value)} disabled={busy} aria-label={t("Quelle des Imports", "Source of the import")}>
            <option value="auto">{t("Automatisch erkennen", "Detect automatically")}</option>
            {Object.entries(names).map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          {t("Zielbereich", "Target space")}
          <Select value={space} onChange={(e) => setSpace(e.target.value)} disabled={busy} aria-label={t("Zielbereich des Imports", "Target space of the import")}>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          {t("Importieren als", "Import as")}
          <Select value={mode} onChange={(e) => setMode(e.target.value as "pages" | "database")} disabled={busy} aria-label={t("Importieren als", "Import as")}>
            <option value="pages">{t("Seiten (mit Ordnern als Unterseiten)", "Pages (folders as sub-pages)")}</option>
            <option value="database">{t("Neue Datenbank (Tags, Daten, Ordner als Eigenschaften)", "New database (tags, dates, folders as properties)")}</option>
          </Select>
        </label>
      </div>
      <label className={`button file-label${canWrite && !busy ? "" : " disabled"}`}>
        <UploadSimple />
        {t("Datei auswählen", "Choose file")}
        <input
          type="file"
          accept=".zip,.enex,.html,.htm,.docx,application/zip"
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
        <div className="import-sources-preview">
          <h3>
            {names[preview.source] || preview.source}: {preview.title}
          </h3>
          <ul>
            <li>{mode === "database" ? t(`${preview.pages} Einträge`, `${preview.pages} records`) : t(`${preview.pages} Seiten`, `${preview.pages} pages`)}</li>
            {preview.folders > 0 && mode === "pages" && <li>{t(`${preview.folders} Ordner als Seiten`, `${preview.folders} folders as pages`)}</li>}
            <li>{t(`${preview.files} Dateien (${(preview.bytes / 1048576).toFixed(1)} MB)`, `${preview.files} files (${(preview.bytes / 1048576).toFixed(1)} MB)`)}</li>
            {preview.tags > 0 && <li>{t(`${preview.tags} Tags`, `${preview.tags} tags`)}</li>}
          </ul>
          {preview.warnings.length > 0 && (
            <ul className="import-sources-warnings">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warningText(warning)}</li>
              ))}
            </ul>
          )}
          <div className="import-sources-actions">
            <button type="button" className="primary" onClick={() => void start()} disabled={!canWrite || (!preview.pages && !preview.folders)}>
              {t("Importieren", "Import")}
            </button>
            <button
              type="button"
              onClick={() => {
                setPreview(null);
                setFile(null);
              }}
            >
              {t("Abbrechen", "Cancel")}
            </button>
          </div>
        </div>
      )}
      {done && <p role="status">{done}</p>}
    </section>
  );
}
