"use client";
// The picture of an image occlusion card with its masks – in the focus mode
// (components/study/focus.tsx) and the preview of the mask editor
// (./occlusion-editor.tsx). A module of its own, so the editor (loaded on
// demand) does not pull in the other card parts.
import { useT } from "../i18n";
import type { OcclusionCard } from "@/lib/study-content";
import type { OcclusionMask } from "@/lib/study-occlusion";

// An image occlusion card (lib/study-occlusion.ts): the picture with an
// SVG layer of its masks in proportions (viewBox 0 0 1 1, stretched over the
// picture) – geometry as SVG attributes, colours by class, no inline styles.
// Before revealing the masks asked are covered and highlighted ("hide-all":
// every other mask covered too; "hide-one": the others not drawn); after
// revealing they are open with an outline. Screen readers get the picture's
// alternative text and "Bereich 3 von 7 verdeckt"; the labels come with the
// answer (they are the answer).
export function OcclusionImage({ occlusion, reveal }: { occlusion: OcclusionCard; reveal: boolean }) {
  const t = useT();
  const target = new Set(occlusion.target);
  const area = t(`Bereich ${occlusion.index} von ${occlusion.total}`, `Area ${occlusion.index} of ${occlusion.total}`);
  return (
    <figure className={`occlusion-card ${occlusion.mode}${reveal ? " revealed" : ""}`}>
      <div className="occlusion-frame">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={occlusion.src} alt="" draggable={false} />
        <svg className="occlusion-layer" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden focusable="false">
          {occlusion.masks.map((mask) => {
            const asked = target.has(mask.id);
            if (!asked && occlusion.mode === "hide-one") return null;
            return <MaskShape key={mask.id} mask={mask} className={`occlusion-mask ${asked ? (reveal ? "open" : "asked") : "other"}`} />;
          })}
        </svg>
      </div>
      <figcaption className="sr-only">
        {occlusion.alt ? t(`Bild: ${occlusion.alt}. `, `Picture: ${occlusion.alt}. `) : ""}
        {reveal ? t(`${area} aufgedeckt.`, `${area} revealed.`) : t(`${area} verdeckt.`, `${area} covered.`)}
      </figcaption>
    </figure>
  );
}
// One mask as an SVG shape (proportions; the stroke keeps its width).
export function MaskShape({ mask, className, scale = { x: 1, y: 1 } }: { mask: OcclusionMask; className: string; scale?: { x: number; y: number } }) {
  const common = { className, vectorEffect: "non-scaling-stroke" as const };
  if (mask.shape === "ellipse")
    return <ellipse {...common} cx={(mask.x + mask.w / 2) * scale.x} cy={(mask.y + mask.h / 2) * scale.y} rx={(mask.w / 2) * scale.x} ry={(mask.h / 2) * scale.y} />;
  if (mask.shape === "polygon") return <polygon {...common} points={(mask.points || []).map(([x, y]) => `${x * scale.x},${y * scale.y}`).join(" ")} />;
  return <rect {...common} x={mask.x * scale.x} y={mask.y * scale.y} width={mask.w * scale.x} height={mask.h * scale.y} />;
}
