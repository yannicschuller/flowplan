// The editor's link dialog (#530): its text and address are edited
// together. linkTarget() finds what the dialog works on – the selection,
// grown to the whole link it touches – and applyLinkEdit() writes the
// result as one transaction: an unchanged text only changes the address
// (no needless re-insert for collaboration and undo), a changed one
// replaces the range, keeping the marks of its first character.
import type { Mark, Node } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

export type LinkTarget = {
  from: number;
  to: number;
  // The text of the range; "" for a cursor outside a link.
  text: string;
  // The address of the link the range touches; "" if none.
  href: string;
  // Attributes of that link (kept when only the address changes).
  attrs: Record<string, unknown> | null;
  // False when the range spans blocks or holds more than text (a mention,
  // a line break): then only the address is set, as before #530.
  textEditable: boolean;
};

const linkOf = (marks: readonly Mark[]) => marks.find((m) => m.type.name === "link") || null;

export function linkTarget(state: EditorState): LinkTarget {
  const { from, to, empty, $from, $to } = state.selection;
  const type = state.schema.marks.link;
  if (!type || !$from.sameParent($to) || !$from.parent.inlineContent) {
    const found = { mark: null as Mark | null };
    state.doc.nodesBetween(from, to, (node) => {
      if (!found.mark && node.isText) found.mark = linkOf(node.marks);
    });
    return { from, to, text: state.doc.textBetween(from, to, "\n"), href: String(found.mark?.attrs.href || ""), attrs: found.mark ? { ...found.mark.attrs } : null, textEditable: false };
  }
  const parent = $from.parent;
  const base = $from.start();
  // The children of the block with their positions.
  const children: { node: Node; start: number; end: number }[] = [];
  parent.forEach((node, offset) => children.push({ node, start: base + offset, end: base + offset + node.nodeSize }));
  // The link of the selection: for a cursor the one the editor shows as
  // active (as the toolbar does), else the first one inside the range.
  let link: Mark | null = null;
  if (empty) link = linkOf(state.storedMarks || $from.marks());
  else
    for (const c of children)
      if (c.end > from && c.start < to && (link = linkOf(c.node.marks))) break;
  let start = from;
  let end = to;
  if (link) {
    // Grow to the whole run of that link around the range.
    let i = 0;
    while (i < children.length) {
      if (!link.isInSet(children[i].node.marks)) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < children.length && link.isInSet(children[j + 1].node.marks)) j++;
      const runStart = children[i].start;
      const runEnd = children[j].end;
      const touches = empty ? runStart <= from && from <= runEnd : runEnd > from && runStart < to;
      if (touches) {
        start = Math.min(start, runStart);
        end = Math.max(end, runEnd);
      }
      i = j + 1;
    }
  }
  let textOnly = true;
  state.doc.nodesBetween(start, end, (node) => {
    if (node.isInline && !node.isText) textOnly = false;
  });
  return {
    from: start,
    to: end,
    text: state.doc.textBetween(start, end),
    href: String(link?.attrs.href || ""),
    attrs: link ? { ...link.attrs } : null,
    textEditable: textOnly && parent.type.allowsMarkType(type),
  };
}

// Whether a target found earlier still fits the document (someone else may
// have edited it while the dialog was open).
export function targetFits(state: EditorState, target: LinkTarget) {
  if (target.to > state.doc.content.size) return false;
  try {
    return state.doc.textBetween(target.from, target.to, "\n") === target.text;
  } catch {
    return false;
  }
}

// The transaction that saves the dialog; null when there is nothing to do.
export function applyLinkEdit(state: EditorState, target: LinkTarget, input: { text: string; href: string }): Transaction | null {
  const type = state.schema.marks.link;
  const href = input.href.trim();
  if (!type || !href) return null;
  const mark = type.create({ ...(target.attrs || {}), href });
  const tr = state.tr;
  const text = target.textEditable ? input.text || (target.from === target.to ? href : target.text) : target.text;
  if (!target.textEditable || text === target.text) {
    if (target.from === target.to) return null;
    tr.removeMark(target.from, target.to, type).addMark(target.from, target.to, mark);
    return tr;
  }
  // The marks of the first character (or, for a cursor, those that typing
  // would get), without the old link.
  let marks: readonly Mark[] = state.storedMarks || state.doc.resolve(target.from).marks();
  if (target.from < target.to) {
    let first: readonly Mark[] | null = null;
    state.doc.nodesBetween(target.from, target.to, (node) => {
      if (!first && node.isText) first = node.marks;
    });
    if (first) marks = first;
  }
  const kept = mark.addToSet(marks.filter((m) => m.type !== type));
  tr.replaceWith(target.from, target.to, state.schema.text(text, kept));
  tr.setSelection(TextSelection.create(tr.doc, target.from + text.length));
  return tr;
}

export function removeLink(state: EditorState, target: LinkTarget): Transaction | null {
  const type = state.schema.marks.link;
  if (!type || target.from === target.to) return null;
  return state.tr.removeMark(target.from, target.to, type);
}
