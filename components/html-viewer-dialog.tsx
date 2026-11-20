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
import { useEffect, useRef, useState } from "react";
import { DownloadSimple, FileHtml, Info, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { htmlPreviewUrl } from "@/lib/html-files";
import "@/app/viewer3d.css";
import "@/app/html-viewer.css";

type State = "loading" | "ready" | "large" | "missing" | "failed";

export default function HtmlViewerDialog({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  const t = useT();
  const [state, setState] = useState<State>("loading");
  const name = title || "HTML";
  const preview = htmlPreviewUrl(src);
  const dialog = useRef<HTMLDivElement>(null);

  // Asked first (HEAD): a file too large or gone gets a message here, not
  // an error page in the frame.
  useEffect(() => {
    const controller = new AbortController();
    fetch(preview, { method: "HEAD", credentials: "same-origin", signal: controller.signal })
      .then((response) =>
        setState(response.ok ? "ready" : response.status === 413 ? "large" : [403, 404, 410, 415].includes(response.status) ? "missing" : "failed"),
      )
      .catch(() => {
        if (!controller.signal.aborted) setState("failed");
      });
    return () => controller.abort();
  }, [preview]);

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
      <p className="html-viewer-note">
        <Info size={16} aria-hidden />
        <span>{t("Skripte und externe Inhalte sind abgeschaltet.", "Scripts and external content are switched off.")}</span>
      </p>
      <div className="viewer3d-stage html-viewer-stage">
        {state === "ready" && (
          // An empty sandbox: everything off (see above).
          <iframe className="html-viewer-frame" src={preview} sandbox="" referrerPolicy="no-referrer" title={t(`Vorschau von ${name}`, `Preview of ${name}`)} />
        )}
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
