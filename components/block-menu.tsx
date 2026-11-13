"use client";
// The menu of a block (components/document-block-controls.tsx): a click on
// the handle opens it next to the handle; on phones it is a bottom sheet.
// Entries can open a second level ("Move below …", "Turn into …"); Escape
// or the back button returns to the first one. Other menus use it too (the
// meeting block's settings, #229): placed below their button, with a value
// beside an entry, entries that stay open (switches) and levels with a form.
//
// The block menu itself (#238) has a search field over all its entries
// (typing filters, ↵ runs the first hit) and, with a mouse, opens its
// levels as flyouts beside the entry instead of in place; on phones the
// levels stay in place. Entries can show their keyboard shortcut.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { CaretLeft, CaretRight, Check, MagnifyingGlass } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal, SHEET_MEDIA } from "./ui";
import { safeInsets } from "./safe-area";
import { useKeyboardHints } from "@/lib/keyboard-hints";

export type BlockMenuItem =
  | {
      icon: ReactNode;
      label: string;
      // Runs the action and closes the menu – or opens another level.
      run?: () => void;
      view?: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      // Indents entries of a level (headings below their parent heading).
      indent?: number;
      // Shown at the end of the row, before the arrow of a level ("Deutsch ›").
      value?: string;
      // A switch: runs without closing the menu.
      stay?: boolean;
      // The keyboard shortcut of the same action ("Mod+D"), shown right-aligned.
      shortcut?: string;
      // Further words the search finds the entry by (e.g. its English name).
      keywords?: string;
      // The name for screen readers when the label alone is ambiguous
      // ("Rot" under "Hintergrund").
      ariaLabel?: string;
    }
  | "separator"
  // A small heading inside a level ("Textfarbe", "Hintergrund").
  | { heading: string };
export type BlockMenuView = { title: string; items: BlockMenuItem[]; note?: string; content?: ReactNode };
// Why the menu closes: the focus goes back to its button after Escape and
// after an entry, not after a click elsewhere.
export type BlockMenuClose = "escape" | "select" | "away";
type Entry = Exclude<BlockMenuItem, "separator" | { heading: string }>;
const isEntry = (item: BlockMenuItem): item is Entry => item !== "separator" && !("heading" in item);

export function usePhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(SHEET_MEDIA);
    const sync = () => setPhone(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return phone;
}

// Search: case and accents do not matter.
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const FOCUSABLE = "[role^=menuitem]:not(:disabled)";

