"use client";
import { useEffect, useRef, useState } from "react";
import { api, PageIcon } from "./ui";
import { parsePageLocation } from "@/lib/page-location";

type Preview = {
  id: string;
  title: string;
  icon: string;
  kind: "document" | "database";
  space: string;
  excerpt: string;
  rows: number;
  updatedAt: string;
};
type Card =
  | { kind: "page"; rect: DOMRect; preview: Preview | null; error?: string }
  | { kind: "person"; rect: DOMRect; name: string; email: string };

// Hover cards for page links and person mentions in documents, comments and
// database cells. Previews are fetched once per page and respect permissions.
export function LinkPreview({
  members,
}: {
  members: { id: string; name: string; email: string }[];
}) {
  const [card, setCard] = useState<Card | null>(null);
  const cache = useRef(new Map<string, Preview | string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<Element | null>(null);
  useEffect(() => {
    const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      current.current = null;
      setCard(null);
    };
    const show = (target: Element) => {
      if (current.current === target) return;
      if (timer.current) clearTimeout(timer.current);
      current.current = target;
      timer.current = setTimeout(async () => {
        const rect = target.getBoundingClientRect();
        const person = target.getAttribute("data-mention");
        if (person) {
          const member = members.find((m) => m.id === person);
          if (member)
            setCard({
              kind: "person",
              rect,
              name: member.name,
              email: member.email,
            });
          return;
        }
        const href = target.getAttribute("href") || "";
        const location = parsePageLocation(href.slice(href.indexOf("#")));
        if (!location) return;
        const cached = cache.current.get(location.pageId);
        if (cached && typeof cached !== "string") {
          setCard({ kind: "page", rect, preview: cached });
          return;
        }
        setCard({ kind: "page", rect, preview: null });
        try {
          const preview =
            cached === undefined
              ? await api<Preview>(`/api/pages/${location.pageId}/preview`)
              : null;
          if (!preview) throw new Error(String(cached));
          cache.current.set(location.pageId, preview);
          if (current.current === target)
            setCard({ kind: "page", rect, preview });
        } catch (e) {
          const message = (e as Error).message || "Nicht verfügbar";
          cache.current.set(location.pageId, message);
          if (current.current === target)
            setCard({ kind: "page", rect, preview: null, error: message });
        }
      }, 350);
    };
    const over = (event: Event) => {
      const target = (event.target as Element | null)?.closest?.(
        'a[href*="#page="], span[data-mention]',
      );
      if (!target || target.closest(".sidebar, .link-preview")) return;
      show(target);
    };
    const out = (event: Event) => {
      const related = (event as MouseEvent).relatedTarget as Element | null;
      if (current.current && related && current.current.contains(related))
        return;
      if (
        (event.target as Element | null)?.closest?.(
          'a[href*="#page="], span[data-mention]',
        )
      )
        clear();
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", over);
    document.addEventListener("mouseout", out);
    document.addEventListener("focusout", out);
    window.addEventListener("scroll", clear, true);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", over);
      document.removeEventListener("mouseout", out);
      document.removeEventListener("focusout", out);
      window.removeEventListener("scroll", clear, true);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [members]);
  if (!card) return null;
  const top = Math.min(card.rect.bottom + 6, window.innerHeight - 170),
    left = Math.max(8, Math.min(card.rect.left, window.innerWidth - 328));
  return (
    <div className="link-preview" role="tooltip" style={{ top, left }}>
      {card.kind === "person" ? (
        <>
          <strong>{card.name}</strong>
          <small>{card.email}</small>
        </>
      ) : card.preview ? (
        <>
          <strong>
            <PageIcon
              name={
                card.preview.kind === "database" ? "table" : card.preview.icon
              }
              size={16}
            />
            {card.preview.title}
          </strong>
          <small>
            {card.preview.space}
            {card.preview.kind === "database"
              ? ` · ${card.preview.rows} Einträge`
              : ""}
          </small>
          {card.preview.excerpt && <p>{card.preview.excerpt}</p>}
        </>
      ) : (
        <small>{card.error || "Vorschau wird geladen …"}</small>
      )}
    </div>
  );
}
