// When ":" opens the emoji suggestions while typing (#388): a colon at the
// start of a line, after a space or after an opening bracket or quote,
// followed by at least two letters (":smi", ":daum", ":rocket"). Not in code
// (a code block or inline code), not in a link, not after a letter or digit
// (URLs, times like 12:30, "Hinweis:"), and ": " – a space right after the
// colon – is a plain colon. Small and without the emoji data: it runs in the
// editor on every change; the data loads only once the suggestions show.
import type { EditorState } from "@tiptap/pm/state";
import type { ResolvedPos } from "@tiptap/pm/model";

// The skin tone last chosen in the emoji picker (components/emoji-picker.tsx),
// which the suggestions use (lib/emoji-rank.ts): "1" to "5", none for the
// default one.
export const EMOJI_TONE_KEY = "flowplan.emoji-tone";
export function rememberEmojiTone(tone: number | null) {
  try {
    if (tone) localStorage.setItem(EMOJI_TONE_KEY, String(tone));
    else localStorage.removeItem(EMOJI_TONE_KEY);
  } catch {}
}

export type EmojiTrigger = { from: number; to: number; query: string };

// What may come before the colon: nothing (the line start), white space, an
// inline node (read as a line break), an opening bracket or quote.
const START = String.raw`(?:^|[\s\p{Ps}\p{Pi}"'«‹])`;
const NAME = String.raw`\p{L}[\p{L}\p{N}_+-]{0,39}`;
const OPEN = new RegExp(`${START}:(${NAME})$`, "u");
const CLOSED = new RegExp(`${START}:(${NAME}):$`, "u");

const letters = (query: string) => (query.match(/\p{L}/gu) || []).length;

// The query typed after the colon at the end of `before` (the text of the
// line up to the caret), or null.
export function emojiQuery(before: string): string | null {
  const match = OPEN.exec(before);
  return match && letters(match[1]) >= 2 ? match[1] : null;
}

// ":smile:" – a closed shortcode at the end of `before`: its name, or null.
export function closedShortcode(before: string): string | null {
  const match = CLOSED.exec(before);
  return match && letters(match[1]) >= 2 ? match[1] : null;
}

function textBefore($from: ResolvedPos) {
  return $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
}

// Code or a link at the colon or at the caret: no suggestions there.
function inCodeOrLink(state: EditorState, $from: ResolvedPos, colon: number) {
  if ($from.parent.type.spec.code) return true;
  const marks = [...(state.storedMarks || $from.marks()), ...state.doc.resolve(colon + 1).marks()];
  return marks.some((mark) => mark.type.spec.code || mark.type.name === "link");
}

// The open trigger at the caret: the range from the colon to the caret and
// the query, or null.
export function emojiTriggerAt(state: EditorState): EmojiTrigger | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock) return null;
  const query = emojiQuery(textBefore($from));
  if (!query) return null;
  const from = $from.pos - query.length - 1;
  return inCodeOrLink(state, $from, from) ? null : { from, to: $from.pos, query };
}

// A shortcode closed with its second colon right at the caret (":smile:"):
// the range of the whole shortcode and its name, or null.
export function closedShortcodeAt(state: EditorState): EmojiTrigger | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock) return null;
  const query = closedShortcode(textBefore($from));
  if (!query) return null;
  const from = $from.pos - query.length - 2;
  return inCodeOrLink(state, $from, from) ? null : { from, to: $from.pos, query };
}
