"use client";
// What lies under the ink of a notebook sheet: the paper (lines, grid, dots
// … as SVG in points, lib/notebook-paper.ts) or a page of an imported PDF
// (pdf.js, drawn once the sheet comes near the visible area).
import { memo, useEffect, useRef, useState } from "react";
import { paperSvg, type PaperLayout } from "@/lib/notebook-paper";
import { thumbLayout, type PaperThumb } from "@/lib/notebook-paper-thumb";
import { loadPdf, renderPage } from "../pdf-viewer";

// `thumb`: drawn small (lib/notebook-paper-thumb.ts) – lines keep a minimum
// width on the screen, optionally only the top left part is shown.
export const PaperSvg = memo(function PaperSvg({ layout, className = "notebook-paper", thumb }: { layout: PaperLayout; className?: string; thumb?: PaperThumb }) {
  const small = thumb ? thumbLayout(layout, thumb) : null;
  return (
    <svg
      className={className}
      viewBox={small ? small.viewBox : `0 0 ${layout.width} ${layout.height}`}
      preserveAspectRatio={small ? "xMinYMin slice" : "none"}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: paperSvg(small ? small.layout : layout) }}
    />
  );
});

// Page `page` of the PDF at `src`, `width` CSS pixels wide.
export function PdfBackground({ src, page, width, eager = false }: { src: string; page: number; width: number; eager?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(eager);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = canvas.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(([entry]) => entry.isIntersecting && setVisible(true), { rootMargin: "900px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible || !canvas.current || width <= 0) return;
    let alive = true;
    // Drawn aside and copied over when done: after a zoom the page shown
    // before stays (stretched) until the sharp one is there, no blank flash.
    const aside = document.createElement("canvas");
    loadPdf(src)
      .then((doc) => (alive ? renderPage(doc, page, aside, width) : undefined))
      .then(() => {
        const el = canvas.current;
        if (!alive || !el || !aside.width) return;
        el.width = aside.width;
        el.height = aside.height;
        el.getContext("2d")?.drawImage(aside, 0, 0);
        aside.width = aside.height = 0;
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [src, page, width, visible]);
  return <canvas ref={canvas} className={`notebook-pdf${failed ? " is-failed" : ""}`} aria-hidden="true" />;
}
