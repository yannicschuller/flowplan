// Full screen that never throws (#533). requestFullscreen/exitFullscreen
// return a promise in today's browsers, but extensions that wrap them may
// return nothing or throw (seen: "Could not find the element that wants to
// be fullscreened", then "Cannot read properties of undefined (reading
// 'catch')"); an element no longer in the document is refused. Either way
// the presentation goes on in the window.
type Maybe = Promise<void> | void | undefined;
const settle = (run: () => Maybe) => {
  try {
    const result = run();
    if (result && typeof (result as Promise<void>).catch === "function") (result as Promise<void>).catch(() => {});
  } catch {}
};
export function enterFullscreen(el: Element | null | undefined) {
  if (!el || !el.isConnected || typeof el.requestFullscreen !== "function") return;
  settle(() => el.requestFullscreen());
}
export function leaveFullscreen() {
  if (typeof document === "undefined" || !document.fullscreenElement || typeof document.exitFullscreen !== "function") return;
  settle(() => document.exitFullscreen());
}
