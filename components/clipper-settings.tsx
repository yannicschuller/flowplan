"use client";
// Web clipper: a bookmarklet for the browser's bookmarks bar and importing
// the bookmarks file browsers export.
import { useT } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { BookmarkSimple, UploadSimple } from "@phosphor-icons/react";
import { Select } from "./select";

export function bookmarklet(origin: string) {
  // Opens the "save to Flowplan" window with title, address and the
  // selected text of the current tab.
  const code = `(()=>{const s=String(getSelection()||'').slice(0,20000);const q=new URLSearchParams({title:document.title,url:location.href,text:s});window.open('${origin}/share-target?'+q,'flowplan','width=520,height=720');})()`;
  return `javascript:${encodeURIComponent(code)}`;
}

export function ClipperSettings({
  spaces,
  canWrite,
  onImport,
}: {
  spaces: { id: string; name: string }[];
  canWrite: boolean;
  onImport: (spaceId: string, html: string) => Promise<unknown>;
}) {
  const t = useT();
  const [origin, setOrigin] = useState("");
  const [space, setSpace] = useState(spaces[0]?.id || "");
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => setOrigin(location.origin), []);
  // React refuses javascript: links in markup; the bookmarklet is exactly
  // that, so its address is set directly (it only runs when dragged into
  // the bookmarks bar and clicked there).
  useEffect(() => {
    if (origin) link.current?.setAttribute("href", bookmarklet(origin));
  }, [origin]);
  return (
    <section className="settings-section clipper-settings">
      <h2>{t("Web-Clipper und Lesezeichen", "Web clipper and bookmarks")}</h2>
      <p>
        {t("Zieh diesen Knopf in die Lesezeichenleiste deines Browsers. Ein Klick darauf speichert die geöffnete Webseite in Flowplan – als Seite (auf Wunsch mit dem Artikeltext) oder als Lesezeichen. Markierter Text wird mitgenommen. Auf dem Handy geht das über „Teilen“ → Flowplan.", "Drag this button to your browser's bookmarks bar. A click on it saves the open web page to Flowplan – as a page (with the article text if you like) or as a bookmark. Selected text comes along. On the phone use “Share” → Flowplan.")}
      </p>
      {origin && (
        <a
          ref={link}
          className="button bookmarklet"
          onClick={(e) => e.preventDefault()}
          draggable
          title={t("In die Lesezeichenleiste ziehen", "Drag to the bookmarks bar")}
        >
          <BookmarkSimple /> {t("In Flowplan speichern", "Save to Flowplan")}
        </a>
      )}
      <h3>{t("Browser-Lesezeichen importieren", "Import browser bookmarks")}</h3>
      <p>
        {t("Exportiere deine Lesezeichen als HTML-Datei (Chrome, Edge, Firefox, Safari: „Lesezeichen exportieren“). Sie landen in der Datenbank „Lesezeichen“ des gewählten Bereichs, mit Ordnern und Datum; doppelte Links werden übersprungen.", "Export your bookmarks as an HTML file (Chrome, Edge, Firefox, Safari: “Export bookmarks”). They land in the “Lesezeichen” database of the chosen space, with folders and dates; duplicate links are skipped.")}
      </p>
      <div className="clipper-import">
        <Select aria-label={t("Bereich für Lesezeichen", "Space for bookmarks")} value={space} onChange={(e) => setSpace(e.target.value)}>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <label className={`button file-label${canWrite ? "" : " disabled"}`}>
          <UploadSimple />
          {t("Lesezeichen-Datei wählen", "Choose bookmarks file")}
          <input
            type="file"
            accept=".html,.htm"
            hidden
            disabled={!canWrite || !space}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) await onImport(space, await file.text());
            }}
          />
        </label>
      </div>
    </section>
  );
}
