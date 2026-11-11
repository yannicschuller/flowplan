"use client";
import { useT } from "./i18n";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { CaretLeft, CaretRight, ClockCounterClockwise } from "@phosphor-icons/react";
import type { SlashCommand, SlashGroup, SlashSection } from "@/lib/slash-commands";
import { placeAtCaret, visibleArea, type Area, type Placement } from "@/lib/caret-popover";
import { safeInsets } from "./safe-area";
import { onKeyboardMove, remeasureKeyboard } from "./mobile-tab-bar";

export type SlashItem = SlashCommand & {
  id: string;
  icon: ComponentType<{ size?: number }>;
  // Shown greyed out with its description as the reason (e.g. the AI may
  // not read this page); choosing it does nothing.
  disabled?: boolean;
  children?: SlashItem[];
  run: () => void;
};

type T = (de: string, en: string) => string;
export const slashGroupLabels = (t: T): Record<SlashGroup, string> => ({
  recent: t("Zuletzt verwendet", "Recently used"),
  ai: t("KI", "AI"),
  text: t("Text", "Text"),
  lists: t("Listen", "Lists"),
  blocks: t("Blöcke", "Blocks"),
  media: t("Medien", "Media"),
  math: t("Mathematik", "Math"),
  database: t("Datenbank & Einbettungen", "Database & embeds"),
  extensions: t("Erweiterungen", "Extensions"),
  advanced: t("Weitere", "More"),
});

// The part of the screen a popover next to the caret may use: the visible
// area (the visual viewport, which the keyboard shrinks), below the status
// bar and above a toolbar fixed at the bottom – docked on the keyboard, or
// the document's toolbar and the tab bar on phones.
export function popoverArea(menu?: Element | null): Area {
  const vv = window.visualViewport;
  const viewport = vv ? { offsetTop: vv.offsetTop, height: vv.height } : { offsetTop: 0, height: window.innerHeight };
  const safe = safeInsets();
  const full = visibleArea(viewport, { safeTop: safe.top });
  let toolbarTop: number | null = null;
  for (const bar of document.querySelectorAll<HTMLElement>(".editor-toolbar, .mobile-tab-bar")) {
    if (menu?.contains(bar) || getComputedStyle(bar).position !== "fixed") continue;
    const rect = bar.getBoundingClientRect();
    // Only a bar along the bottom edge (not one at the top of the screen).
    if (!rect.height || rect.top <= (full.top + full.bottom) / 2 || rect.top >= full.bottom) continue;
    toolbarTop = Math.min(toolbarTop ?? Infinity, rect.top);
  }
  // Where the shell last measured the keyboard's top edge (mobile-tab-bar.tsx):
  // also the measurements iOS delivers late, without a viewport event.
  const docked = document.documentElement.classList.contains("keyboard-docked");
  const keyboardEnd = docked ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--keyboard-visible-end")) : NaN;
  if (Number.isFinite(keyboardEnd) && keyboardEnd > 0) toolbarTop = Math.min(toolbarTop ?? Infinity, keyboardEnd);
  const area = visibleArea(viewport, { safeTop: safe.top, toolbarTop });
  // Without a bar the home indicator keeps its room.
  return toolbarTop == null && !document.documentElement.classList.contains("keyboard-docked") ? { ...area, bottom: area.bottom - safe.bottom } : area;
}

