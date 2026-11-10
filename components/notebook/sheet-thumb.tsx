"use client";
// The picture of a sheet in the side strip and the page overview: paper or
// PDF page with the ink on top, drawn once it comes near the visible area
// (a grid of 1000 sheets draws only what is seen), a ribbon when the sheet
// is bookmarked and its title under it.
import { memo, useEffect, useRef, useState } from "react";
import { BookmarkSimple } from "@phosphor-icons/react";
import { InkLayer } from "../ink/ink-layer";
import { PaperSvg, PdfBackground } from "./paper";
import type { InkDoc } from "@/lib/ink/model";
import type { PageSize } from "@/lib/ink/coords";
import type { PaperLayout } from "@/lib/notebook-paper";
import type { NotebookSheet } from "@/lib/notebook";

// Whether the element is (nearly) in view; once seen it stays drawn.
export function useSeen<T extends Element>(margin = "600px 0px") {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver(([entry]) => entry.isIntersecting && setSeen(true), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, margin]);
  return [ref, seen] as const;
}

export const SheetPicture = memo(function SheetPicture({
  sheet,
  size,
  layout,
  dark,
  doc,
  width,
  label,
}: {
  sheet: Pick<NotebookSheet, "id" | "background">;
  size: PageSize;
  layout: PaperLayout | null;
  dark: boolean;
  doc: InkDoc;
  // CSS pixels the PDF page is drawn at.
  width: number;
  label: string;
}) {
  const [ref, seen] = useSeen<HTMLSpanElement>();
  return (
    <span ref={ref} className={`notebook-thumb-paper${dark ? " is-dark" : ""}`} style={{ aspectRatio: `${size.width} / ${size.height}` }}>
      {seen &&
        (sheet.background ? (
          <PdfBackground src={`/api/files/${sheet.background.file}`} page={sheet.background.page} width={width} eager />
        ) : layout ? (
          <PaperSvg layout={layout} />
        ) : null)}
      {seen && <InkLayer page={sheet.id} size={size} doc={doc} label={label} />}
    </span>
  );
});

// The ribbon of a bookmarked sheet (top right of its picture).
export function BookmarkRibbon({ label }: { label: string }) {
  return (
    <span className="notebook-ribbon" title={label} aria-label={label} role="img">
      <BookmarkSimple size={16} weight="fill" />
    </span>
  );
}
