"use client";

import { useEffect } from "react";
import { appViewportContent, isMobileApp } from "@/lib/app-zoom";

// In the iPhone/iPad/Android app pinch-to-zoom is off (the web keeps it for
// accessibility). Surfaces that zoom on their own (whiteboard, image viewer)
// set touch-action themselves and keep working.
export function NativeAppZoomLock() {
  useEffect(() => {
    if (!isMobileApp(window as unknown as { FlowplanApp?: unknown }, navigator.userAgent)) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const before = meta?.content;
    if (meta) meta.content = appViewportContent(before || "width=device-width, initial-scale=1");
    document.documentElement.classList.add("native-app");
    return () => {
      if (meta && before !== undefined) meta.content = before;
      document.documentElement.classList.remove("native-app");
    };
  }, []);
  return null;
}
