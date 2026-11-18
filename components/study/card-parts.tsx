"use client";
// The parts of a flashcard in the focus mode (components/study/focus.tsx):
// a side (text as React text, documents through ReadOnlyDocument), cloze
// text with the card's gaps hidden or marked, the field of a typed answer
// with its comparison, the options of a multiple choice card and the
// picture of an image occlusion card with its masks.
// Nothing from a cell is ever rendered as HTML; documents come sanitized
// from the server (lib/study.ts), their gaps already rewritten.
import { Fragment, useMemo } from "react";
import { Check, X as Cross } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { InlineText } from "../inline-text";
import { ReadOnlyDocument } from "../read-only-document";
import { parseClozeText } from "@/lib/study-cloze";
import { seededRank } from "@/lib/study-queue";
import type { DiffPart, TypedResult } from "@/lib/study-compare";
import type { OcclusionCard } from "@/lib/study-content";
import type { OcclusionMask } from "@/lib/study-occlusion";

export type StudySide = { text: string; formatted?: boolean; cloze?: { n: number; reveal: boolean } } | { html: string };

const plainOrInline = (text: string, formatted?: boolean) => (formatted ? <InlineText value={text} /> : text);

// Cloze text: card N's gaps as "[…]" (or "[hint]") before revealing, their
// answers marked after; other gaps as their plain answer.
function ClozeText({ text, formatted, n, reveal }: { text: string; formatted?: boolean; n: number; reveal: boolean }) {
  const t = useT();
  const segments = useMemo(() => parseClozeText(text), [text]);
  return (
    <>
      {segments.map((s, i) =>
        s.type === "text" ? (
          <Fragment key={i}>{plainOrInline(s.text, formatted)}</Fragment>
        ) : s.n !== n ? (
          <Fragment key={i}>{plainOrInline(s.answer, formatted)}</Fragment>
        ) : reveal ? (
          <mark key={i} className="cloze-answer">
            {plainOrInline(s.answer, formatted)}
          </mark>
        ) : (
          <span key={i} className="cloze-gap" aria-label={s.hint ? t(`Lücke: ${s.hint}`, `Gap: ${s.hint}`) : t("Lücke", "Gap")}>
            [{s.hint || "…"}]
          </span>
        ),
      )}
    </>
  );
}

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

export function Side({ side, pageId }: { side: StudySide; pageId: string }) {
  if ("html" in side) return <ReadOnlyDocument html={side.html} pageId={pageId} className="study-document" />;
  return (
    <p className="study-text">
      {side.cloze ? <ClozeText text={side.text} formatted={side.formatted} n={side.cloze.n} reveal={side.cloze.reveal} /> : plainOrInline(side.text, side.formatted)}
    </p>
  );
}

// The typed text against the expected answer: removed (typed, not
// expected) and added (expected, not typed) characters.
export function AnswerDiff({ parts }: { parts: DiffPart[] }) {
  return (
    <span className="study-diff">
      {parts.map((p, i) =>
        p.type === "same" ? (
          <span key={i}>{p.text}</span>
        ) : p.type === "removed" ? (
          <del key={i}>{p.text}</del>
        ) : (
          <ins key={i}>{p.text}</ins>
        ),
      )}
    </span>
  );
}

export function TypedVerdict({ result, typed }: { result: TypedResult; typed: string }) {
  const t = useT();
  const text =
    result.verdict === "right"
      ? t("Richtig", "Correct")
      : result.verdict === "almost"
        ? result.distance === 1
          ? t("Fast richtig: 1 Zeichen anders", "Almost: 1 character different")
          : t(`Fast richtig: ${result.distance} Zeichen anders`, `Almost: ${result.distance} characters different`)
        : typed.trim()
          ? t("Nicht ganz", "Not quite")
          : t("Keine Antwort eingetippt", "No answer typed");
  return (
    <div className={`study-typed-result ${result.verdict}`} role="status">
      <strong>
        {result.verdict === "right" ? <Check aria-hidden /> : result.verdict === "wrong" ? <Cross aria-hidden /> : null} {text}
      </strong>
      {result.verdict !== "right" && typed.trim() && (
        <p>
          <span className="sr-only">{t("Dein Vergleich: ", "Your comparison: ")}</span>
          <AnswerDiff parts={result.parts} />
        </p>
      )}
      {result.verdict !== "right" && (
        <p className="study-typed-expected">
          {t("Erwartet: ", "Expected: ")}
          <strong>{result.expected}</strong>
        </p>
      )}
    </div>
  );
}

// The order of the options for one review: shuffled with the review's id
// as seed, so it stays the same while the card is shown.
export function choiceOrder(options: string[], seed: string) {
  return options.map((_, i) => i).sort((a, b) => seededRank(seed, `${a}:${options[a]}`) - seededRank(seed, `${b}:${options[b]}`));
}
export const CHOICE_KEYS = ["A", "B", "C", "D", "E"];

export function ChoiceOptions({
  options,
  order,
  correct,
  picked,
  onPick,
}: {
  options: string[];
  order: number[];
  correct: number;
  picked: number | null;
  onPick: (index: number) => void;
}) {
  const t = useT();
  const answered = picked !== null;
  return (
    <div className="study-choices" role="group" aria-label={t("Antwortmöglichkeiten", "Answer options")}>
      {order.map((index, position) => {
        const state = !answered ? "" : index === correct ? " right" : index === picked ? " wrong" : "";
        return (
          <button
            key={index}
            type="button"
            className={`button study-choice${state}`}
            disabled={answered}
            aria-keyshortcuts={CHOICE_KEYS[position]}
            onClick={(e) => {
              e.stopPropagation();
              onPick(index);
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <kbd>{CHOICE_KEYS[position]}</kbd>
            <span>{options[index]}</span>
            {answered && index === correct && <span className="sr-only">{t(" – richtig", " – correct")}</span>}
            {answered && index === picked && index !== correct && <span className="sr-only">{t(" – deine Wahl, falsch", " – your choice, wrong")}</span>}
          </button>
        );
      })}
    </div>
  );
}
