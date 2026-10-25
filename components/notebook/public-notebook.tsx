"use client";
// A notebook on a published or shared page, read-only: sheets as SVG
// pictures drawn on the server (paper and ink, lib/ink-export.ts); sheets
// with an imported PDF page draw that page here (pdf.js) under the ink.
import { useEffect, useRef, useState } from "react";
import { PdfBackground } from "./paper";

export type PublicSheet = {
  id: string;
  label: string;
  width: number;
  height: number;
  // Paper and ink (sheets without PDF).
  svg?: string;
  // The PDF page under the ink.
  background?: { src: string; page: number };
  ink?: string;
};

function PdfSheet({ sheet }: { sheet: PublicSheet }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="public-notebook-sheet" role="img" aria-label={sheet.label} style={{ aspectRatio: `${sheet.width} / ${sheet.height}` }}>
      {width > 0 && sheet.background && <PdfBackground src={sheet.background.src} page={sheet.background.page} width={width} />}
      {sheet.ink && <div className="public-notebook-ink" dangerouslySetInnerHTML={{ __html: sheet.ink }} />}
    </div>
  );
}

export function PublicNotebook({ sheets, label }: { sheets: PublicSheet[]; label: string }) {
  return (
    <section className="public-notebook" aria-label={label}>
      {sheets.map((sheet) =>
        sheet.background ? (
          <PdfSheet key={sheet.id} sheet={sheet} />
        ) : (
          <div
            key={sheet.id}
            className="public-notebook-sheet"
            role="img"
            aria-label={sheet.label}
            style={{ aspectRatio: `${sheet.width} / ${sheet.height}` }}
            dangerouslySetInnerHTML={{ __html: sheet.svg || "" }}
          />
        ),
      )}
    </section>
  );
}
