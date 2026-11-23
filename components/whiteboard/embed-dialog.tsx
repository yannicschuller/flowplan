"use client";
// "Einbetten": a video or page of the allowlist by its address, or a PDF
// from this device (stored with the board's files) – both become embed
// elements (lib/whiteboard-embeds.ts). Any other web address becomes a
// link card with the page's preview (#455).
import { useRef, useState } from "react";
import { FilePdf, VideoCamera } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal } from "../ui";
import { embedProviders } from "@/lib/embed-providers";
import { embedForUrl, type PlayerEmbed } from "@/lib/whiteboard-embeds";

export function EmbedDialog({
  open,
  onClose,
  onEmbed,
  onLink,
  onPdf,
}: {
  open: boolean;
  onClose: () => void;
  onEmbed: (embed: PlayerEmbed, url: string) => void;
  // Any other web address: a link card (false when it is none).
  onLink: (url: string) => boolean;
  onPdf: (file: File) => Promise<void>;
}) {
  const t = useT();
  const [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const providers = embedProviders.map((p) => p.name).join(", ");
  return (
    <Modal open={open} onClose={onClose} title={t("Einbetten", "Embed")} sheet className="wb-embed-dialog">
      <form
        className="wb-embed-form"
        onSubmit={(e) => {
          e.preventDefault();
          const embed = embedForUrl(url);
          if (!embed) {
            if (!onLink(url.trim())) return setError(t("Das ist keine Webadresse (http oder https).", "This is not a web address (http or https)."));
            setError("");
            setUrl("");
            return;
          }
          setError("");
          setUrl("");
          onEmbed(embed, url.trim());
        }}
      >
        <label htmlFor="wb-embed-url">
          <VideoCamera size={16} aria-hidden="true" /> {t("Video oder Webseite", "Video or web page")}
        </label>
        <div className="wb-embed-url">
          <input
            id="wb-embed-url"
            type="url"
            inputMode="url"
            value={url}
            autoFocus
            placeholder="https://www.youtube.com/watch?v=…"
            onChange={(e) => setUrl(e.target.value)}
            aria-describedby="wb-embed-help"
          />
          <button className="button primary" disabled={!url.trim()}>
            {t("Einbetten", "Embed")}
          </button>
        </div>
        <p id="wb-embed-help" className="muted">
          {t(
            `Abspielbar: ${providers}. Auf dem Board erscheint zuerst eine Vorschau – Inhalte des Anbieters laden erst nach einem Klick, in einem abgeschotteten Rahmen. YouTube läuft über youtube-nocookie.com. Jede andere Webseite wird eine Linkkarte mit Titel, Bild und Beschreibung der Seite.`,
            `Playable: ${providers}. The board shows a preview first – the provider's content loads only after a click, in an isolated frame. YouTube runs through youtube-nocookie.com. Any other web page becomes a link card with the page's title, picture and description.`,
          )}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
      <div className="wb-embed-form">
        <span className="wb-embed-label">
          <FilePdf size={16} aria-hidden="true" /> {t("PDF", "PDF")}
        </span>
        <button type="button" className="button" disabled={busy} onClick={() => file.current?.click()}>
          {busy ? t("Wird hochgeladen …", "Uploading …") : t("PDF hochladen …", "Upload PDF …")}
        </button>
        <p className="muted">{t("Die Seiten erscheinen als Vorschau auf dem Board; ein Doppelklick öffnet den PDF-Betrachter.", "The pages appear as a preview on the board; a double click opens the PDF viewer.")}</p>
        <input
          ref={file}
          type="file"
          hidden
          accept="application/pdf,.pdf"
          aria-label={t("PDF für das Whiteboard", "PDF for the whiteboard")}
          onChange={async (e) => {
            const chosen = e.target.files?.[0];
            e.target.value = "";
            if (!chosen) return;
            setBusy(true);
            try {
              await onPdf(chosen);
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
    </Modal>
  );
}
