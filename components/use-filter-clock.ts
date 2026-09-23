"use client";
import { useEffect, useState } from "react";
// Relative filters must advance at midnight even offline or with an unchanged data response.
export function useFilterClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      clearTimeout(timer);
      setNow(Date.now());
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 25);
    };
    const visible = () => {
      if (document.visibilityState === "visible") tick();
    };
    tick();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", tick);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", tick);
    };
  }, [active]);
  return now;
}
