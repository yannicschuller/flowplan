// Formulas that ended up as text (\[ … \], $$ … $$, \( … \)) – e.g. pasted
// before Flowplan understood them – become real formulas: a paragraph of
// only display formulas turns into formula blocks, everything else into
// inline formulas. Marks and other content around them stay.
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { LATEX_PATTERN, hasLatexText } from "./chat-paste";

export function latexToFormulas(state: EditorState, from: number, to: number): Transaction | null {
  const { schema } = state;
  const block = schema.nodes.mathBlock,
    inline = schema.nodes.mathInline;
  if (!block || !inline) return null;
  const targets: { node: PMNode; pos: number }[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name !== "codeBlock" && hasLatexText(node.textContent)) targets.push({ node, pos });
    return false;
  });
  if (!targets.length) return null;
  const tr = state.tr;
  // From the end, so earlier positions stay valid.
  for (const { node, pos } of targets.reverse()) {
    const text = node.textContent;
    const matches = [...text.matchAll(LATEX_PATTERN)];
    const onlyDisplay = node.type.name === "paragraph" && matches.every((m) => m[3] === undefined) && !text.replace(LATEX_PATTERN, "").trim();
    if (onlyDisplay) {
      tr.replaceWith(pos, pos + node.nodeSize, matches.map((m) => block.create({ expression: (m[1] ?? m[2]).trim() })));
      continue;
    }
    // Offsets in the text → document positions (inline nodes have no text).
    const at: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) for (let k = 0; k < child.text!.length; k++) at.push(pos + 1 + offset + k);
    });
    for (const m of matches.reverse()) {
      const start = at[m.index!],
        end = at[m.index! + m[0].length - 1] + 1;
      if (start === undefined || end === undefined) continue;
      tr.replaceWith(start, end, inline.create({ expression: (m[1] ?? m[2] ?? m[3]).trim() }));
    }
  }
  return tr.docChanged ? tr : null;
}
