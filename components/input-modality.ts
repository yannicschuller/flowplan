"use client";

// Whether the person last used the keyboard or a pointer (mouse, finger,
// pen). A dialog opened by a tap or click takes the focus on itself, not on
// its first button: browsers show the focus ring for focus moved by a
// script, and a thick ring on ✕ looks like an error on a phone (#346). With
// the keyboard the first control gets the focus – and its ring – as before.
let keyboard = false;
if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      // Shortcuts with a modifier alone (Cmd+K) count as keyboard use too;
      // the modifier keys by themselves do not.
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) keyboard = true;
    },
    true,
  );
  window.addEventListener("pointerdown", () => (keyboard = false), true);
}
export function usingKeyboard() {
  return keyboard;
}
