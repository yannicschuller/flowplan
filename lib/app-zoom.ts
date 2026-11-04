// Whether the page runs inside the iPhone/iPad/Android app (window.FlowplanApp
// or the app's user agent). Pure, for the tests.
export function isMobileApp(win: { FlowplanApp?: unknown } | undefined, userAgent: string): boolean {
  return !!win?.FlowplanApp || /FlowplanMobile\//.test(userAgent);
}

// The viewport tag of the app: same as the web one, but pinch-to-zoom is off.
// Documents there scroll and reflow, zooming only gets in the way. The web
// keeps zooming for accessibility.
export function appViewportContent(content: string): string {
  const kept = content
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !/^(maximum-scale|minimum-scale|user-scalable)\s*=/.test(part));
  return [...kept, "maximum-scale=1", "user-scalable=no"].join(", ");
}
