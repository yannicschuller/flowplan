"use client";
// The bottom bar of the workspace on phones (≤ 767 px, CSS): Home, Search,
// New, Inbox and Menu (the drawer with the full page tree). It steps aside
// while the on-screen keyboard is open, so the formatting toolbar that docks
// at the bottom of a document never shares the space with it.
import { Bell, House, List, MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useT } from "./i18n";

const TEXT_INPUT = /^(text|search|email|url|tel|password|number|date|datetime-local|month|time|week)$/;
function typing() {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && TEXT_INPUT.test((el as HTMLInputElement).type || "text");
}

// The tallest viewport seen at the current width (kept across remounts, so a
// shell that renders while the keyboard is up still knows the full height).
// Measured as soon as the module loads, before any field can have the focus.
const viewport =
  typeof window === "undefined"
    ? { width: 0, tallest: 0 }
    : { width: window.innerWidth, tallest: window.visualViewport?.height ?? window.innerHeight };
// Whether the on-screen keyboard is (very likely) open: the visual viewport
// got clearly shorter than it was at this width, or – on touch screens, where
// browsers do not always resize – a text field has the focus.
export function useSoftKeyboard() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    const coarse = window.matchMedia("(pointer: coarse)");
    if (viewport.width !== window.innerWidth) {
      viewport.width = window.innerWidth;
      viewport.tallest = vv?.height ?? window.innerHeight;
    }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = vv?.height ?? window.innerHeight;
        // A rotation or a resized window starts over.
        if (window.innerWidth !== viewport.width) {
          viewport.width = window.innerWidth;
          viewport.tallest = height;
        }
        viewport.tallest = Math.max(viewport.tallest, height);
        const shrunk = height < viewport.tallest * 0.8 && viewport.tallest - height > 120;
        setOpen(shrunk || (coarse.matches && typing()));
      });
    };
    vv?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      vv?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);
  return open;
}

// The workspace scrolls its panes (.main-scroll, the sidebar, dialogs), never
// the document: html.shell-document (app/globals.css) turns the document's
// scrolling and rubber band off. iOS still moves the document for the
// keyboard and does not always move it back when the keyboard closes: the
// layout then sits too high, with empty space above the tab bar. Once no
// field has the focus any more, the document goes back to the top.
export function useShellDocument() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("shell-document");
    let frame = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // While typing, iOS keeps the caret above the keyboard this way.
        if (typing()) return;
        if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      });
    };
    const vv = window.visualViewport;
    window.addEventListener("scroll", settle, { passive: true });
    vv?.addEventListener("resize", settle);
    document.addEventListener("focusout", settle);
    settle();
    return () => {
      cancelAnimationFrame(frame);
      root.classList.remove("shell-document");
      window.removeEventListener("scroll", settle);
      vv?.removeEventListener("resize", settle);
      document.removeEventListener("focusout", settle);
    };
  }, []);
}

const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
const SCROLLS = /^(auto|scroll|overlay)$/;
// Whether an element from `from` up to `stop` scrolls along the axis.
function scrollerAlong(from: Element | null, stop: Element, axis: "x" | "y") {
  for (let el = from; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (axis === "y" ? SCROLLS.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1 : SCROLLS.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1)
      return true;
    if (el === stop) break;
  }
  return false;
}
// Fixed chrome (the tab bar, the top bar): a swipe that starts on it moves
// nothing. Without this, iOS hands the swipe to the document, which
// rubber-bands under the fixed bars – the content slides up behind the
// status bar and leaves an empty gap above the tab bar – and touch-action
// alone is not honoured there in every iOS web view. A row inside the chrome
// that scrolls along the swipe keeps it, fields keep theirs (caret, text
// selection) and two fingers (zoom) are left alone. Used as a ref callback;
// React calls the returned cleanup when the element goes.
export function guardChromeTouches(el: HTMLElement | null) {
  if (!el) return;
  let start: { x: number; y: number } | null = null;
  let block: boolean | null = null;
  const down = (e: TouchEvent) => {
    const touch = e.touches.length === 1 ? e.touches[0] : null;
    start = touch && { x: touch.clientX, y: touch.clientY };
    block = null;
  };
  const move = (e: TouchEvent) => {
    if (!e.cancelable || !start || e.touches.length !== 1) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(FIELD)) return;
    if (block === null) {
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      if (!dx && !dy) return;
      block = !scrollerAlong(target, el, Math.abs(dx) > Math.abs(dy) ? "x" : "y");
    }
    if (block) e.preventDefault();
  };
  el.addEventListener("touchstart", down, { passive: true });
  el.addEventListener("touchmove", move, { passive: false });
  return () => {
    el.removeEventListener("touchstart", down);
    el.removeEventListener("touchmove", move);
  };
}

