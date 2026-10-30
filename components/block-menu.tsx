"use client";
// The menu of a block (components/document-block-controls.tsx): a click on
// the handle opens it next to the handle; on phones it is a bottom sheet.
// Entries can open a second level ("Move below …", "Turn into …"); Escape
// or the back button returns to the first one.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CaretLeft, CaretRight, Check } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal, SHEET_MEDIA } from "./ui";
import { safeInsets } from "./safe-area";

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
    }
  | "separator";
export type BlockMenuView = { title: string; items: BlockMenuItem[]; note?: string };

function usePhone() {
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

export function BlockMenu({
  anchor,
  views,
  initial = "main",
  owner,
  onClose,
}: {
  // The handle (or button) the menu belongs to, in window coordinates.
  anchor: DOMRect;
  views: Record<string, BlockMenuView>;
  initial?: string;
  // A press on it (the handle) is no click elsewhere: it toggles the menu.
  owner?: HTMLElement | null;
  onClose: () => void;
}) {
  const t = useT();
  const phone = usePhone();
  const [view, setView] = useState(initial);
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const current = views[view] || views[initial];
  const back = view !== initial ? () => setView(initial) : null;

  // Desktop: beside the handle, inside the window.
  useLayoutEffect(() => {
    if (phone) return;
    const el = menu.current;
    if (!el) return;
    const safe = safeInsets();
    const width = el.offsetWidth,
      height = el.offsetHeight;
    let left = anchor.right + 6;
    if (left + width > window.innerWidth - 8 - safe.right) left = anchor.left - width - 6;
    left = Math.max(8 + safe.left, left);
    const top = Math.max(8 + safe.top, Math.min(anchor.top - 4, window.innerHeight - height - 8 - safe.bottom));
    setPlace({ left, top });
  }, [phone, anchor, view]);

  // A new level takes the focus on its first entry.
  // (The sheet's portal is there one frame later.)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = phone ? document.querySelector(".block-menu-sheet") : menu.current;
      root?.querySelector<HTMLElement>("[role^=menuitem]:not(:disabled)")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [view, phone, place === null]);

  useEffect(() => {
    if (phone) return;
    const away = (e: Event) =>
      !menu.current?.contains(e.target as Node) && !owner?.contains(e.target as Node) && close.current();
    const resize = () => close.current();
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", resize);
    };
  }, [phone, owner]);

  const list = (
    <div
      className="block-menu-items"
      onKeyDown={(e) => {
        const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)")];
        const i = all.indexOf(document.activeElement as HTMLElement);
        if (e.key === "ArrowDown") (e.preventDefault(), all[(i + 1) % all.length]?.focus());
        else if (e.key === "ArrowUp") (e.preventDefault(), all[(i - 1 + all.length) % all.length]?.focus());
        else if ((e.key === "ArrowLeft" || e.key === "Escape") && back) {
          e.preventDefault();
          e.stopPropagation();
          back();
        } else if (e.key === "Escape" && !phone) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {current.items.map((item, index) =>
        item === "separator" ? (
          <div key={index} className="dropdown-separator" role="separator" />
        ) : (
          <button
            key={`${view}-${index}`}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            disabled={item.disabled}
            className={`dropdown-item block-menu-item${item.danger ? " danger" : ""}`}
            style={item.indent ? { paddingInlineStart: 10 + item.indent * 14 } : undefined}
            onClick={() => {
              if (item.view) setView(item.view);
              else {
                item.run?.();
                onClose();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" && item.view) {
                e.preventDefault();
                setView(item.view);
              }
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.checked && <Check size={14} className="block-menu-check" aria-hidden />}
            {item.view && <CaretRight size={13} className="block-menu-more" aria-hidden />}
          </button>
        ),
      )}
      {current.note && <p className="block-menu-note">{current.note}</p>}
    </div>
  );

  if (phone)
    return (
      <Modal
        open
        sheet
        title={current.title}
        className="block-menu-sheet"
        onClose={onClose}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {back && (
          <button type="button" className="block-menu-back" onClick={back}>
            <CaretLeft size={15} aria-hidden />
            <span>{t("Zurück", "Back")}</span>
          </button>
        )}
        {list}
      </Modal>
    );
  return (
    <div
      ref={menu}
      className="dropdown record-menu block-menu"
      role="menu"
      aria-label={current.title}
      tabIndex={-1}
      style={{ position: "fixed", left: place?.left ?? -9999, top: place?.top ?? 0 }}
    >
      {back && (
        <button type="button" className="block-menu-back" onClick={back}>
          <CaretLeft size={13} aria-hidden />
          <span>{current.title}</span>
        </button>
      )}
      {list}
    </div>
  );
}
