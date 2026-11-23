"use client";
// A video or other player of the embed allowlist from a table cell (#455):
// the cell shows a still picture, the click on its play button is the
// consent to load the provider – in the same sandboxed frame as the
// board's embed elements (lib/whiteboard-embeds.ts).
import { useT } from "../i18n";
import { Modal } from "../ui";
import { EMBED_ALLOW, EMBED_SANDBOX, embedForUrl } from "@/lib/whiteboard-embeds";

export function PlayerDialog({ url, onClose }: { url: string | null; onClose: () => void }) {
  const t = useT();
  const embed = url ? embedForUrl(url) : null;
  if (!url || embed?.kind !== "player") return null;
  return (
    <Modal open onClose={onClose} title={embed.provider} wide className="wb-player-dialog">
      <div className="wb-player">
        <iframe
          src={embed.src}
          title={embed.provider}
          sandbox={EMBED_SANDBOX}
          allow={EMBED_ALLOW}
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
      <p className="muted">
        <a href={url} target="_blank" rel="noopener noreferrer nofollow">
          {t("Beim Anbieter öffnen", "Open at the provider")}
        </a>
      </p>
    </Modal>
  );
}
