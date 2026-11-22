"use client";
import type { ReactNode } from "react";

// "Zurück" on the 404 page (app/not-found.tsx): the browser's previous
// entry; a tab opened with this address has none – then, as without
// JavaScript, the link's own target.
export function HistoryBackLink({ href = "/", className, children }: { href?: string; className?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (window.history.length <= 1) return;
        e.preventDefault();
        window.history.back();
      }}
    >
      {children}
    </a>
  );
}