export function MobileTabBar({
  active,
  unread,
  menuOpen,
  hidden,
  onHome,
  onSearch,
  onNew,
  onInbox,
  onMenu,
}: {
  active: "home" | "inbox" | null;
  unread: number;
  menuOpen: boolean;
  hidden: boolean;
  onHome: () => void;
  onSearch: () => void;
  // Missing when the reader may not create pages here.
  onNew?: () => void;
  onInbox: () => void;
  onMenu: () => void;
}) {
  const t = useT();
  const unreadLabel =
    unread > 0
      ? t(`Posteingang, ${unread} ungelesen`, `Inbox, ${unread} unread`)
      : t("Posteingang", "Inbox");
  return (
    <nav
      className="mobile-tab-bar"
      ref={guardChromeTouches}
      aria-label={t("Schnellnavigation", "Quick navigation")}
      hidden={hidden}
    >
      <button
        type="button"
        className="mobile-tab"
        aria-current={active === "home" ? "page" : undefined}
        onClick={onHome}
      >
        <House size={22} weight={active === "home" ? "fill" : "regular"} aria-hidden="true" />
        <span>{t("Start", "Home")}</span>
      </button>
      <button type="button" className="mobile-tab" aria-haspopup="dialog" onClick={onSearch}>
        <MagnifyingGlass size={22} aria-hidden="true" />
        <span>{t("Suchen", "Search")}</span>
      </button>
      <button
        type="button"
        className="mobile-tab mobile-tab-new"
        onClick={onNew}
        disabled={!onNew}
        title={onNew ? undefined : t("Du kannst hier keine Seiten anlegen.", "You cannot create pages here.")}
      >
        <span className="mobile-tab-new-icon" aria-hidden="true">
          <Plus size={20} weight="bold" />
        </span>
        {/* The visible label is the button's name (WCAG 2.5.3). */}
        <span>{t("Neue Seite", "New page")}</span>
      </button>
      <button
        type="button"
        className="mobile-tab"
        aria-current={active === "inbox" ? "page" : undefined}
        aria-label={unreadLabel}
        onClick={onInbox}
      >
        <span className="mobile-tab-icon" aria-hidden="true">
          <Bell size={22} weight={active === "inbox" ? "fill" : "regular"} />
          {unread > 0 && <span className="mobile-tab-badge">{unread > 99 ? "99+" : unread}</span>}
        </span>
        <span aria-hidden="true">{t("Posteingang", "Inbox")}</span>
      </button>
      <button
        type="button"
        className="mobile-tab"
        aria-expanded={menuOpen}
        aria-label={menuOpen ? t("Navigation schließen", "Close navigation") : t("Navigation öffnen", "Open navigation")}
        onClick={onMenu}
      >
        {menuOpen ? <X size={22} aria-hidden="true" /> : <List size={22} aria-hidden="true" />}
        {/* Part of the name ("Navigation öffnen"), as WCAG 2.5.3 asks of a visible label. */}
        <span aria-hidden="true">{t("Navigation", "Navigation")}</span>
      </button>
    </nav>
  );
}