export function BlockMenu({
  anchor,
  views,
  initial = "main",
  owner,
  onClose,
  placement = "beside",
  label,
  className = "",
  searchable = false,
  flyouts = false,
}: {
  // The handle (or button) the menu belongs to, in window coordinates.
  anchor: DOMRect;
  views: Record<string, BlockMenuView>;
  initial?: string;
  // A press on it (the handle) is no click elsewhere: it toggles the menu.
  owner?: HTMLElement | null;
  onClose: (reason?: BlockMenuClose) => void;
  // "below": under the button, its right edges aligned (above it when there
  // is no room below), following it when the page scrolls.
  placement?: "beside" | "below";
  // The menu's name on every level, when it differs from the titles.
  label?: string;
  className?: string;
  // A search field over the entries of every level (#238).
  searchable?: boolean;
  // Levels as flyouts beside their entry (not on phones).
  flyouts?: boolean;
}) {
  const t = useT();
  const phone = usePhone();
  const hints = useKeyboardHints();
  const [view, setView] = useState(initial);
  const [query, setQuery] = useState("");
  // The open flyouts, outermost first: the level and the entry it belongs to.
  const [open, setOpen] = useState<{ view: string; entry: DOMRect }[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const hoverTimer = useRef(0);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const side = flyouts && !phone;
  const current = views[view] || views[initial];
  const back = view !== initial ? () => setView(initial) : null;
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  // Desktop: beside the handle (or below the button), inside the window.
  useLayoutEffect(() => {
    if (phone) return;
    const position = () => {
      const el = menu.current;
      if (!el) return;
      const safe = safeInsets();
      const width = el.offsetWidth,
        height = el.offsetHeight;
      if (placement === "below") {
        const box = owner?.isConnected ? owner.getBoundingClientRect() : anchor;
        const left = Math.max(8 + safe.left, Math.min(box.right - width, window.innerWidth - width - 8 - safe.right));
        let top = box.bottom + 4;
        if (top + height > window.innerHeight - 8 - safe.bottom && box.top - height - 4 >= 8 + safe.top) top = box.top - height - 4;
        setPlace({ left, top: Math.max(8 + safe.top, top) });
        return;
      }
      let left = anchor.right + 6;
      if (left + width > window.innerWidth - 8 - safe.right) left = anchor.left - width - 6;
      left = Math.max(8 + safe.left, left);
      const top = Math.max(8 + safe.top, Math.min(anchor.top - 4, window.innerHeight - height - 8 - safe.bottom));
      setPlace({ left, top });
    };
    position();
    if (placement !== "below") return;
    window.addEventListener("scroll", position, true);
    return () => window.removeEventListener("scroll", position, true);
  }, [phone, anchor, view, placement, owner]);

  // A new level takes the focus on its first entry.
  // (The sheet's portal is there one frame later.)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const rootEl = phone ? document.querySelector(".block-menu-sheet") : menu.current;
      rootEl?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [view, phone, place === null]);

  useEffect(() => {
    if (phone) return;
    const away = (e: Event) =>
      !root.current?.contains(e.target as Node) && !owner?.contains(e.target as Node) && close.current("away");
    const resize = () => close.current("away");
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", resize);
    };
  }, [phone, owner]);

  // The search: every entry that does something, on every level, with
  // the level's title as its context ("Umwandeln in … › Toggle").
  const found: { item: Entry; context: string }[] = [];
  if (searchable && query.trim()) {
    const words = fold(query.trim()).split(/\s+/);
    const seen = new Set<string>();
    const visit = (key: string, context: string) => {
      if (seen.has(key) || !views[key]) return;
      seen.add(key);
      for (const item of views[key].items) {
        if (!isEntry(item)) continue;
        if (item.view) {
          visit(item.view, (views[item.view]?.title || item.label).replace(/\s*…$/, ""));
          continue;
        }
        const haystack = fold(`${item.label} ${item.keywords || ""} ${context}`);
        if (words.every((word) => haystack.includes(word))) found.push({ item, context });
      }
    };
    visit(initial, "");
  }
  const searching = searchable && !!query.trim();

  function openFlyout(level: number, item: Entry, button: HTMLElement, focus: boolean) {
    if (!item.view) return;
    const entry = button.getBoundingClientRect();
    setOpen((stack) => [...stack.slice(0, level), { view: item.view!, entry }]);
    if (focus)
      requestAnimationFrame(() =>
        root.current?.querySelector<HTMLElement>(`[data-flyout-level="${level + 1}"] ${FOCUSABLE}`)?.focus({ preventScroll: true }),
      );
  }
  function choose(item: Entry, level: number, button: HTMLElement) {
    if (item.view) {
      if (side) openFlyout(level, item, button, false);
      else setView(item.view);
    } else if (item.stay) item.run?.();
    else {
      item.run?.();
      onClose("select");
    }
  }
  // Typing on an entry goes to the search field.
  function typeahead(e: ReactKeyboardEvent) {
    if (!searchable || phone || e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || !search.current) return false;
    search.current.focus();
    return false;
  }

  const shortcut = (item: Entry) => {
    const keys = item.shortcut ? hints.keys(item.shortcut) : "";
    return keys ? (
      <kbd className="block-menu-shortcut" aria-hidden>
        {keys}
      </kbd>
    ) : null;
  };
  const row = (item: Entry, key: string, level: number, context?: string) => (
    <button
      key={key}
      type="button"
      role={item.checked === undefined ? "menuitem" : item.stay ? "menuitemcheckbox" : "menuitemradio"}
      aria-checked={item.checked}
      aria-label={item.ariaLabel}
      aria-haspopup={item.view ? "menu" : undefined}
      aria-expanded={item.view && side ? open[level]?.view === item.view : undefined}
      aria-keyshortcuts={item.shortcut ? item.shortcut.replace(/Mod/g, hints.mac ? "Meta" : "Control") : undefined}
      disabled={item.disabled}
      className={`dropdown-item block-menu-item${item.danger ? " danger" : ""}${item.view && side && open[level]?.view === item.view ? " open" : ""}`}
      style={item.indent ? { paddingInlineStart: 10 + item.indent * 14 } : undefined}
      onClick={(e) => choose(item, level, e.currentTarget)}
      onPointerEnter={(e) => {
        if (!side || e.pointerType === "touch") return;
        window.clearTimeout(hoverTimer.current);
        const button = e.currentTarget;
        // Pointing at another entry closes this level's flyout; at an entry
        // with a level opens it (a moment later, so passing over it does not).
        hoverTimer.current = window.setTimeout(() => {
          if (!button.isConnected) return;
          if (item.view && !item.disabled) openFlyout(level, item, button, false);
          else setOpen((stack) => stack.slice(0, level));
        }, 140);
      }}
      onKeyDown={(e) => {
        if ((e.key === "ArrowRight" || (side && (e.key === "Enter" || e.key === " "))) && item.view) {
          e.preventDefault();
          if (side) openFlyout(level, item, e.currentTarget, true);
          else setView(item.view);
        }
      }}
    >
      {item.icon}
      <span>
        {context && item.ariaLabel ? item.ariaLabel : item.label}
        {context && <small className="block-menu-context"> · {context}</small>}
      </span>
      {item.value && <span className="block-menu-value">{item.value}</span>}
      {shortcut(item)}
      {item.checked && <Check size={14} className="block-menu-check" aria-hidden />}
      {item.view && <CaretRight size={13} className="block-menu-more" aria-hidden />}
    </button>
  );
  const items = (list: BlockMenuItem[], key: string, level: number) =>
    list.map((item, index) =>
      item === "separator" ? (
        <div key={`${key}-${index}`} className="dropdown-separator" role="separator" />
      ) : "heading" in item ? (
        <div key={`${key}-${index}`} className="block-menu-heading" role="presentation">
          {item.heading}
        </div>
      ) : (
        row(item, `${key}-${index}`, level)
      ),
    );
  const keys = (level: number, onBack: (() => void) | null) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") (e.preventDefault(), all[(i + 1) % all.length]?.focus());
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (i <= 0 && level === 0 && searchable && !phone) search.current?.focus();
      else all[(i - 1 + all.length) % all.length]?.focus();
    } else if (e.key === "Home") (e.preventDefault(), all[0]?.focus());
    else if (e.key === "End") (e.preventDefault(), all[all.length - 1]?.focus());
    else if ((e.key === "ArrowLeft" || e.key === "Escape") && onBack) {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    } else if (e.key === "Escape" && !phone) {
      e.preventDefault();
      e.stopPropagation();
      onClose("escape");
    } else typeahead(e);
  };
  // Back from a flyout: to its entry in the level before.
  const closeFlyout = (level: number) => () => {
    setOpen((stack) => stack.slice(0, level - 1));
    const entry = root.current?.querySelector<HTMLElement>(`[data-flyout-level="${level - 1}"] .block-menu-item.open`);
    entry?.focus({ preventScroll: true });
  };

  const searchField = searchable ? (
    <div className="block-menu-search">
      <MagnifyingGlass size={14} aria-hidden />
      <input
        ref={search}
        type="search"
        role="searchbox"
        value={query}
        placeholder={t("Aktionen suchen …", "Search actions …")}
        aria-label={t("Aktionen und Blocktypen suchen", "Search actions and block types")}
        // Not in the tab order of the sheet: the keyboard of a phone would cover it.
        enterKeyHint="go"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen([]);
          if (back) setView(initial);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const first = found.find(({ item }) => !item.disabled);
            if (first) {
              first.item.run?.();
              if (!first.item.stay) onClose("select");
            }
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            (phone ? document.querySelector(".block-menu-sheet") : menu.current)?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (query) setQuery("");
            else if (!phone) onClose("escape");
          }
        }}
      />
    </div>
  ) : null;
  const results = (
    <div className="block-menu-items" onKeyDown={keys(0, null)}>
      {found.length ? (
        found.map(({ item, context }, index) => row(item, `found-${index}`, 0, context))
      ) : (
        <p className="block-menu-note" role="status">
          {t("Keine passende Aktion", "No matching action")}
        </p>
      )}
    </div>
  );
  const list = searching ? (
    results
  ) : (
    <div className="block-menu-items" onKeyDown={keys(0, back)}>
      {items(current.items, view, 0)}
      {current.note && <p className="block-menu-note">{current.note}</p>}
    </div>
  );
  // A level with a form (a text field): Escape there goes back as well.
  const content =
    current.content && !searching ? (
      <div
        className="block-menu-content"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          if (back) back();
          else if (!phone) onClose("escape");
        }}
      >
        {current.content}
      </div>
    ) : null;

  if (phone)
    return (
      <Modal
        open
        sheet
        title={current.title}
        className={`block-menu-sheet ${className}`}
        onClose={() => onClose("escape")}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {!back && searchField}
        {back && (
          <button type="button" className="block-menu-back" onClick={back}>
            <CaretLeft size={15} aria-hidden />
            <span>{t("Zurück", "Back")}</span>
          </button>
        )}
        {list}
        {content}
      </Modal>
    );
  return (
    <div ref={root} className="block-menu-root">
      <div
        ref={menu}
        data-layer=""
        data-flyout-level="0"
        className={`dropdown record-menu block-menu ${className}`}
        role="menu"
        aria-label={label || current.title}
        tabIndex={-1}
        style={{ position: "fixed", left: place?.left ?? -9999, top: place?.top ?? 0 }}
      >
        {!back && searchField}
        {back && (
          <button type="button" className="block-menu-back" onClick={back}>
            <CaretLeft size={13} aria-hidden />
            <span>{current.title}</span>
          </button>
        )}
        {list}
        {content}
      </div>
      {side &&
        !searching &&
        open.map((flyout, index) => {
          const level = views[flyout.view];
          if (!level) return null;
          return (
            <Fragment key={`${index}-${flyout.view}`}>
              <Flyout entry={flyout.entry} level={index + 1} title={level.title} className={className} onKeyDown={keys(index + 1, closeFlyout(index + 1))}>
                {items(level.items, flyout.view, index + 1)}
                {level.note && <p className="block-menu-note">{level.note}</p>}
              </Flyout>
            </Fragment>
          );
        })}
    </div>
  );
}

// A level beside its entry: right of it, or left where there is no room.
function Flyout({
  entry,
  level,
  title,
  className,
  onKeyDown,
  children,
}: {
  entry: DOMRect;
  level: number;
  title: string;
  className: string;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const safe = safeInsets();
    const width = el.offsetWidth,
      height = el.offsetHeight;
    let left = entry.right + 4;
    if (left + width > window.innerWidth - 8 - safe.right) left = entry.left - width - 4;
    left = Math.max(8 + safe.left, left);
    const top = Math.max(8 + safe.top, Math.min(entry.top - 6, window.innerHeight - height - 8 - safe.bottom));
    setPlace({ left, top });
  }, [entry]);
  return (
    <div
      ref={ref}
      data-layer=""
      data-flyout-level={level}
      className={`dropdown record-menu block-menu block-menu-flyout ${className}`}
      role="menu"
      aria-label={title}
      tabIndex={-1}
      style={{ position: "fixed", left: place?.left ?? -9999, top: place?.top ?? 0 }}
    >
      <div className="block-menu-items" onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>
  );
}
