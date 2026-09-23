import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type { Transaction } from "@tiptap/pm/state";
import { Extension, type Editor } from "@tiptap/core";
import {
  adjacentBlockTarget,
  changeBlocks,
  selectedDocumentBlock,
} from "./document-blocks";
export function applyBlockChange(editor: Editor, transaction: Transaction) {
  const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
  undo?.stopCapturing();
  editor.view.dispatch(transaction);
  undo?.stopCapturing();
}
export function moveSelectedBlock(editor: Editor | null, direction: -1 | 1) {
  if (!editor?.isEditable) return false;
  const block = selectedDocumentBlock(editor.state);
  if (!block) return false;
  const target = adjacentBlockTarget(editor.state, [block.pos], direction);
  if (target === undefined) return false;
  try {
    applyBlockChange(
      editor,
      changeBlocks(editor.state, [block.pos], "move", target),
    );
    editor.commands.focus();
    return true;
  } catch {
    return false;
  }
}
export const BlockShortcuts = Extension.create({
  name: "blockShortcuts",
  addKeyboardShortcuts() {
    return {
      // Native document navigation can leave an atom selected in contenteditable.
      "Mod-Home": () => this.editor.commands.focus("start"),
      "Mod-End": () => this.editor.commands.focus("end"),
      "Mod-Shift-ArrowUp": () => moveSelectedBlock(this.editor, -1),
      "Mod-Shift-ArrowDown": () => moveSelectedBlock(this.editor, 1),
    };
  },
});
