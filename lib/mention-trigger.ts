// When "@" in a document opens the mention dialog (components/editor.tsx):
// at the start of a line (also after a line break or another inline node),
// after a space or after an opening bracket or quote. Anywhere else – after
// a letter or digit, as in an e-mail address – it is typed as it is.
import type { EditorState } from "@tiptap/pm/state";

export function atOpensMention(state: EditorState) {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock || $from.parentOffset === 0) return true;
  // An inline node (line break, mention, image) reads as a line break here.
  const before = $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset, "\n", "\n");
  return /^[\s\p{Ps}\p{Pi}"'«‹]$/u.test(before);
}
