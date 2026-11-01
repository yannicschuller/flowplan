"use client";
// Whether the editor around a node view is editable – live. Node views are
// not drawn again when the editor turns read-only (reading mode on or off);
// editor.setEditable() announces it with an "update" event (issue #67).
import { useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";

export function onEditableChange(editor: Editor, listener: (editable: boolean) => void) {
  let last = editor.isEditable;
  const check = () => {
    if (editor.isDestroyed || editor.isEditable === last) return;
    last = editor.isEditable;
    listener(last);
  };
  editor.on("update", check);
  return () => {
    editor.off("update", check);
  };
}

export function useEditorEditable(editor: Editor): boolean {
  return useSyncExternalStore(
    (notify) => onEditableChange(editor, notify),
    () => editor.isEditable,
    () => editor.isEditable,
  );
}
