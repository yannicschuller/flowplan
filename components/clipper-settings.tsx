"use client";
// Web clipper: a bookmarklet for the browser's bookmarks bar and importing
// the bookmarks file browsers export.
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
      <h2>Web-Clipper und Lesezeichen</h2>
      <p>
        Zieh diesen Knopf in die Lesezeichenleiste deines Browsers. Ein Klick
        darauf speichert die geöffnete Webseite in Flowplan – als Seite (auf
        Wunsch mit dem Artikeltext) oder als Lesezeichen. Markierter Text wird
        mitgenommen. Auf dem Handy geht das über „Teilen“ → Flowplan.
      </p>
      {origin && (
        <a
          ref={link}
          className="button bookmarklet"
          onClick={(e) => e.preventDefault()}
          draggable
          title="In die Lesezeichenleiste ziehen"
        >
          <BookmarkSimple /> In Flowplan speichern
        </a>
      )}
      <h3>Browser-Lesezeichen importieren</h3>
      <p>
        Exportiere deine Lesezeichen als HTML-Datei (Chrome, Edge, Firefox,
        Safari: „Lesezeichen exportieren“). Sie landen in der Datenbank
        „Lesezeichen“ des gewählten Bereichs, mit Ordnern und Datum; doppelte
        Links werden übersprungen.
      </p>
      <div className="clipper-import">
        <Select aria-label="Bereich für Lesezeichen" value={space} onChange={(e) => setSpace(e.target.value)}>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <label className={`button file-label${canWrite ? "" : " disabled"}`}>
          <UploadSimple />
          Lesezeichen-Datei wählen
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
