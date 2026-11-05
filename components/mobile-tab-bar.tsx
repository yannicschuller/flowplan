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
//
// While it is open, --keyboard-inset on <html> says how far the keyboard
// reaches into the layout viewport, so what docks at the bottom (the
// formatting toolbar, app/globals.css) sits right above it. Two ways a
// keyboard shows (#120):
// - Safari and the iOS app's WKWebView keep the layout viewport – the box
//   position: fixed refers to – at full height and only shrink the visual
//   viewport: bottom: 0 lies behind the keyboard, the inset lifts it out.
// - A web view the app resizes itself (Android) or a browser that resizes
//   the page: the layout viewport ends at the keyboard, the inset is 0.
// One shared listener for every component that asks.
let keyboardOpen = false;
const keyboardListeners = new Set<(open: boolean) => void>();
let stopKeyboardWatch: (() => void) | null = null;
function watchKeyboard() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  const coarse = window.matchMedia("(pointer: coarse)");
  if (viewport.width !== window.innerWidth) {
    viewport.width = window.innerWidth;
    viewport.tallest = vv?.height ?? window.innerHeight;
  }
  let frame = 0;
  let inset = -1;
  let visibleEnd = -1;
  const measure = () => {
    const height = vv?.height ?? window.innerHeight;
    // A rotation or a resized window starts over.
    if (window.innerWidth !== viewport.width) {
      viewport.width = window.innerWidth;
      viewport.tallest = height;
    }
    viewport.tallest = Math.max(viewport.tallest, height);
    const shrunk = height < viewport.tallest * 0.8 && viewport.tallest - height > 120;
    const open = shrunk || (coarse.matches && typing());
    // What of the layout viewport lies below the visible area. Zoomed in,
    // the two do not line up with the keyboard; the toolbar stays put.
    const below = vv && open && vv.scale < 1.01 ? Math.round(window.innerHeight - vv.offsetTop - vv.height) : 0;
    const next = below > 0 ? below : 0;
    if (next !== inset) {
      inset = next;
      if (next) root.style.setProperty("--keyboard-inset", `${next}px`);
      else root.style.removeProperty("--keyboard-inset");
    }
    // Where the visible area ends, measured from the top. iOS 26 (Safari and
    // the app's web view) resolves bottom: for position: fixed against the
    // full height from before the keyboard while top: follows the visible
    // area – measured on an iPhone (#120): innerHeight 528, visual viewport
    // 384 at 186, a toolbar at bottom: 0 ended up 144 px under the keyboard.
    // So the docked toolbar is placed from the top (app/globals.css,
    // html.keyboard-docked); where both agree (Android, desktop browsers) it
    // lands at the same spot.
    const end = vv && open && vv.scale < 1.01 ? Math.round(vv.offsetTop + vv.height) : 0;
    if (end !== visibleEnd) {
      visibleEnd = end;
      if (end) {
        root.style.setProperty("--keyboard-visible-end", `${end}px`);
        root.classList.add("keyboard-docked");
      } else {
        root.style.removeProperty("--keyboard-visible-end");
        root.classList.remove("keyboard-docked");
      }
    }
    if (open !== keyboardOpen) {
      keyboardOpen = open;
      for (const listener of keyboardListeners) listener(open);
    }
    if (debug) showDebug(height, open, below);
  };
  // Diagnosis on a real device (#120): ?kbdebug=1 once in the address shows
  // the measured numbers at the top; ?kbdebug=0 turns it off again.
  let debug = false;
  try {
    const flag = new URLSearchParams(location.search).get("kbdebug");
    if (flag !== null) localStorage.setItem("flowplan:kbdebug", flag === "0" ? "" : "1");
    debug = !!localStorage.getItem("flowplan:kbdebug");
  } catch {}
  const showDebug = (height: number, open: boolean, below: number) => {
    let box = document.getElementById("kb-debug");
    if (!box) {
      box = document.createElement("pre");
      box.id = "kb-debug";
      box.setAttribute("aria-hidden", "true");
      Object.assign(box.style, { position: "fixed", top: "0", left: "0", right: "0", zIndex: "2147483647", margin: "0", padding: "4px 6px", font: "11px/1.3 ui-monospace, monospace", background: "rgba(0,0,0,.75)", color: "#fff", pointerEvents: "none", whiteSpace: "pre-wrap" });
      document.body.appendChild(box);
    }
    box.style.top = `${vv ? Math.round(vv.offsetTop) : 0}px`;
    const bar = document.querySelector(".page-layout .editor-toolbar, .editor-toolbar") as HTMLElement | null;
    const rect = bar?.getBoundingClientRect();
    box.textContent = [
      `inner ${window.innerWidth}x${window.innerHeight} tallest ${Math.round(viewport.tallest)} vv ${Math.round(height)} top ${vv ? Math.round(vv.offsetTop) : "-"} scale ${vv ? vv.scale.toFixed(2) : "-"}`,
      `scrollY ${Math.round(window.scrollY)} open ${open} typing ${typing()} coarse ${coarse.matches} inset ${below}`,
      `kbInset-var ${root.style.getPropertyValue("--keyboard-inset") || "-"} active ${(document.activeElement as HTMLElement | null)?.className?.toString().slice(0, 30) || document.activeElement?.tagName}`,
      `shell.keyboard-open ${!!document.querySelector(".app-shell.keyboard-open")} bar ${rect ? `${Math.round(rect.top)}-${Math.round(rect.bottom)} ${getComputedStyle(bar!).position}` : "none"}`,
    ].join("\n");
  };
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
  };
  // iOS reports the keyboard's size late, sometimes only once the animation
  // is over, sometimes not at all after moving the visible area: measure
  // again for about a second after focus and viewport changes.
  let followUps: ReturnType<typeof setTimeout>[] = [];
  const settle = () => {
    update();
    for (const t of followUps) clearTimeout(t);
    followUps = [80, 200, 400, 700, 1100].map((ms) => setTimeout(update, ms));
  };
  vv?.addEventListener("resize", settle);
  // iOS moves the visible area over the page to show the caret.
  vv?.addEventListener("scroll", settle);
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  document.addEventListener("focusin", settle);
  document.addEventListener("focusout", settle);
  measure();
  return () => {
    cancelAnimationFrame(frame);
    for (const t of followUps) clearTimeout(t);
    vv?.removeEventListener("resize", settle);
    vv?.removeEventListener("scroll", settle);
    window.removeEventListener("resize", update);
    window.removeEventListener("orientationchange", update);
    document.removeEventListener("focusin", settle);
    document.removeEventListener("focusout", settle);
    root.style.removeProperty("--keyboard-inset");
    root.style.removeProperty("--keyboard-visible-end");
    root.classList.remove("keyboard-docked");
    keyboardOpen = false;
  };
}
export function useSoftKeyboard() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    keyboardListeners.add(setOpen);
    if (!stopKeyboardWatch) stopKeyboardWatch = watchKeyboard();
    setOpen(keyboardOpen);
    return () => {
      keyboardListeners.delete(setOpen);
      if (!keyboardListeners.size && stopKeyboardWatch) {
        stopKeyboardWatch();
        stopKeyboardWatch = null;
      }
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
