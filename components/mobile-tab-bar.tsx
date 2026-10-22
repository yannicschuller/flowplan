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
