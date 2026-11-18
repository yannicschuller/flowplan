"use client";
// The picture of an image occlusion card with its masks – in the focus mode
// (components/study/focus.tsx) and the preview of the mask editor
// (./occlusion-editor.tsx). A module of its own, so the editor (loaded on
// demand) does not pull in the other card parts.
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import type { OcclusionCard } from "@/lib/study-content";
import type { OcclusionMask, OcclusionText } from "@/lib/study-occlusion";
import { useOcclusionZoom, type ZoomGate } from "./occlusion-zoom";

// An image occlusion card (lib/study-occlusion.ts): the picture with an
// SVG layer of its masks in proportions (viewBox 0 0 1 1, stretched over the
// picture) – geometry as SVG attributes, colours by class, no inline styles.
// Before revealing the masks asked are covered and highlighted ("hide-all":
// every other mask covered too; "hide-one": the others not drawn); after
// revealing they are open with an outline. Texts on the picture (Anki's text
// shapes) lie above the masks on both sides and are never asked. Screen
// readers get the picture's alternative text, the texts and "Bereich 3 von
// 7 verdeckt"; the labels come with the answer (they are the answer).
// `zoom`: two fingers zoom the picture (./occlusion-zoom.ts), the gestures
// claimed from the card's swipes through the gate.
export function OcclusionImage({ occlusion, reveal, zoom }: { occlusion: OcclusionCard; reveal: boolean; zoom?: ZoomGate }) {
  const t = useT();
  const target = new Set(occlusion.target);
  const area = t(`Bereich ${occlusion.index} von ${occlusion.total}`, `Area ${occlusion.index} of ${occlusion.total}`);
  const frame = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  // The picture's proportions, for texts that keep their shape (the layer
  // is 1000 units high: browsers draw tiny font sizes badly).
  const [ratio, setRatio] = useState<number | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const measure = () => {
    const el = image.current;
    if (el?.naturalWidth && el.naturalHeight) setRatio(el.naturalWidth / el.naturalHeight);
  };
  // A picture from the cache may be there before React listens for "load".
  useEffect(measure, [occlusion.src]);
  useOcclusionZoom(frame, content, zoom, `${occlusion.src}|${occlusion.target.join(",")}`);
  const texts = occlusion.texts || [];
  return (
    <figure className={`occlusion-card ${occlusion.mode}${reveal ? " revealed" : ""}`}>
      <div className={`occlusion-frame${zoom ? " zoomable" : ""}`} ref={frame}>
        <div className="occlusion-zoom" ref={content}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={image}
            src={occlusion.src}
            alt=""
            draggable={false}
            onLoad={measure}
          />
          <svg className="occlusion-layer" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden focusable="false">
            {occlusion.masks.map((mask) => {
              const asked = target.has(mask.id);
              if (!asked && occlusion.mode === "hide-one") return null;
              return <MaskShape key={mask.id} mask={mask} className={`occlusion-mask ${asked ? (reveal ? "open" : "asked") : "other"}`} />;
            })}
          </svg>
          {texts.length > 0 && ratio && (
            <svg className="occlusion-layer occlusion-texts" viewBox={`0 0 ${ratio * 1000} 1000`} preserveAspectRatio="none" aria-hidden focusable="false">
              {texts.map((text) => (
                <OcclusionTextShape key={text.id} text={text} scale={{ x: ratio * 1000, y: 1000 }} />
              ))}
            </svg>
          )}
        </div>
      </div>
      <figcaption className="sr-only">
        {occlusion.alt ? t(`Bild: ${occlusion.alt}. `, `Picture: ${occlusion.alt}. `) : ""}
        {texts.length ? t(`Text auf dem Bild: ${texts.map((x) => x.text).join(", ")}. `, `Text on the picture: ${texts.map((x) => x.text).join(", ")}. `) : ""}
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
// A text on the picture, in a layer whose units are as wide as high (`scale`
// maps the proportions to them): its top left at x/y, one line per row.
export function OcclusionTextShape({ text, scale, className = "" }: { text: OcclusionText; scale: { x: number; y: number }; className?: string }) {
  const size = text.size * scale.y;
  return (
    <text className={`occlusion-text ${className}`.trim()} x={text.x * scale.x} y={text.y * scale.y} fontSize={size} dominantBaseline="hanging">
      {text.text.split("\n").map((line, i) => (
        <tspan key={i} x={text.x * scale.x} dy={i ? size * 1.2 : 0}>
          {line}
        </tspan>
      ))}
    </text>
  );
}
