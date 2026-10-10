"use client";
import { useEffect, useRef, type ReactNode } from "react";

export type ContextMenuItem = { icon: ReactNode; label: string; run: () => void; danger?: boolean; disabled?: boolean } | "separator";

// A small menu at the pointer (right-click): arrow keys move, Escape,
// scrolling or a click elsewhere close it.
export function ContextMenu({ x, y, label, items, onClose }: { x: number; y: number; label: string; items: ContextMenuItem[]; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const shut = () => close.current();
    const away = (e: Event) => !menu.current?.contains(e.target as Node) && shut();
    const key = (e: KeyboardEvent) => e.key === "Escape" && shut();
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", shut, true);
    window.addEventListener("resize", shut);
    menu.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", shut, true);
      window.removeEventListener("resize", shut);
    };
  }, []);
  // Stays inside the window.
  const height = items.length * 36;
  const left = Math.max(8, Math.min(x, (typeof window === "undefined" ? 1200 : window.innerWidth) - 240));
  const top = Math.max(8, Math.min(y, (typeof window === "undefined" ? 800 : window.innerHeight) - height - 16));
  return (
    <div ref={menu} className="dropdown record-menu" role="menu" aria-label={label} style={{ position: "fixed", left, top }}>
      {items.map((item, index) =>
        item === "separator" ? (
          <div key={index} className="dropdown-separator" />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`dropdown-item${item.danger ? " danger" : ""}`}
            onClick={() => {
              onClose();
              item.run();
            }}
            onKeyDown={(e) => {
              const all = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") || [])];
              const i = all.indexOf(e.currentTarget);
              if (e.key === "ArrowDown") (e.preventDefault(), all[(i + 1) % all.length]?.focus());
              if (e.key === "ArrowUp") (e.preventDefault(), all[(i - 1 + all.length) % all.length]?.focus());
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
