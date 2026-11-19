"use client";
// Published databases on wide windows (#392): a record opened from a view
// shows in the side panel beside it (components/side-panel.tsx) instead of
// as a page of its own – decided by the window's width, not the device.
// The record's published page is fetched and its content (title,
// properties, text) shown in the panel; "Als Seite öffnen" leads to that
// page, ↑/↓ to the record before or after it in the view. On narrow
// windows and with ⌘/Ctrl/Shift the link opens as before (the page, with
// its back link, #393). Nothing is saved; no cookies.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowsOut } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { RECORD_DOCK_MEDIA } from "@/lib/side-panel";
import { recordLinkOf } from "@/lib/public-nav";

const SidePanel = lazy(() => import("./side-panel"));

// What of the record's page the panel shows: not the page's frame (header,
// publication line, back link, path, footer) nor anything that runs.
const FRAME = ".public-header, .publication-meta, .public-back, .public-breadcrumb, .shared-interactions, .home-footnote, .public-theme-footer, script, noscript, link, meta";

export function PublicRecordPeek() {
  const t = useT();
  const [open, setOpen] = useState<{ url: string; row: string; title: string } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [content, setContent] = useState<HTMLElement | null>(null);
  const body = useCallback((el: HTMLDivElement | null) => {
    if (!el || !content) return;
    el.replaceChildren(content);
    el.closest(".side-panel-body")?.scrollTo({ top: 0 });
  }, [content]);
  const openRef = useRef(open);
  openRef.current = open;
  // Record links of the views, in the page's order (↑/↓).
  const links = () =>
    [...document.querySelectorAll<HTMLAnchorElement>("main.public-page a[href*='row=']")]
      .filter((a) => !a.closest(".side-panel"))
      .flatMap((a) => {
        const found = recordLinkOf(a.getAttribute("href") || "", location);
        return found ? [{ ...found, title: a.getAttribute("title") || a.textContent?.trim() || "" }] : [];
      })
      // A record's title and its bar link to it twice: once each.
      .filter((link, i, all) => all.findIndex((other) => other.row === link.row) === i);
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!matchMedia(RECORD_DOCK_MEDIA).matches) return;
      const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>("a[href]");
      if (!link || link.target === "_blank" || link.closest(".side-panel") || !link.closest("main.public-page")) return;
      const found = recordLinkOf(link.getAttribute("href") || "", location);
      if (!found) return;
      event.preventDefault();
      setOpen({ ...found, title: link.getAttribute("title") || link.textContent?.trim() || t("Eintrag", "Record") });
    };
    document.addEventListener("click", click);
    return () => document.removeEventListener("click", click);
  }, [t]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setState("loading");
    fetch(open.url, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then((html) => {
        if (!alive) return;
        const page = new DOMParser().parseFromString(html, "text/html");
        const main = page.querySelector("main.public-page");
        if (!main) throw new Error("content");
        for (const el of main.querySelectorAll(FRAME)) el.remove();
        const heading = main.querySelector("h1")?.textContent?.trim();
        if (heading) setOpen((now) => (now && now.url === open.url ? { ...now, title: heading } : now));
        const wrap = document.createElement("div");
        wrap.className = "public-record-body";
        wrap.append(...[...main.childNodes].map((node) => document.importNode(node, true)));
        setContent(wrap);
        setState("ready");
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
    };
  }, [open?.url]);
  // The page beside the panel keeps its width for the panel.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("public-peek-open", !!open);
    return () => root.classList.remove("public-peek-open");
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
      if ((event.target as Element | null)?.closest?.("input, textarea, select, [contenteditable=true]")) return;
      const list = links();
      const at = list.findIndex((l) => l.row === openRef.current?.row);
      const next = at < 0 ? null : list[at + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      setOpen(next);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <SidePanel
        kind="record"
        owner="public-record"
        inline
        className="public-record-peek"
        label={t(`Eintrag „${open.title}“`, `Record “${open.title}”`)}
        title={open.title}
        actions={
          <a className="icon-button" href={open.url} aria-label={t("Als Seite öffnen", "Open as page")} title={t("Als Seite öffnen", "Open as page")}>
            <ArrowsOut size={17} />
          </a>
        }
        onClose={() => setOpen(null)}
      >
        {state === "loading" && (
          <p className="muted" role="status">
            {t("Wird geladen …", "Loading …")}
          </p>
        )}
        {state === "error" && (
          <p role="alert">
            {t("Der Eintrag ließ sich nicht laden.", "The record could not be loaded.")} <a href={open.url}>{t("Als Seite öffnen", "Open as page")}</a>
          </p>
        )}
        <div ref={body} hidden={state !== "ready"} />
      </SidePanel>
    </Suspense>
  );
}
