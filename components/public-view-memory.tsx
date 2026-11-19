"use client";
// The scroll position of a published database view (#393): kept in
// sessionStorage (this tab only, no cookie) when a record is opened from
// it, and restored when the record's "← Back to …" link returns to it –
// not on other visits of the view. Without storage both simply do nothing.
import { useEffect } from "react";
import { RETURN_KEY } from "@/lib/public-nav";

// Containers of a view that scroll sideways (wide tables, boards, timelines).
const SIDEWAYS = ".data-table-scroll, .board, .public-timeline, .public-calendar";

type Saved = { y: number; x: number[] };

export function PublicViewMemory({ storageKey }: { storageKey: string }) {
  useEffect(() => {
    try {
      if (sessionStorage.getItem(RETURN_KEY) === storageKey) {
        sessionStorage.removeItem(RETURN_KEY);
        const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null") as Saved | null;
        if (saved) {
          document.querySelectorAll<HTMLElement>(SIDEWAYS).forEach((el, i) => {
            if (saved.x[i]) el.scrollLeft = saved.x[i];
          });
          window.scrollTo(0, saved.y);
        }
      }
    } catch {}
    const remember = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!link || !/[?&]row=/.test(link.getAttribute("href") || "")) return;
      try {
        const x = [...document.querySelectorAll<HTMLElement>(SIDEWAYS)].map((el) => Math.round(el.scrollLeft));
        sessionStorage.setItem(storageKey, JSON.stringify({ y: Math.round(window.scrollY), x } satisfies Saved));
      } catch {}
    };
    document.addEventListener("click", remember, true);
    return () => document.removeEventListener("click", remember, true);
  }, [storageKey]);
  return null;
}

// "← Back to <view>": a plain link (works without JavaScript); a click marks
// the view so it restores its scroll position.
export function PublicBackLink({ href, storageKey, children }: { href: string; storageKey: string; children: React.ReactNode }) {
  return (
    <a
      className="public-back"
      href={href}
      onClick={() => {
        try {
          sessionStorage.setItem(RETURN_KEY, storageKey);
        } catch {}
      }}
    >
      {children}
    </a>
  );
}
