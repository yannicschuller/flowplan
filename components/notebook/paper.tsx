"use client";
// What lies under the ink of a notebook sheet: the paper (lines, grid, dots
// … as SVG in points, lib/notebook-paper.ts) or a page of an imported PDF
// (pdf.js, drawn once the sheet comes near the visible area).
import { memo, useEffect, useRef, useState } from "react";
import { paperSvg, type PaperLayout } from "@/lib/notebook-paper";
import { loadPdf, renderPage } from "../pdf-viewer";

export const PaperSvg = memo(function PaperSvg({ layout, className = "notebook-paper" }: { layout: PaperLayout; className?: string }) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: paperSvg(layout) }}
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
