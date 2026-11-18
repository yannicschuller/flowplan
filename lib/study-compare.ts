// Typed answers (docs/specs/flashcards.md §5.3): what was typed against the
// expected answer, with the deck's tolerance (lib/study-schema.ts
// typedCompare) – letter case, accents, punctuation; whitespace is always
// collapsed and everything is compared in Unicode NFC.
//
// - Exact (after normalising) → "right", suggested rating Good.
// - One edit away (Levenshtein ≤ 1) for answers of 6 characters or more →
//   "almost", suggested Hard.
// - Otherwise "wrong", suggested Again. The person decides the rating
//   anyway; the suggestion is only preselected.
// - Several accepted answers: separated by "|" in the back ("colour | color").
// The diff is character by character (lib/text-diff.ts over the
// characters, by grapheme where the platform has Intl.Segmenter), shown as
// <ins>/<del> elements, which screen readers announce. Pure, client-safe.
import { diff } from "./text-diff";
import type { TypedCompare } from "./study-schema";

export type TypedVerdict = "right" | "almost" | "wrong";
export type DiffPart = { type: "same" | "added" | "removed"; text: string };
export type TypedResult = { verdict: TypedVerdict; suggested: 1 | 2 | 3; expected: string; distance: number; parts: DiffPart[] };

const PUNCTUATION = /[\p{P}\p{S}]/gu;
export function normalizeAnswer(text: string, options: Partial<TypedCompare> = {}) {
  let value = text.normalize("NFC").replace(/\s+/g, " ").trim();
  if (options.ignoreCase ?? true) value = value.toLocaleLowerCase();
  if (options.ignoreAccents) value = value.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
  if (options.ignorePunctuation ?? true) value = value.replace(PUNCTUATION, "").replace(/\s+/g, " ").trim();
  return value;
}
// The accepted answers of a back.
export const acceptedAnswers = (back: string) =>
  back
    .split("|")
    .map((a) => a.replace(/\s+/g, " ").trim())
    .filter(Boolean);

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
export const characters = (text: string) => (segmenter ? [...segmenter.segment(text)].map((s) => s.segment) : Array.from(text));

export function levenshtein(a: string, b: string) {
  const x = characters(a),
    y = characters(b);
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[y.length];
}

// The typed text against the expected one, as runs: removed = typed but
// not expected, added = expected but not typed. Compared with the
// tolerance applied character by character (case, accents), shown as typed
// and as expected.
export function answerDiff(typed: string, expected: string, options: Partial<TypedCompare> = {}): DiffPart[] {
  const a = characters(typed.normalize("NFC")),
    b = characters(expected.normalize("NFC"));
  const fold = (c: string) => normalizeAnswer(c, { ...options, ignorePunctuation: false }) || c.replace(/\s/g, " ");
  const ops = diff(a, b, (x, y) => x === y || fold(x) === fold(y)) ?? [...a.map((value) => ({ type: "removed" as const, value })), ...b.map((value) => ({ type: "added" as const, value }))];
  const parts: DiffPart[] = [];
  for (const op of ops) {
    const last = parts.at(-1);
    if (last && last.type === op.type) last.text += op.value;
    else parts.push({ type: op.type, text: op.value });
  }
  // Ignored punctuation is no difference: shown as the same.
  if (options.ignorePunctuation ?? true) for (const p of parts) if (p.type !== "same" && !p.text.replace(PUNCTUATION, "").trim()) p.type = "same";
  return parts;
}

export function compareTyped(typed: string, back: string, options: Partial<TypedCompare> = {}): TypedResult {
  const answers = acceptedAnswers(back);
  const given = normalizeAnswer(typed, options);
  let best = { expected: answers[0] ?? back.trim(), distance: Number.POSITIVE_INFINITY };
  for (const expected of answers.length ? answers : [back.trim()]) {
    const distance = levenshtein(given, normalizeAnswer(expected, options));
    if (distance < best.distance) best = { expected, distance };
  }
  const length = characters(normalizeAnswer(best.expected, options)).length;
  const verdict: TypedVerdict = best.distance === 0 && (given || !length) ? "right" : best.distance <= 1 && length >= 6 && given ? "almost" : "wrong";
  return {
    verdict,
    suggested: verdict === "right" ? 3 : verdict === "almost" ? 2 : 1,
    expected: best.expected,
    distance: Number.isFinite(best.distance) ? best.distance : length,
    parts: answerDiff(typed.trim(), best.expected, options),
  };
}
