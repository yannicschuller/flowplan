"use client";
// Web addresses on the board (#455), used by board-extras.tsx: a pasted or
// embedded address becomes a player of the allowlist or a link card, table
// cells with a lone address get its preview or still picture (stored on
// the table, so it is fetched once by someone who may edit, not by every
// viewer), and the play buttons of video cells open the player.
//
// Pictures are files of the board (POST /api/whiteboards/<id>/links,
// lib/link-pictures.ts); nothing is loaded from another site while the
// board is viewed. Previews of older versions that still name a picture of
// another site, and players and video cells without a still picture, are
// fetched anew once when someone who may edit opens the board.
import { useEffect, useRef, useState } from "react";
import { PlayerDialog } from "./player-dialog";
import { findBoardLink, hostPreview, remotePictures, type FoundLink } from "./link-card";
import { boardEmbed, embedForUrl, linkPreviewSchema, webUrl, type PlayerEmbed } from "@/lib/whiteboard-embeds";
import { embedFromUrl } from "@/lib/embed-providers";
import { keptLinks, soleUrl, tablePageLinks, type LinkPreview } from "@/lib/whiteboard-tables";
import type { WhiteboardItem } from "@/lib/whiteboard-model";
import type { BoardApi } from "./board-extras";

// What the server found in this tab, by board and address (failures as null).
const found = new Map<string, Promise<FoundLink>>();
const lookup = (pageId: string, url: string) => {
  const key = `${pageId}\n${url}`;
  let known = found.get(key);
  if (!known) {
    known = findBoardLink(pageId, url);
    found.set(key, known);
  }
  return known;
};
// Players whose provider has still pictures (YouTube, Vimeo).
const STILLS = /^https:\/\/(www\.youtube-nocookie\.com|player\.vimeo\.com)\//;
// What a table keeps for an address the server found.
const kept = (link: FoundLink): LinkPreview | null =>
  !link ? null : link.kind === "page" ? link.preview : { title: link.provider, site: link.provider, ...(link.image ? { image: link.image } : {}) };
// Changes nobody undoes (they follow from an edit): synced, not in the
// undo history (whiteboard.tsx tracks only its own origin).
const PREVIEW = "link-preview";

export function useBoardLinks(
  api: Pick<BoardApi, "pageId" | "editable" | "guest" | "items" | "itemsMap" | "change" | "setProps" | "addItem" | "setSelection" | "center" | "svg" | "view">,
  addEmbed: (embed: PlayerEmbed, url: string) => void,
) {
  const ref = useRef(api);
  ref.current = api;
  const [playing, setPlaying] = useState<string | null>(null);
  const store = (id: string, props: Partial<WhiteboardItem>) => {
    const map = ref.current.itemsMap;
    map.doc?.transact(() => ref.current.setProps(id, props), PREVIEW);
  };

  // A link card for a page: placed at once with the host as its title, the
  // preview filled in when the server has one. An address the server finds
  // a player for (oEmbed of the allowlist) becomes that player.
  const addLink = (raw: string, at = ref.current.center()) => {
    const url = webUrl(raw);
    if (!url) return false;
    const rect = ref.current.svg.current?.getBoundingClientRect();
    const scale = rect?.width ? Math.min(1, (rect.width * 0.85) / ref.current.view.zoom / 340) : 1;
    const w = Math.round(340 * scale),
      h = Math.round(120 * scale);
    let id = "";
    ref.current.change(() => {
      id = ref.current.addItem({ type: "embed", url, preview: hostPreview(url), x: at.x - w / 2, y: at.y - h / 2, w, h });
    });
    ref.current.setSelection(new Set([id]));
    if (!/^https:/.test(url) || ref.current.guest) return true;
    void lookup(ref.current.pageId, url).then((link) => {
      const item = ref.current.itemsMap.get(id);
      if (!item || !link) return;
      if (link.kind === "player")
        store(id, { src: link.src, text: link.provider, preview: kept(link)!, h: Math.round((w * 300) / 480) });
      else {
        // Room for the picture above the text.
        const tall = link.preview.image ? Math.round(w * 0.78) : h;
        store(id, { preview: link.preview, h: Math.max(Number(item.get("h")) || h, tall) });
      }
    });
    return true;
  };
  // Pasting a lone address (whiteboard.tsx onPaste).
  const pasteLink = (text: string) => {
    if (!ref.current.editable) return false;
    const url = soleUrl(text);
    if (!url) return false;
    const embed = embedForUrl(url);
    if (embed) addEmbed(embed, url);
    else addLink(url);
    return true;
  };
  // A double click on a link card opens the page.
  const openCard = (item: WhiteboardItem | undefined) => {
    const embed = item ? boardEmbed(item) : null;
    if (embed?.kind !== "link") return false;
    window.open(embed.url, "_blank", "noopener,noreferrer");
    return true;
  };

  // A moment after the last change, by those who may edit: previews of
  // lone addresses in table cells fetched, those of addresses no cell holds
  // any more removed; stills of players and pictures of older previews
  // fetched as files of the board.
  const { items, guest } = api;
  const editable = api.editable && !guest;
  useEffect(() => {
    if (!editable) return;
    const timer = setTimeout(() => {
      const pageId = ref.current.pageId;
      const now = (id: string) => ref.current.itemsMap.get(id)?.toJSON() as WhiteboardItem | undefined;
      for (const item of ref.current.items) {
        if (item.locked) continue;
        if (item.type === "table") {
          const links = keptLinks(item);
          if (Object.keys(links || {}).length !== Object.keys(item.links || {}).length) store(item.id, { links });
          for (const url of tablePageLinks(item)) {
            const entry = links?.[url];
            if ((entry && !remotePictures(entry)) || !/^https:/.test(url)) continue;
            void lookup(pageId, url).then((link) => {
              const table = now(item.id);
              const value = kept(link);
              if (!value || !table || !tablePageLinks(table).includes(url)) return;
              const before = table.links?.[url];
              if (before && !remotePictures(before)) return;
              store(item.id, { links: { ...(keptLinks(table) || {}), [url]: value } });
            });
          }
          continue;
        }
        const embed = boardEmbed(item);
        // A link card of an older version with pictures of the other site.
        if (embed?.kind === "link" && remotePictures(item.preview) && /^https:/.test(embed.url))
          void lookup(pageId, embed.url).then((link) => {
            const card = now(item.id);
            if (!card || !remotePictures(card.preview)) return;
            // Without a new preview the text stays, the pictures go.
            const text = linkPreviewSchema.safeParse(card.preview);
            store(item.id, { preview: link?.kind === "page" ? link.preview : text.success ? text.data : hostPreview(embed.url) });
          });
        // A player of YouTube or Vimeo without its still picture (exports).
        if (embed?.kind === "player" && !item.preview && STILLS.test(embed.src) && embedFromUrl(embed.src))
          void lookup(pageId, embed.src).then((link) => {
            const player = now(item.id);
            if (!player || player.preview || player.src !== embed.src || link?.kind !== "player") return;
            store(item.id, { preview: kept(link)! });
          });
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [items, editable]);

  return {
    addLink,
    pasteLink,
    openCard,
    play: setPlaying,
    overlay: playing ? <PlayerDialog url={playing} onClose={() => setPlaying(null)} /> : null,
  };
}
