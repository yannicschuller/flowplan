"use client";
// Web addresses on the board (#455), used by board-extras.tsx: a pasted or
// embedded address becomes a player of the allowlist or a link card, table
// cells with a lone page address get its preview (stored on the table, so
// it is fetched once by someone who may edit, not by every viewer), and the
// play buttons of video cells open the player.
import { useEffect, useRef, useState } from "react";
import { PlayerDialog } from "./player-dialog";
import { findLink, hostPreview } from "./link-card";
import { boardEmbed, embedForUrl, webUrl, type PlayerEmbed } from "@/lib/whiteboard-embeds";
import { keptLinks, soleUrl, tablePageLinks, type LinkPreview } from "@/lib/whiteboard-tables";
import type { WhiteboardItem } from "@/lib/whiteboard-model";
import type { BoardApi } from "./board-extras";

// Previews fetched in this tab, by address (failures as null).
const found = new Map<string, Promise<LinkPreview | null>>();
const previewOf = (url: string) => {
  let known = found.get(url);
  if (!known) {
    known = findLink(url).then((link) => (link?.kind === "page" ? link.preview : null));
    found.set(url, known);
  }
  return known;
};
// Changes nobody undoes (they follow from an edit): synced, not in the
// undo history (whiteboard.tsx tracks only its own origin).
const PREVIEW = "link-preview";

export function useBoardLinks(
  api: Pick<BoardApi, "editable" | "items" | "itemsMap" | "change" | "setProps" | "addItem" | "setSelection" | "center" | "svg" | "view">,
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
    if (!/^https:/.test(url)) return true;
    void findLink(url).then((link) => {
      const item = ref.current.itemsMap.get(id);
      if (!item || !link) return;
      if (link.kind === "player")
        store(id, { src: link.src, text: link.provider, preview: undefined, h: Math.round((w * 300) / 480) });
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

  // Previews of lone page addresses in table cells: wanted ones fetched,
  // those of addresses no cell holds any more removed – a moment after the
  // last change, by those who may edit.
  const { items, editable } = api;
  useEffect(() => {
    if (!editable) return;
    const timer = setTimeout(() => {
      for (const table of ref.current.items) {
        if (table.type !== "table" || table.locked) continue;
        const kept = keptLinks(table);
        if (Object.keys(kept || {}).length !== Object.keys(table.links || {}).length) store(table.id, { links: kept });
        for (const url of tablePageLinks(table)) {
          if (kept?.[url] || !/^https:/.test(url)) continue;
          void previewOf(url).then((preview) => {
            const now = ref.current.itemsMap.get(table.id)?.toJSON() as WhiteboardItem | undefined;
            if (!preview || !now || !tablePageLinks(now).includes(url) || now.links?.[url]) return;
            store(table.id, { links: { ...(keptLinks(now) || {}), [url]: preview } });
          });
        }
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
