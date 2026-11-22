"use client";
// The HTML viewer (#398), opened by openHtml() through HtmlViewerHost
// (components/html-viewer.tsx) and loaded on first use. The file is shown
// as it is in an <iframe sandbox="">: an empty sandbox runs no scripts,
// sends no forms, opens no popups and never navigates the app, and the
// page has an origin of its own (never the app's). The preview route
// (lib/html-preview.ts) adds a policy that loads nothing from anywhere –
// external pictures, styles and fonts stay away, which the note says. No
// verdict on the file: it is shown inert, not judged. Larger files than
// the server's preview limit (FLOWPLAN_HTML_PREVIEW_MB) are only downloaded.
//
// "Run scripts" (for this opening only, unless remembered – see below): the frame is
// replaced by one with sandbox="allow-scripts" – never the same origin,
// top navigation, popups, forms or modals – that loads the preview with
// ?scripts=1, whose policy runs the file's inline scripts and still loads
// nothing from anywhere. The page's origin stays opaque: no access to the
// app, the session or its data. "Stop scripts" loads it inert again. The
// button is there only if the server allows it (FLOWPLAN_HTML_PREVIEW_SCRIPTS,
// told by the HEAD request's X-Flowplan-Preview-Scripts).
//
// "Bei dieser Datei immer zulassen" (#425, lib/html-scripts-trust.ts): the
// person's own files (/api/files/<id>, never shared links or published
// pages) can be remembered in their account – the viewer then starts with
// scripts running on all their devices, isolated just the same. The HEAD
// request says whether it is (X-Flowplan-Preview-Remembered, "yes"/"no";
// the header is missing where the box is not offered or scripts are off).
// The server keys it to the file's content: a changed file asks again.
// Unticking forgets it (scripts keep running for this opening).
import { useEffect, useRef, useState } from "react";
import { DownloadSimple, FileHtml, Info, Play, Stop, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { htmlPreviewUrl } from "@/lib/html-files";
import { api } from "./ui";
import "@/app/viewer3d.css";
import "@/app/html-viewer.css";

type State = "loading" | "ready" | "large" | "missing" | "failed";

// The id of one's own uploaded file (/api/files/<id>), else null.
const ownFileId = (src: string) => /\/api\/files\/([0-9a-f-]{36})(?:[?#]|$)/i.exec(src)?.[1] ?? null;

export default function HtmlViewerDialog({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  const t = useT();
  const [state, setState] = useState<State>("loading");
  const [scriptsAllowed, setScriptsAllowed] = useState(false);
  const [scripts, setScripts] = useState(false);
  // The box: offered (null = not), and whether it is ticked.
  const [always, setAlways] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const fileId = ownFileId(src);
  const name = title || "HTML";
  const preview = htmlPreviewUrl(src);
  const dialog = useRef<HTMLDivElement>(null);

  // Asked first (HEAD): a file too large or gone gets a message here, not
  // an error page in the frame.
  useEffect(() => {
    const controller = new AbortController();
    fetch(preview, { method: "HEAD", credentials: "same-origin", signal: controller.signal })
      .then((response) => {
        const allowed = response.ok && response.headers.get("X-Flowplan-Preview-Scripts") === "allowed";
        setScriptsAllowed(allowed);
        const remembered = response.headers.get("X-Flowplan-Preview-Remembered");
        const offered = allowed && !!fileId && (remembered === "yes" || remembered === "no");
        setAlways(offered ? remembered === "yes" : null);
        // Remembered with this content: scripts from the start.
        setScripts(offered && remembered === "yes");
        setState(response.ok ? "ready" : response.status === 413 ? "large" : [403, 404, 410, 415].includes(response.status) ? "missing" : "failed");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("failed");
      });
    return () => controller.abort();
  }, [preview, fileId]);

  const remember = async (allow: boolean) => {
    if (!fileId) return;
    // Shown at once; undone if the server refuses.
    setSaving(true);
    setProblem("");
    setAlways(allow);
    if (allow) setScripts(true);
    try {
      await api("/api/command", { action: "profile.htmlScripts", fileId, allow });
    } catch (e) {
      setAlways(!allow);
      setProblem((e as Error).message || t("Konnte nicht gespeichert werden.", "Could not be saved."));
    } finally {
      setSaving(false);
    }
  };

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    // Keys pressed inside the frame stay there; Escape works around it.
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", key);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = previous;
      opener?.focus?.();
    };
  }, []);

  const download = (
    <a className="icon-button" href={src} download={name} aria-label={t("Herunterladen", "Download")} title={t("Original herunterladen", "Download the original")}>
      <DownloadSimple size={18} />
    </a>
  );
  return (
    <div className="viewer3d html-viewer" role="dialog" aria-modal="true" aria-label={name} ref={dialog} tabIndex={-1}>
      <header className="viewer3d-bar">
        <FileHtml size={20} aria-hidden />
        <strong title={name}>{name}</strong>
        <span className="viewer3d-format">HTML</span>
        <span className="viewer3d-actions">
          {download}
          <button type="button" className="icon-button" aria-label={t("Schließen", "Close")} title={t("Schließen", "Close")} onClick={onClose}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className={scripts ? "html-viewer-note is-running" : "html-viewer-note"}>
        <Info size={16} aria-hidden />
        <span className="html-viewer-note-text" role="status">
          {scripts
            ? t("Skripte laufen abgeschottet, ohne Netzwerk.", "Scripts run isolated, without network.")
            : t("Skripte und externe Inhalte sind abgeschaltet.", "Scripts and external content are switched off.")}
          {always && state === "ready" && (
            <span className="html-viewer-note-more">
              {" "}
              {t(
                "Für diese Datei immer zugelassen, auf all deinen Geräten – ändert sich die Datei, fragt Flowplan erneut.",
                "Always allowed for this file, on all your devices – if the file changes, Flowplan asks again.",
              )}
            </span>
          )}
          {!scripts && !always && scriptsAllowed && state === "ready" && (
            <span className="html-viewer-note-more">
              {" "}
              {t(
                "Skripte ausführen lässt sie abgeschottet laufen: ohne Zugriff auf Flowplan, deine Sitzung oder Daten, ohne Netzwerk, Pop-ups oder Weiterleitungen.",
                "Run scripts lets them run isolated: no access to Flowplan, your session or data, no network, no pop-ups or redirects.",
              )}
            </span>
          )}
        </span>
        {problem && (
          <span className="html-viewer-problem-text" role="alert">
            {problem}
          </span>
        )}
        {always !== null && scriptsAllowed && state === "ready" && (
          <label className="html-viewer-remember" title={t("Nur für dich; ändert sich die Datei, fragt Flowplan erneut.", "Only for you; if the file changes, Flowplan asks again.")}>
            <input type="checkbox" checked={always} disabled={saving} onChange={(event) => void remember(event.target.checked)} />
            {t("Bei dieser Datei immer zulassen", "Always allow for this file")}
          </label>
        )}
        {scriptsAllowed && state === "ready" && (
          <button type="button" className="button html-viewer-scripts" onClick={() => setScripts(!scripts)}>
            {scripts ? <Stop size={14} aria-hidden /> : <Play size={14} aria-hidden />}
            {scripts ? t("Skripte anhalten", "Stop scripts") : t("Skripte ausführen", "Run scripts")}
          </button>
        )}
      </div>
      <div className="viewer3d-stage html-viewer-stage">
        {state === "ready" &&
          (scripts ? (
            // Scripts only (see above); keyed, so the page starts afresh.
            <iframe
              key="scripts"
              className="html-viewer-frame"
              src={`${preview}?scripts=1`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              title={t(`Vorschau von ${name}`, `Preview of ${name}`)}
            />
          ) : (
            // An empty sandbox: everything off (see above).
            <iframe key="inert" className="html-viewer-frame" src={preview} sandbox="" referrerPolicy="no-referrer" title={t(`Vorschau von ${name}`, `Preview of ${name}`)} />
          ))}
        {state === "loading" && (
          <p className="viewer3d-message" role="status">
            {t("Vorschau wird geladen …", "Loading preview …")}
          </p>
        )}
        {state !== "loading" && state !== "ready" && (
          <div className="viewer3d-message is-error html-viewer-problem" role="alert">
            <p>
              {state === "large"
                ? t("Die Datei ist zu groß für die Vorschau. Du kannst sie herunterladen.", "The file is too large for the preview. You can download it.")
                : state === "missing"
                  ? t("Diese Datei ist nicht (mehr) verfügbar.", "This file is not available (any more).")
                  : t("Die Vorschau konnte nicht geladen werden.", "The preview could not be loaded.")}
            </p>
            {state !== "missing" && (
              <a className="button" href={src} download={name}>
                <DownloadSimple size={16} aria-hidden /> {t("Herunterladen", "Download")}
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