// The block menu next to the caret: sections of blocks that follow typing
// after "/", arrow keys move across the sections, Enter chooses. From the
// toolbar button it brings its own search field. An entry with a second
// level (the callout kinds) opens that level in place.
export function SlashMenu({
  sections,
  active,
  anchor: givenAnchor,
  measureAnchor,
  search,
  parent,
  onBack,
  onSearch,
  onKey,
  onPick,
  onHover,
  onClose,
  container,
}: {
  container?: HTMLElement | null;
  sections: SlashSection<SlashItem>[];
  active: number;
  anchor: { left: number; top: number; bottom: number };
  // Where the "/" is now: the page can scroll under an open menu (iOS
  // bringing the line above the keyboard), the menu then follows it.
  measureAnchor?: () => { left: number; top: number; bottom: number } | null;
  search?: string;
  // The entry whose second level is shown.
  parent?: SlashItem | null;
  onBack?: () => void;
  onSearch?: (value: string) => void;
  onKey?: (event: React.KeyboardEvent) => void;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const anchor = measureAnchor?.() ?? givenAnchor;
  const box = useRef<HTMLDivElement>(null);
  const groupLabel = slashGroupLabels(t);
  const count = sections.reduce((sum, section) => sum + section.items.length, 0);
  const activeId = count ? `${id}-option-${active}` : undefined;
  // The chosen entry stays visible while moving with the arrow keys.
  useEffect(() => {
    box.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onClose]);
  // Placed inside the part of the screen the person sees (lib/caret-popover.ts):
  // with the keyboard open that is the visual viewport above the docked
  // toolbar, below the status bar – placed against innerHeight, the menu lay
  // behind the keyboard or up under the status bar on iPhones, where it could
  // not be scrolled (the touches went to what covered it or past it).
  // Inside a dialog the menu lives in the dialog (its focus trap and
  // outside-click handling). Dialogs are no containing block for fixed
  // children (app/globals.css, .modal), so window coordinates hold there too;
  // should anything still shift the menu, it is measured and moved back.
  const [place, setPlace] = useState<Placement | null>(null);
  const [, setViewportTick] = useState(0);
  // The keyboard coming up or iOS moving the visible area re-places it. iOS
  // reports the keyboard's size late – on a new, empty page the "/" can open
  // the menu while the keyboard is still coming up, and the final size often
  // arrives without a resize event: the shell's keyboard measurements (which
  // follow up for about a second) and a few timed checks re-place it too.
  useEffect(() => {
    const vv = window.visualViewport;
    const again = () => setViewportTick((n) => n + 1);
    vv?.addEventListener("resize", again);
    vv?.addEventListener("scroll", again);
    // The page or the pane scrolling under the menu (the caret brought into
    // view above the keyboard) moves the "/" – the menu goes with it.
    const scrolled = (event: Event) => {
      if (!(event.target instanceof Node && box.current?.contains(event.target))) again();
    };
    window.addEventListener("scroll", scrolled, true);
    const stop = onKeyboardMove(again);
    remeasureKeyboard();
    const timers = [80, 200, 400, 700, 1100].map((ms) => setTimeout(again, ms));
    return () => {
      vv?.removeEventListener("resize", again);
      vv?.removeEventListener("scroll", again);
      window.removeEventListener("scroll", scrolled, true);
      stop();
      for (const t of timers) clearTimeout(t);
    };
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const list = el.querySelector<HTMLElement>(".slash-menu-list");
    // What the menu takes in full: its frame plus the whole list.
    const full = el.offsetHeight - (list?.clientHeight ?? 0) + (list?.scrollHeight ?? 0);
    const next = placeAtCaret(anchor, full, popoverArea(el));
    setPlace((prev) => (prev && prev.top === next.top && prev.maxHeight === next.maxHeight && prev.below === next.below ? prev : next));
  });
  // Where it really landed: a containing block (or a web view resolving
  // fixed positions against another frame) would move it off the caret.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !place) return;
    const shift = Math.round(el.getBoundingClientRect().top - place.top);
    // (The opening animation moves it a few pixels itself.)
    if (Math.abs(shift) > 12) el.style.top = `${place.top - shift}px`;
  });
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(anchor.left, window.innerWidth - 328)),
    top: place?.top ?? anchor.bottom + 6,
    // Measured and placed before the first paint (the layout effects
    // above); not hidden meanwhile – its search field takes the focus.
    maxHeight: place?.maxHeight ?? 360,
  };
  const label = t("Block hinzufügen", "Add block");
  let index = 0;
  return createPortal(
    <div
      ref={box}
      className="slash-menu"
      style={style}
      // A swipe on it near the left edge is not the sidebar's swipe.
      data-no-edge-swipe=""
      // With its own search field the menu is a small dialog; next to the
      // caret it is just the list, the editor keeps the focus.
      role={search !== undefined ? "dialog" : undefined}
      aria-label={search !== undefined ? label : undefined}
      // Clicks keep the caret in the text.
      onMouseDown={(event) => {
        if (!(event.target as HTMLElement).closest("input"))
          event.preventDefault();
      }}
    >
      {search !== undefined && (
        <input
          autoFocus
          role="combobox"
          aria-label={t("Block suchen", "Search block")}
          aria-controls={`${id}-list`}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          placeholder={t("Block suchen …", "Search block …")}
          value={search}
          onChange={(event) => onSearch?.(event.target.value)}
          onKeyDown={onKey}
        />
      )}
      {parent && (
        <div className="slash-menu-parent">
          <button type="button" className="slash-menu-back" onClick={onBack} aria-label={t("Zurück zu allen Blöcken", "Back to all blocks")}>
            <CaretLeft size={14} aria-hidden />
          </button>
          <span>
            <parent.icon size={16} />
          </span>
          <strong>{parent.name}</strong>
          <small>{t("Art wählen", "Choose a kind")}</small>
        </div>
      )}
      <div
        id={`${id}-list`}
        className="slash-menu-list"
        role="listbox"
        aria-label={parent ? parent.name : label}
        aria-activedescendant={search === undefined ? activeId : undefined}
      >
        {count ? (
          sections.map((section) => {
            const headingId = `${id}-group-${section.group}`;
            return (
              <div key={section.group} role="group" aria-labelledby={parent ? undefined : headingId} className="slash-menu-group">
                {!parent && (
                  <div id={headingId} className="slash-menu-heading" role="presentation">
                    {section.group === "recent" && <ClockCounterClockwise size={12} aria-hidden />}
                    {groupLabel[section.group]}
                  </div>
                )}
                {section.items.map((item) => {
                  const current = index++;
                  return (
                    <button
                      key={`${section.group}:${item.id}`}
                      type="button"
                      role="option"
                      id={`${id}-option-${current}`}
                      data-index={current}
                      data-active={current === active}
                      aria-selected={current === active}
                      aria-disabled={item.disabled || undefined}
                      aria-haspopup={item.children ? "listbox" : undefined}
                      onMouseMove={() => current !== active && onHover(current)}
                      onClick={() => onPick(current)}
                    >
                      <span>
                        <item.icon size={18} />
                      </span>
                      <div>
                        <strong>{item.name}</strong>
                        <small>{item.description}</small>
                      </div>
                      {item.children && <CaretRight size={14} className="slash-menu-more" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            );
          })
        ) : (
          <p className="slash-menu-empty">{t("Kein passender Block", "No matching block")}</p>
        )}
      </div>
    </div>,
    container || document.body,
  );
}
