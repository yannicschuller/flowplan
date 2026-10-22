"use client";
// Settings → Web-Clipper: a bookmarklet for the browser's bookmarks bar, the
// browser extension, the default capture database and importing the
// bookmarks file browsers export.
import { useT } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { BookmarkSimple, Key, UploadSimple } from "@phosphor-icons/react";
import { settingsHash } from "@/lib/settings-sections";
import { CONTROL, SettingGroup, SettingRow } from "./settings-ui";
import { Select } from "./select";
import { CaptureDefaultSetting } from "./capture-target";

export function bookmarklet(origin: string) {
  // Opens the "save to Flowplan" window with title, address and the
  // selected text of the current tab.
  const code = `(()=>{const s=String(getSelection()||'').slice(0,20000);const q=new URLSearchParams({title:document.title,url:location.href,text:s});window.open('${origin}/share-target?'+q,'flowplan','width=520,height=720');})()`;
  return `javascript:${encodeURIComponent(code)}`;
}

export function ClipperSettings({
  workspaceId,
  spaces,
  canWrite,
  onImport,
}: {
  workspaceId: string;
  spaces: { id: string; name: string }[];
  canWrite: boolean;
  // Resolves to the text shown next to the button ("12 Lesezeichen importiert").
  onImport: (spaceId: string, html: string) => Promise<string>;
}) {
  const t = useT();
  const [origin, setOrigin] = useState("");
  const [space, setSpace] = useState(spaces[0]?.id || "");
  const [result, setResult] = useState<{ text: string; error?: boolean } | null>(null),
    [busy, setBusy] = useState(false);
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => setOrigin(location.origin), []);
  // React refuses javascript: links in markup; the bookmarklet is exactly
  // that, so its address is set directly (it only runs when dragged into
  // the bookmarks bar and clicked there).
  useEffect(() => {
    if (origin) link.current?.setAttribute("href", bookmarklet(origin));
  }, [origin]);
  return (
    <div className="clipper-settings">
      <SettingGroup
        id="clipper"
        title={t("Web-Clipper", "Web clipper")}
        description={t(
          "Speichert die geöffnete Webseite in Flowplan – als Seite (auf Wunsch mit dem Artikeltext), als Eintrag in einer Datenbank oder als Lesezeichen. Markierter Text wird mitgenommen. Auf dem Handy geht das über „Teilen“ → Flowplan.",
          "Saves the open web page to Flowplan – as a page (with the article text if you like), as a record in a database or as a bookmark. Selected text comes along. On the phone use “Share” → Flowplan.",
        )}
      >
        <SettingRow label={t("Lesezeichen-Knopf", "Bookmark button")} description={t("Zieh den Knopf in die Lesezeichenleiste deines Browsers; ein Klick darauf speichert die Seite.", "Drag the button to your browser's bookmarks bar; a click on it saves the page.")}>
          {origin && (
            <a ref={link} className="button bookmarklet" onClick={(e) => e.preventDefault()} draggable title={t("In die Lesezeichenleiste ziehen", "Drag to the bookmarks bar")}>
              <BookmarkSimple aria-hidden /> {t("In Flowplan speichern", "Save to Flowplan")}
            </a>
          )}
        </SettingRow>
        <SettingRow
          label={t("Browser-Erweiterung", "Browser extension")}
          description={t(
            "Für Chrome, Edge und Firefox: ganze Artikel, Auswahlen, Lesezeichen mit Tags und Markierungen per Rechtsklick. Sie meldet sich mit einem API-Token mit dem Recht „Nur Browser-Erweiterung“ an.",
            "For Chrome, Edge and Firefox: whole articles, selections, bookmarks with tags and highlights by right-click. It signs in with an API token with the permission “Browser extension only”.",
          )}
        >
          <a className="button" href={settingsHash({ area: "settings", section: "api", anchor: "tokens" })}>
            <Key aria-hidden /> {t("Token anlegen", "Create token")}
          </a>
        </SettingRow>
      </SettingGroup>
      {canWrite && <CaptureDefaultSetting workspaceId={workspaceId} />}
      <SettingGroup
        id="bookmarks"
        title={t("Browser-Lesezeichen importieren", "Import browser bookmarks")}
        description={t(
          "Exportiere deine Lesezeichen als HTML-Datei (Chrome, Edge, Firefox, Safari: „Lesezeichen exportieren“). Sie landen in der Datenbank „Lesezeichen“ des gewählten Bereichs, mit Ordnern und Datum; doppelte Links werden übersprungen.",
          "Export your bookmarks as an HTML file (Chrome, Edge, Firefox, Safari: “Export bookmarks”). They land in the “Lesezeichen” database of the chosen space, with folders and dates; duplicate links are skipped.",
        )}
      >
        <SettingRow id="bookmarks-space" label={t("Bereich für Lesezeichen", "Space for bookmarks")}>
          <Select id="bookmarks-space" className={CONTROL.md} value={space} onChange={(e) => setSpace(e.target.value)}>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow label={t("Lesezeichen-Datei", "Bookmarks file")} description={canWrite ? t("HTML-Datei aus dem Browser.", "HTML file from the browser.") : t("Mit Leserechten lässt sich nichts importieren.", "With read access nothing can be imported.")}>
          {result && (
            <span className={`save-state ${result.error ? "error" : "saved"}`} role={result.error ? "alert" : "status"}>
              {result.text}
            </span>
          )}
          <label
            className={`button file-label${canWrite && !busy ? "" : " disabled"}`}
            tabIndex={canWrite ? 0 : -1}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.currentTarget.querySelector("input")?.click();
              }
            }}
          >
            <UploadSimple aria-hidden />
            {t("Lesezeichen-Datei wählen", "Choose bookmarks file")}
            <input
              type="file"
              accept=".html,.htm"
              hidden
              disabled={!canWrite || !space || busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setBusy(true);
                setResult(null);
                try {
                  setResult({ text: await onImport(space, await file.text()) });
                } catch (err) {
                  setResult({ text: (err as Error).message, error: true });
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        </SettingRow>
      </SettingGroup>
    </div>
  );
}
