"use client";
// The 3D viewer (#384) for STL, OBJ, glTF/GLB, 3MF, STEP and IGES files in
// Flowplan. openModel() opens it from anywhere; the host is mounted once in
// the root layout like the PDF viewer's (pdf-viewer.tsx) and loads the
// viewer (components/viewer3d/dialog.tsx, with three.js) only when a model
// is opened – nothing of it is in the workspace's shell. Links to such files
// (documents, record attachments, the media library) open it instead of
// downloading; in text being edited only with ⌘/Ctrl.
import { Suspense, lazy, useEffect, useState } from "react";
import { loadView } from "@/components/view-fallback";
import { modelFormatOf, type ModelFormat } from "@/lib/model-formats";
import { fileLink } from "./pdf-viewer";

const ModelViewerDialog = lazy(() => loadView(() => import("./viewer3d/dialog")));
const EVENT = "flowplan:model";

export function openModel(src: string, title: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { src, title } }));
}

export function ModelViewerHost() {
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link) return;
      const href = link.getAttribute("href") || "";
      if (!fileLink.test(href)) return;
      const block = link.closest<HTMLElement>(".model-block");
      const title = link.dataset.model || block?.dataset.title || link.textContent?.trim() || "";
      if (!modelFormatOf(title)) return;
      if (link.closest("[contenteditable=true]") && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      openModel(href, title);
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, []);
  const [open, setOpen] = useState<{ src: string; title: string; format: ModelFormat; n: number } | null>(null);
  useEffect(() => {
    let n = 0;
    const show = (event: Event) => {
      const detail = (event as CustomEvent<{ src: string; title: string }>).detail;
      const format = modelFormatOf(detail?.title || "");
      if (!fileLink.test(detail?.src || "") || !format) return;
      setOpen({ src: detail.src, title: detail.title, format, n: ++n });
    };
    window.addEventListener(EVENT, show);
    return () => window.removeEventListener(EVENT, show);
  }, []);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <ModelViewerDialog key={open.n} src={open.src} title={open.title} format={open.format} onClose={() => setOpen(null)} />
    </Suspense>
  );
}
