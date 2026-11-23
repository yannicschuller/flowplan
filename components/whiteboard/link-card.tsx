"use client";
// Web pages on the board (#455): any address that is no player of the
// embed allowlist becomes a link card – title, site, description, picture
// and icon from GET /api/embed (lib/oembed.ts: the server reads the page
// SSRF-checked, size- and time-limited, without cookies). The preview is
// stored with the element, so viewers load nothing but the picture and the
// icon, straight from the site and without a referrer (like the editor's
// link cards). The title is a link (new tab, the system browser in the
// apps); a double click opens it too. Table cells with a lone address show
// the same preview, small (TableCellContent).
import { useState } from "react";
import { Play } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { useBoardColors } from "./board-colors";
import { boardEmbed, linkPreviewSchema } from "@/lib/whiteboard-embeds";
import { cellLink, cellParts, type LinkPreview } from "@/lib/whiteboard-tables";
import type { WhiteboardItem } from "@/lib/whiteboard-model";

// What GET /api/embed says about an address: a player of the allowlist
// (announced through oEmbed) or a page's preview; null when it has none.
export type FoundLink = { kind: "player"; src: string; provider: string } | { kind: "page"; preview: LinkPreview } | null;
export async function findLink(url: string): Promise<FoundLink> {
  try {
    const response = await fetch(`/api/embed?url=${encodeURIComponent(url)}`, { cache: "no-store" });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    if (data.kind === "player" && typeof data.src === "string" && typeof data.provider === "string")
      return { kind: "player", src: data.src, provider: data.provider };
    if (data.kind !== "card") return null;
    const parsed = linkPreviewSchema.safeParse({
      title: data.title,
      site: data.provider,
      description: data.description || undefined,
      image: data.image || undefined,
      icon: data.icon || undefined,
    });
    return parsed.success ? { kind: "page", preview: parsed.data } : null;
  } catch {
    return null;
  }
}
// The card's preview until (or when) the server finds none: the host.
export function hostPreview(url: string): LinkPreview {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return { title: host, site: host };
}

// A picture from another site: no referrer, gone when it does not load.
function WebImage({ src, className }: { src?: string; className: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return null;
  return <img className={className} src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(src)} />;
}

export function LinkCardShape({ item, transform }: { item: WhiteboardItem; transform: string }) {
  const colors = useBoardColors();
  const embed = boardEmbed(item);
  if (embed?.kind !== "link") return null;
  const parsed = linkPreviewSchema.safeParse(item.preview);
  const preview = parsed.success ? parsed.data : hostPreview(embed.url);
  const w = Math.max(1, item.w),
    h = Math.max(1, item.h);
  // The picture only where the card leaves room for the text below it.
  const picture = preview.image && h >= 170 ? preview.image : undefined;
  return (
    <g transform={transform}>
      <rect width={w} height={h} rx={10} fill={colors.fill("#ffffff")} stroke={colors.line("#dee2e6")} filter="url(#wb-shadow)" />
      <foreignObject width={w} height={h}>
        <div className={`wb-linkcard${picture ? " with-image" : ""}`}>
          <WebImage className="wb-linkcard-image" src={picture} />
          <div className="wb-linkcard-body">
            <span className="wb-linkcard-site">
              <WebImage className="wb-linkcard-icon" src={preview.icon} />
              <span>{preview.site}</span>
            </span>
            <a className="wb-linkcard-title" href={embed.url} data-wb-href={embed.url} target="_blank" rel="noopener noreferrer nofollow" title={embed.url}>
              {preview.title}
            </a>
            {preview.description && <span className="wb-linkcard-text">{preview.description}</span>}
          </div>
        </div>
      </foreignObject>
    </g>
  );
}

// A table cell: its text with web addresses as links; a lone address as a
// small card – a player of the allowlist with its still picture (a click
// plays it in a frame, components/whiteboard/player-dialog.tsx), a page
// with its preview once the table has one.
export function TableCellContent({ text, links }: { text: string; links?: Record<string, LinkPreview> }) {
  const t = useT();
  const link = cellLink(text, links);
  if (link?.kind === "player")
    return (
      <span className="wb-cell-card wb-cell-video">
        <span className="wb-cell-thumb">
          <WebImage className="wb-cell-thumb-image" src={link.thumbnail} />
          <button type="button" className="wb-cell-play" data-wb-play={link.url} aria-label={t(`${link.provider} abspielen`, `Play ${link.provider}`)} title={t(`${link.provider} abspielen`, `Play ${link.provider}`)}>
            <Play size={14} weight="fill" />
          </button>
        </span>
        <a className="wb-link" href={link.url} data-wb-href={link.url} target="_blank" rel="noopener noreferrer nofollow" title={link.url}>
          {link.provider}
        </a>
      </span>
    );
  if (link?.kind === "page" && link.preview) {
    const parsed = linkPreviewSchema.safeParse(link.preview);
    if (parsed.success) {
      const preview = parsed.data;
      return (
        <span className="wb-cell-card">
          <WebImage className="wb-cell-thumb-image wb-cell-thumb" src={preview.image || preview.icon} />
          <span className="wb-cell-card-text">
            <a className="wb-link" href={link.url} data-wb-href={link.url} target="_blank" rel="noopener noreferrer nofollow" title={link.url}>
              {preview.title}
            </a>
            <small>{preview.site}</small>
          </span>
        </span>
      );
    }
  }
  const parts = cellParts(text);
  if (!parts.some((part) => part.href)) return <>{text}</>;
  return (
    <span className="wb-cell-text">
      {parts.map((part, i) =>
        part.href ? (
          <a key={i} className="wb-link" href={part.href} data-wb-href={part.href} target="_blank" rel="noopener noreferrer nofollow">
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </span>
  );
}
