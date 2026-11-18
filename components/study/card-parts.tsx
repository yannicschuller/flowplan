"use client";
// The parts of a flashcard in the focus mode (components/study/focus.tsx):
// a side (text as React text, documents through ReadOnlyDocument), cloze
// text with the card's gaps hidden or marked, the field of a typed answer
// with its comparison and the options of a multiple choice card (the
// picture of an image occlusion card: ./occlusion-image.tsx).
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
