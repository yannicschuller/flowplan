"use client";
// The spreadsheet viewer (#402) for uploaded .csv and .xlsx files.
// openSheet() opens it from anywhere; the host is mounted once in the root
// layout like the HTML and 3D viewers' (html-viewer.tsx, model-viewer.tsx)
// and loads the dialog (sheet-viewer-dialog.tsx) only when a file is
// opened. Links to such files (documents, record attachments, the media
// library, read-only and published pages) open it instead of downloading;
// in text being edited only with ⌘/Ctrl. An .xls is only downloaded.
import { Suspense, lazy, useEffect, useState } from "react";
import { loadView } from "@/components/view-fallback";
import { isPreviewableSheet } from "@/lib/sheet-files";
import { fileLink } from "./pdf-viewer";

const SheetViewerDialog = lazy(() => loadView(() => import("./sheet-viewer-dialog")));
const EVENT = "flowplan:sheet";

export function openSheet(src: string, title: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { src, title } }));
}

export function SheetViewerHost() {
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.hasAttribute("download")) return;
      const href = link.getAttribute("href") || "";
      if (!fileLink.test(href)) return;
      const block = link.closest<HTMLElement>(".sheet-block");
      const title = link.dataset.sheet || block?.dataset.title || link.textContent?.trim() || "";
      if (!isPreviewableSheet(title)) return;
      if (link.closest("[contenteditable=true]") && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      openSheet(href, title);
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, []);
  const [open, setOpen] = useState<{ src: string; title: string; n: number } | null>(null);
  useEffect(() => {
    let n = 0;
    const show = (event: Event) => {
      const detail = (event as CustomEvent<{ src: string; title: string }>).detail;
      if (!fileLink.test(detail?.src || "") || !isPreviewableSheet(detail?.title || "")) return;
      setOpen({ src: detail.src, title: detail.title, n: ++n });
    };
    window.addEventListener(EVENT, show);
    return () => window.removeEventListener(EVENT, show);
  }, []);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <SheetViewerDialog key={open.n} src={open.src} title={open.title} onClose={() => setOpen(null)} />
    </Suspense>
  );
}
