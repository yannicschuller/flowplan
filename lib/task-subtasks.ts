// Ticking off a task ticks off its subtasks too (nested tasks below it).
// Unticking leaves them as they are, so nothing done gets lost.
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { AttrStep, Mapping, ReplaceAroundStep } from "@tiptap/pm/transform";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

export const subtasksKey = new PluginKey("taskSubtasks");

// The change to append, or null. Exported for tests.
export function checkSubtasks(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
): Transaction | null {
  // Changes of others arrive already complete through the Yjs binding.
  const own = transactions.filter((tr) => tr.docChanged && !tr.getMeta(ySyncPluginKey));
  if (!own.length) return null;
  // Only ticking itself (attribute changes): moved or pasted tasks that
  // were already done keep their subtasks as they are.
  if (!own.every((tr) => tr.steps.every((step) => step instanceof AttrStep || step instanceof ReplaceAroundStep)))
    return null;
  const mapping = new Mapping();
  for (const tr of transactions) mapping.appendMapping(tr.mapping);
  const wasChecked = new Set<number>();
  oldState.doc.descendants((node, pos) => {
    if (node.type.name === "taskItem" && node.attrs.checked) wasChecked.add(mapping.map(pos));
    return true;
  });
  const tr = newState.tr;
  newState.doc.descendants((node, pos) => {
    if (node.type.name !== "taskItem" || !node.attrs.checked || wasChecked.has(pos)) return true;
    node.descendants((child, offset) => {
      if (child.type.name === "taskItem" && !child.attrs.checked)
        tr.setNodeMarkup(pos + 1 + offset, undefined, { ...child.attrs, checked: true });
      return true;
    });
    return false;
  });
  return tr.docChanged ? tr : null;
}

export const subtasksPlugin = () =>
  new Plugin({ key: subtasksKey, appendTransaction: checkSubtasks });
