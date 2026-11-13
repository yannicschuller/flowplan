"use client";
// The browser tab's icon in a workspace's accent (#277): while a workspace
// with its own accent is open, the page's icon links point to the mark in
// that colour (an SVG data URL, lib/workspace-theme.ts faviconHref); without
// one, or when leaving, they point back to Flowplan's own icons. Only the
// tab: the web app manifest and the apple-touch-icon – the installed apps'
// icons – stay Flowplan's.
import { useEffect } from "react";
import { faviconHref, type WorkspaceTheme } from "@/lib/workspace-theme";

export function WorkspaceFavicon({ theme }: { theme: WorkspaceTheme | null | undefined }) {
  const href = faviconHref(theme);
  useEffect(() => {
    if (!href) return;
    // rel~="icon" matches "icon" and "shortcut icon", not "apple-touch-icon".
    const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
    const before = links.map((l) => ({ link: l, href: l.getAttribute("href"), type: l.getAttribute("type"), sizes: l.getAttribute("sizes") }));
    for (const link of links) {
      link.setAttribute("href", href);
      link.setAttribute("type", "image/svg+xml");
      if (link.hasAttribute("sizes")) link.setAttribute("sizes", "any");
    }
    return () => {
      for (const { link, href, type, sizes } of before) {
        for (const [name, value] of [["href", href], ["type", type], ["sizes", sizes]] as const) {
          if (value === null) link.removeAttribute(name);
          else link.setAttribute(name, value);
        }
      }
    };
  }, [href]);
  return null;
}
