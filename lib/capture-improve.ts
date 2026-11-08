// "Text verbessern" in quick capture (components/quick-capture.tsx, #172):
// title and text go to the writing assistant's "improve" action (POST
// /api/ai/write with the capture's target database as the page, or the
// device's model – lib/ai/write.ts, lib/ai/prompts.ts) as one Markdown text,
// the title as its heading; the answer is split back into title and text
// here. Nothing is saved: the person sees the result and takes it or keeps
// the original. The desktop app's capture window (one field with shorthand,
// POST /api/ai/capture/improve, lib/ai/capture-improve.ts) checks that the
// shorthand survived (lostCaptureTokens). Browser and server safe.
import { tokens, type ParseContext } from "./capture-parse";

// The capture form's limits (components/quick-capture.tsx, lib/capture.ts).
export const CAPTURE_IMPROVE_LIMITS = { title: 300, text: 20_000 } as const;

export type CaptureText = { title: string; text: string };

// The text the AI works on: "# Title\n\nText", only the title's heading
// when there is no text, only the text when there is no title.
export function captureImproveSource({ title, text }: CaptureText): string {
  const head = oneLine(title);
  const body = normalize(text);
  if (!head) return body;
  return body ? `# ${head}\n\n${body}` : `# ${head}`;
}

// Whether there is anything to improve.
export const captureImprovable = (value: CaptureText) => !!captureImproveSource(value);

// The answer as title and text again. The heading of the first line becomes
// the title; an answer that dropped the heading keeps the original title
// (or, for a title alone, takes its first line). Clipped to the form's limits.
export function parseCaptureImprove(answer: string, original: CaptureText): CaptureText {
  const lines = unfence(normalize(answer)).split("\n");
  const hadTitle = !!oneLine(original.title);
  const hadText = !!normalize(original.text);
  let title = hadTitle ? oneLine(original.title) : "";
  let text: string;
  const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[0] || "");
  if (hadTitle && heading) {
    title = inline(heading[1]) || title;
    text = lines.slice(1).join("\n");
  } else if (hadTitle && !hadText) {
    title = inline(lines[0] || "") || title;
    text = lines.slice(1).join("\n");
  } else text = lines.join("\n");
  return { title: title.slice(0, CAPTURE_IMPROVE_LIMITS.title), text: normalize(text).slice(0, CAPTURE_IMPROVE_LIMITS.text) };
}

// Whether the improved version differs from the original.
export const captureImproveChanged = (original: CaptureText, improved: CaptureText) =>
  oneLine(original.title) !== oneLine(improved.title) || normalize(original.text) !== normalize(improved.text);

// The shorthand (#tag, @person, !priority, dates – lib/capture-parse.ts) and
// links of the original that the improved text no longer has: the shorthand
// fills properties on saving, so the window warns before the text is taken.
// Each token as typed, in the original's order.
export function lostCaptureTokens(original: string, improved: string, context: ParseContext): string[] {
  // A date counts by the day and time it names ("morgen um 15 Uhr" is
  // "morgen 15 Uhr"); tags, people, the priority and links as typed.
  const words = (text: string) => [
    ...tokens(text, { ...context, literal: [] }).map((t) => ({ raw: t.raw, key: t.kind === "date" ? `date:${JSON.stringify(t.value)}` : t.raw })),
    ...(text.match(/https?:\/\/[^\s<>()]+/gi) || []).map((url) => ({ raw: url, key: url })),
  ];
  const left = words(improved).map((w) => w.key);
  const lost: string[] = [];
  for (const word of words(original)) {
    const at = left.indexOf(word.key);
    if (at >= 0) left.splice(at, 1);
    else lost.push(word.raw);
  }
  return lost;
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
// Line breaks as \n, no trailing spaces, at most one empty line in a row.
const normalize = (value: string) =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
// A whole answer wrapped in a code block (the prompt asks the model not to).
const unfence = (value: string) => {
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(value);
  return fenced ? fenced[1].trim() : value;
};
// A title without Markdown emphasis around it.
const inline = (value: string) =>
  oneLine(value)
    .replace(/^(\*\*|__)(.+)\1$/, "$2")
    .replace(/^(\*|_)(.+)\1$/, "$2")
    .trim();
