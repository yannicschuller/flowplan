"use client";
// The HTML viewer (#398) for uploaded .html/.htm files. openHtml() opens it
// from anywhere; the host is mounted once in the root layout like the 3D
// viewer's (model-viewer.tsx) and loads the dialog
// (html-viewer-dialog.tsx) only when a file is opened. The page is shown in
// an <iframe sandbox=""> from the preview route (lib/html-preview.ts): no
// scripts, no forms, nothing loaded from elsewhere. Links to such files
// (documents, record attachments, the media library, read-only and
// published pages) open it instead of downloading; in text being edited
// only with ⌘/Ctrl.
import { Suspense, lazy, useEffect, useState } from "react";
import { loadView } from "@/components/view-fallback";
import { isHtmlName } from "@/lib/html-files";
import { fileLink } from "./pdf-viewer";

const HtmlViewerDialog = lazy(() => loadView(() => import("./html-viewer-dialog")));
const EVENT = "flowplan:html";

export function openHtml(src: string, title: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { src, title } }));
}

export function HtmlViewerHost() {
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.hasAttribute("download")) return;
      const href = link.getAttribute("href") || "";
      if (!fileLink.test(href)) return;
      const block = link.closest<HTMLElement>(".html-block");
      const title = link.dataset.html || block?.dataset.title || link.textContent?.trim() || "";
      if (!isHtmlName(title)) return;
      if (link.closest("[contenteditable=true]") && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      openHtml(href, title);
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, []);
  const [open, setOpen] = useState<{ src: string; title: string; n: number } | null>(null);
  useEffect(() => {
    let n = 0;
    const show = (event: Event) => {
      const detail = (event as CustomEvent<{ src: string; title: string }>).detail;
      if (!fileLink.test(detail?.src || "") || !isHtmlName(detail?.title || "")) return;
      setOpen({ src: detail.src, title: detail.title, n: ++n });
    };
    window.addEventListener(EVENT, show);
    return () => window.removeEventListener(EVENT, show);
  }, []);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <HtmlViewerDialog key={open.n} src={open.src} title={open.title} onClose={() => setOpen(null)} />
    </Suspense>
  );
}
