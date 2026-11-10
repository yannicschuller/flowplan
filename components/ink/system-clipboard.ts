"use client";
// Copied ink on the system clipboard as well (best effort): a PNG of the
// selection, an SVG where the browser takes one, and the typed text as
// plain text – so it can be pasted into other apps. Flowplan itself pastes
// from its own clipboard (lib/ink/clipboard.ts), which keeps the strokes.
// The write has to start inside the click or key press (Safari): the
// picture is handed over as a promise.
import type { InkItem } from "@/lib/ink/model";
import { inkAreaPng, inkAreaSvg } from "./ink-image";

type ClipboardItemCtor = typeof ClipboardItem & { supports?: (type: string) => boolean };

export function writeSystemClipboard(items: InkItem[]) {
  try {
    const Ctor = (typeof ClipboardItem !== "undefined" ? ClipboardItem : null) as ClipboardItemCtor | null;
    if (!Ctor || !navigator.clipboard?.write) return;
    const text = items.flatMap((i) => (i.type === "text" ? [i.text] : [])).join("\n");
    const data: Record<string, Promise<Blob>> = {
      "image/png": inkAreaPng(items, { target: 1200, background: "" }).then((png) => {
        if (!png) throw new Error("empty");
        return png.blob;
      }),
    };
    if (Ctor.supports?.("image/svg+xml")) {
      const area = inkAreaSvg(items);
      if (area) data["image/svg+xml"] = Promise.resolve(new Blob([area.svg], { type: "image/svg+xml" }));
    }
    if (text) data["text/plain"] = Promise.resolve(new Blob([text], { type: "text/plain" }));
    void navigator.clipboard.write([new Ctor(data)]).catch(() => {});
  } catch {
    // Not allowed here (no focus, an older browser): the tab's clipboard still has it.
  }
}
