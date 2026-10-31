"use client";
// Browsers offer navigator.clipboard only in secure contexts. On a plain-http
// instance (#62) every "Copy" button would throw on `undefined.writeText`;
// this stand-in copies text the old way (a selected text field and
// document.execCommand("copy"), which still works there on a click) and
// refuses reading, as a browser does without permission. Over HTTPS
// nothing changes.

function copyText(text: string) {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {}
  field.remove();
  active?.focus?.({ preventScroll: true });
  return copied;
}

const refused = () => Promise.reject(new DOMException("The clipboard needs HTTPS.", "NotAllowedError"));

export function installClipboardFallback() {
  if (typeof window === "undefined" || window.isSecureContext || "clipboard" in navigator) return;
  const clipboard = {
    writeText: (text: string) =>
      copyText(String(text)) ? Promise.resolve() : refused(),
    readText: refused,
    read: refused,
    write: refused,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  };
  try {
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  } catch {}
}
installClipboardFallback();

// Rendered once in the root layout so the module runs on every page.
export function ClipboardFallback() {
  return null;
}
