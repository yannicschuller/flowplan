"use client";

// Whether the person last used the keyboard or a pointer (mouse, finger,
// pen). A dialog opened by a tap or click takes the focus on itself, not on
// its first button: browsers show the focus ring for focus moved by a
// script, and a thick ring on ✕ looks like an error on a phone (#346). With
// the keyboard the first control gets the focus – and its ring – as before.
//
// The same is kept on <html data-modality="pointer|keyboard">: with a pointer
// no focus ring is drawn on buttons, links and menu items (app/globals.css) –
// menus move the focus by script on hover and give it back to their button
// when they close, and the ring then showed on a clicked "⋯" or on whichever
// menu item the pointer last touched.
let keyboard = false;
function set(value: boolean) {
  keyboard = value;
  const mode = value ? "keyboard" : "pointer";
  if (document.documentElement.dataset.modality !== mode) document.documentElement.dataset.modality = mode;
}
if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      // Shortcuts with a modifier alone (Cmd+K) count as keyboard use too;
      // the modifier keys by themselves do not.
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) set(true);
    },
    true,
  );
  window.addEventListener("pointerdown", () => set(false), true);
}
export function usingKeyboard() {
  return keyboard;
}
