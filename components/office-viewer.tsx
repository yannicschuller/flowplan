"use client";
// The content preview (#562) for uploaded presentations (.pptx, .odp) and
// text documents (.docx, .odt). openOffice() opens it from anywhere; the
// host is mounted once in the root layout like the spreadsheet viewer's
// (sheet-viewer.tsx) and loads the dialog (office-viewer-dialog.tsx) only
// when a file is opened. Links to such files (documents, record
// attachments, the media library, read-only and published pages) open it
// instead of downloading; in text being edited only with ⌘/Ctrl. A .ppt
// or .doc is only downloaded.
import { Suspense, lazy, useEffect, useState } from "react";
import { loadView } from "@/components/view-fallback";
import { isPreviewableOffice } from "@/lib/office-files";
import { fileLink } from "./pdf-viewer";

const OfficeViewerDialog = lazy(() => loadView(() => import("./office-viewer-dialog")));
const EVENT = "flowplan:office";

export function openOffice(src: string, title: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { src, title } }));
}

export function OfficeViewerHost() {
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.hasAttribute("download")) return;
      const href = link.getAttribute("href") || "";
      if (!fileLink.test(href)) return;
      const block = link.closest<HTMLElement>(".office-block");
      const title = link.dataset.office || block?.dataset.title || link.textContent?.trim() || "";
      if (!isPreviewableOffice(title)) return;
      if (link.closest("[contenteditable=true]") && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      openOffice(href, title);
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, []);
  const [open, setOpen] = useState<{ src: string; title: string; n: number } | null>(null);
  useEffect(() => {
    let n = 0;
    const show = (event: Event) => {
      const detail = (event as CustomEvent<{ src: string; title: string }>).detail;
      if (!fileLink.test(detail?.src || "") || !isPreviewableOffice(detail?.title || "")) return;
      setOpen({ src: detail.src, title: detail.title, n: ++n });
    };
    window.addEventListener(EVENT, show);
    return () => window.removeEventListener(EVENT, show);
  }, []);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <OfficeViewerDialog key={open.n} src={open.src} title={open.title} onClose={() => setOpen(null)} />
    </Suspense>
  );
}
