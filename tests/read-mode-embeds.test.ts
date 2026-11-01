// Issue #67: reading mode locks linked databases and other embedded blocks
// in documents (a view preference on this device, not a permission).
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkedDatabaseAccess } from "../lib/embed-access";
import { onEditableChange } from "../components/editor-editable";
import type { Editor } from "@tiptap/core";

test("reading mode locks a linked database on a page one may edit", () => {
  const base = { role: "editor", locked: false, hostRole: "editor", hostLocked: false };
  assert.deepEqual(linkedDatabaseAccess({ ...base, editorEditable: true }), {
    reading: false,
    editable: true,
    viewEditable: true,
  });
  // Reading mode: the text is read-only although the page may be edited.
  assert.deepEqual(linkedDatabaseAccess({ ...base, editorEditable: false }), {
    reading: true,
    editable: false,
    viewEditable: false,
  });
  // Viewers of the source never edit records; locked sources neither.
  assert.equal(linkedDatabaseAccess({ ...base, role: "viewer", editorEditable: true }).editable, false);
  assert.equal(linkedDatabaseAccess({ ...base, locked: true, editorEditable: true }).editable, false);
  // Viewers of the host page keep what the source allows (not reading mode).
  const viewer = linkedDatabaseAccess({ ...base, hostRole: "viewer", editorEditable: false });
  assert.deepEqual(viewer, { reading: false, editable: true, viewEditable: false });
  const locked = linkedDatabaseAccess({ ...base, hostLocked: true, editorEditable: false });
  assert.deepEqual(locked, { reading: false, editable: true, viewEditable: false });
});

test("node views hear when the editor turns read-only", () => {
  const handlers = new Set<() => void>();
  const editor = {
    isEditable: true,
    isDestroyed: false,
    on: (_: string, fn: () => void) => handlers.add(fn),
    off: (_: string, fn: () => void) => handlers.delete(fn),
  };
  const heard: boolean[] = [];
  const stop = onEditableChange(editor as unknown as Editor, (editable) => heard.push(editable));
  const emit = () => handlers.forEach((fn) => fn());
  emit(); // an ordinary text change
  editor.isEditable = false;
  emit();
  emit();
  editor.isEditable = true;
  emit();
  assert.deepEqual(heard, [false, true]);
  stop();
  assert.equal(handlers.size, 0);
});
