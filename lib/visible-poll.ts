// A timed refresh that pauses while the tab is hidden (#383): nobody sees
// a hidden tab, and every open one asked the server for the sidebar and the
// page every 10 s. A tick that falls into the hidden time is remembered and
// made up for as soon as the tab is shown again; offline, nothing is asked
// (the next tick online does it). Returns the function that stops it.
type VisibilityTarget = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
export function visiblePoll(
  run: () => void,
  ms: number,
  target: VisibilityTarget = document,
  online: () => boolean = () => navigator.onLine,
): () => void {
  let missed = false;
  const hidden = () => target.visibilityState === "hidden";
  const timer = setInterval(() => {
    if (hidden()) {
      missed = true;
      return;
    }
    if (online()) run();
  }, ms);
  const shown = () => {
    if (hidden() || !missed || !online()) return;
    missed = false;
    run();
  };
  target.addEventListener("visibilitychange", shown);
  return () => {
    clearInterval(timer);
    target.removeEventListener("visibilitychange", shown);
  };
}
