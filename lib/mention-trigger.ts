// When "@" in a document opens the mention dialog (components/editor.tsx):
// at the start of a line (also after a line break or another inline node),
// after a space or after an opening bracket or quote. Anywhere else – after
// a letter or digit, as in an e-mail address – it is typed as it is.
import type { EditorState } from "@tiptap/pm/state";
import type { ResolvedPos } from "@tiptap/pm/model";

export function atOpensMention(state: EditorState) {
  return mentionStartsAt(state.selection.$from);
}

function mentionStartsAt($from: ResolvedPos) {
  if (!$from.parent.isTextblock || $from.parentOffset === 0) return true;
  // An inline node (line break, mention, image) reads as a line break here.
  const before = $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset, "\n", "\n");
  return /^[\s\p{Ps}\p{Pi}"'«‹]$/u.test(before);
}

// The menus "@" and "/" open while typing. On a hardware keyboard the key
// opens them (handleKeyDown, which sees "@" or "/"). Android's on-screen
// keyboards name every key "Unidentified" (key code 229) and send the
// character as text input, often inside an IME composition (#207): then
// the character arriving as text opens them. `lastKey` is the key of the
// last keydown – when it was the character itself, the key handled it.
export function typedMenu(
  state: EditorState,
  from: number,
  to: number,
  text: string,
  lastKey: string,
): "mention" | "slash" | null {
  if ((text !== "@" && text !== "/") || lastKey === text) return null;
  const $from = state.doc.resolve(from);
  if ($from.parent.type.spec.code) return null;
  if (text === "/") return from === to ? "slash" : null;
  return mentionStartsAt($from) ? "mention" : null;
}
