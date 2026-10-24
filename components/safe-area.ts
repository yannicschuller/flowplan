// The safe areas – status bar, notch or Dynamic Island, home indicator – in
// CSS pixels, as the stylesheet resolves --safe-top … --safe-left
// (app/globals.css). Menus and popovers placed by script keep out of them
// like the app shell and dialogs do. Zero in an ordinary browser window.
export type Insets = { top: number; right: number; bottom: number; left: number };

const none: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
let cached: Insets | null = null;
let listening = false;

function measure(): Insets {
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
    "padding:var(--safe-top,0px) var(--safe-right,0px) var(--safe-bottom,0px) var(--safe-left,0px)";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const px = (v: string) => parseFloat(v) || 0;
  const insets = {
    top: px(style.paddingTop),
    right: px(style.paddingRight),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
  };
  probe.remove();
  return insets;
}

export function safeInsets(): Insets {
  if (typeof document === "undefined" || !document.body) return none;
  if (!listening) {
    listening = true;
    // Rotating the phone moves the notch to another side.
    const reset = () => {
      cached = null;
    };
    window.addEventListener("resize", reset);
    window.addEventListener("orientationchange", reset);
  }
  return (cached ??= measure());
}

// For Radix menus: the room they keep to the window edges.
export function safeCollisionPadding(gap = 8): Insets {
  const i = safeInsets();
  return { top: i.top + gap, right: i.right + gap, bottom: i.bottom + gap, left: i.left + gap };
}
