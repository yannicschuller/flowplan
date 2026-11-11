// Automatic links in the editors (#202, lib/auto-link.ts): text that matches
// one of the workspace's rules becomes a real link mark when a word boundary
// is typed after it (a space, a punctuation mark, Enter) or when it is
// pasted – like the URL autolink of TipTap's Link extension. Undo right
// after (⌘Z / Ctrl+Z) takes only the automatic link back, the text stays.
//
// It is an ordinary link mark, so it travels through collaboration, offline
// edits, exports and the mobile apps like any other link. Nothing already
// written changes: only the text block around what was just typed or pasted
// is looked at (capped, lib/auto-link.ts AUTO_LINK_SCAN), never remote
// changes, undo/redo or content loaded by the program. Not inside code,
// existing links, math or anything else that is not plain text.
import { Extension, combineTransactionSteps } from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import type { Node as PMNode } from "@tiptap/pm/model";
import { AUTO_LINK_SCAN, compileRules, findAutoLinks, type AutoLinkRule, type CompiledRule } from "./auto-link";

// The rules of the open workspace (set by the app from the bootstrap),
// compiled once per rule set.
let current: { key: string; rules: CompiledRule[] } = { key: "[]", rules: [] };
export function setAutoLinkRules(rules: readonly AutoLinkRule[] | null | undefined) {
  const key = JSON.stringify(rules || []);
  if (key !== current.key) current = { key, rules: compileRules(rules) };
}
export const workspaceAutoLinkRules = () => current.rules;

type Range = { from: number; to: number };
type State = { added: Range[] | null };
export const autoLinkKey = new PluginKey<State>("autoLinkRules");

// Remote changes (y-sync), undo/redo, content set by the program and
// transactions that ask for it are never linked.
function skipped(tr: Transaction) {
  const sync = tr.getMeta("y-sync$") as { isChangeOrigin?: boolean } | undefined;
  return (
    !!sync?.isChangeOrigin ||
    isHistoryTransaction(tr) ||
    tr.getMeta("addToHistory") === false ||
    !!tr.getMeta("preventAutolink") ||
    !!tr.getMeta("preventUpdate") ||
    !!tr.getMeta(autoLinkKey)
  );
}

const WORD = /[\p{L}\p{N}_]/u;
// Text of a text block with one character per position (anything that is
// not text – mentions, math, images – is U+FFFC, which no link crosses).
function blockText(node: PMNode) {
  let text = "";
  node.forEach((child) => {
    text += child.isText ? child.text! : "￼".repeat(child.nodeSize);
  });
  return text;
}

// Where text was inserted, in the new document.
function insertedRanges(transactions: readonly Transaction[], oldState: EditorState): Range[] {
  const transform = combineTransactionSteps(oldState.doc, [...transactions]);
  const ranges: Range[] = [];
  transform.steps.forEach((step, index) => {
    if (!(step instanceof ReplaceStep) || !step.slice.size) return;
    const mapping = transform.mapping.slice(index + 1);
    const from = mapping.map(step.from, 1);
    const to = mapping.map(step.from + step.slice.size, -1);
    if (from < to) ranges.push({ from, to });
  });
  return ranges;
}

export function autoLinkPlugin(options: { rules?: () => readonly CompiledRule[]; allow?: (href: string) => boolean } = {}) {
  const rulesOf = options.rules || workspaceAutoLinkRules;
  return new Plugin<State>({
    key: autoLinkKey,
    state: {
      init: () => ({ added: null }),
      apply(tr, value) {
        const meta = tr.getMeta(autoLinkKey) as { added?: Range[]; undone?: boolean } | undefined;
        if (meta?.added) return { added: meta.added };
        if (meta?.undone) return { added: null };
        if (!value.added) return value;
        // Other plugins' follow-up steps (block ids …) only move the links.
        if (tr.getMeta("appendedTransaction") && !tr.selectionSet)
          return tr.docChanged ? { added: value.added.map((r) => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) })) } : value;
        return tr.docChanged || tr.selectionSet ? { added: null } : value;
      },
    },
    appendTransaction(transactions, oldState, newState) {
      const rules = rulesOf();
      const link = newState.schema.marks.link;
      if (!rules.length || !link) return null;
      if (!transactions.some((tr) => tr.docChanged) || transactions.some(skipped)) return null;
      const paste = transactions.some((tr) => tr.getMeta("uiEvent") === "paste");
      const head = newState.selection.head;
      const code = newState.schema.marks.code;
      const tr = newState.tr;
      const added: Range[] = [];
      let budget = AUTO_LINK_SCAN.total;
      for (const range of insertedRanges(transactions, oldState)) {
        // Typing inserts a character or splits a block; anything longer that
        // is not a paste came from the program (templates, AI, imports).
        if (!paste && newState.doc.textBetween(range.from, range.to, "\n", "￼").length > 2) continue;
        const blocks: { node: PMNode; pos: number }[] = [];
        newState.doc.nodesBetween(range.from, range.to, (node, pos) => {
          if (node.isTextblock) {
            blocks.push({ node, pos });
            return false;
          }
          return true;
        });
        for (const { node, pos } of blocks) {
          if (budget <= 0) break;
          if (node.type.spec.code || !node.type.allowsMarkType(link)) continue;
          const start = pos + 1;
          const end = pos + node.nodeSize - 1;
          const text = blockText(node);
          const from = Math.max(start, paste ? range.from - 200 : range.to - AUTO_LINK_SCAN.typed);
          const to = Math.min(end, paste ? range.to + 200 : range.to, from + AUTO_LINK_SCAN.block);
          if (to <= from) continue;
          budget -= to - from;
          for (const match of findAutoLinks(text.slice(from - start, to - start), rules)) {
            const a = from + match.from;
            const b = from + match.to;
            // Only what was just typed or pasted ends the link.
            if (b < range.from || b > range.to) continue;
            if (match.text.includes("￼")) continue;
            if (!paste && (b === head || WORD.test(text[b - start] ?? ""))) continue;
            if (newState.doc.rangeHasMark(a, b, link) || (code && newState.doc.rangeHasMark(a, b, code))) continue;
            if (added.some((r) => r.from < b && a < r.to)) continue;
            if (options.allow && !options.allow(match.href)) continue;
            tr.addMark(a, b, link.create({ href: match.href }));
            added.push({ from: a, to: b });
          }
        }
      }
      if (!added.length) return null;
      return tr.setMeta(autoLinkKey, { added });
    },
  });
}

// Takes the links just added back (the text stays); false when there are
// none, so undo does its usual work.
export function undoAutoLink(state: EditorState, dispatch?: (tr: Transaction) => void) {
  const added = autoLinkKey.getState(state)?.added;
  const link = state.schema.marks.link;
  if (!added?.length || !link) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const r of added) tr.removeMark(r.from, r.to, link);
    dispatch(tr.setMeta(autoLinkKey, { undone: true }).setMeta("addToHistory", false).setMeta("preventAutolink", true));
  }
  return true;
}

// For TipTap editors: before the undo of collaboration or history.
export const AutoLinkRules = Extension.create<{ allow?: (href: string) => boolean }>({
  name: "autoLinkRules",
  priority: 1000,
  addOptions() {
    return {};
  },
  addProseMirrorPlugins() {
    return [autoLinkPlugin({ allow: this.options.allow })];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-z": () => undoAutoLink(this.editor.state, this.editor.view.dispatch),
    };
  },
});
