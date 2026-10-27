"use client";
// A small live preview on page cards of the board: the first lines of the
// document (the hover-card summary, /api/pages/<id>/preview), shown when
// the card is tall enough. Kept for a minute per page and device.
import { useEffect, useState } from "react";

type Preview = { excerpt: string; at: number };
const cache = new Map<string, Preview>();
const pending = new Map<string, Promise<Preview | null>>();
function load(pageId: string) {
  const known = cache.get(pageId);
  if (known && Date.now() - known.at < 60_000) return Promise.resolve(known);
  let request = pending.get(pageId);
  if (!request) {
    request = fetch(`/api/pages/${pageId}/preview`, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return null;
        const data = (await response.json()) as { excerpt?: unknown };
        const preview = { excerpt: typeof data.excerpt === "string" ? data.excerpt : "", at: Date.now() };
        cache.set(pageId, preview);
        return preview;
      })
      .catch(() => null)
      .finally(() => pending.delete(pageId));
    pending.set(pageId, request);
  }
  return request;
}
export function CardExcerpt({ pageId }: { pageId: string }) {
  const [text, setText] = useState(() => cache.get(pageId)?.excerpt || "");
  useEffect(() => {
    let alive = true;
    void load(pageId).then((preview) => alive && preview && setText(preview.excerpt));
    return () => {
      alive = false;
    };
  }, [pageId]);
  return text ? <span className="wb-card-excerpt">{text}</span> : null;
}
