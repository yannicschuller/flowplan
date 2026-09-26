"use client";
import { useEffect, useRef, type ComponentType } from "react";
import { createPortal } from "react-dom";

export type SlashItem = {
  name: string;
  description: string;
  keywords: string[];
  icon: ComponentType<{ size?: number }>;
  run: () => void;
};

// The block menu next to the caret: a small list that follows typing after
// "/", arrow keys and Enter choose. From the toolbar button it brings its own
// search field.
export function SlashMenu({
  items,
  active,
  anchor,
  search,
  onSearch,
  onKey,
  onPick,
  onHover,
  onClose,
  container,
}: {
  container?: HTMLElement | null;
  items: SlashItem[];
  active: number;
  anchor: { left: number; top: number; bottom: number };
  search?: string;
  onSearch?: (value: string) => void;
  onKey?: (event: React.KeyboardEvent) => void;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
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
  // Inside a dialog the menu lives in the dialog (its focus trap and
  // outside-click handling); the dialog is transformed, so positions are
  // relative to it.
  const frame = container?.getBoundingClientRect() || {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  };
  const height = 340,
    fitsBelow = anchor.bottom + 6 + height < Math.min(window.innerHeight, frame.top + frame.height) - 8;
  const style = {
    left: Math.max(8, Math.min(anchor.left - frame.left, frame.width - 328)),
    top: fitsBelow ? anchor.bottom - frame.top + 6 : anchor.top - frame.top - 6,
    ...(fitsBelow ? {} : { transform: "translateY(-100%)" }),
  };
  return createPortal(
    <div
      ref={box}
      className="slash-menu"
      style={style}
      aria-label="Block hinzufügen"
      role="dialog"
      // Clicks keep the caret in the text.
      onMouseDown={(event) => {
        if (!(event.target as HTMLElement).closest("input"))
          event.preventDefault();
      }}
    >
      {search !== undefined && (
        <input
          autoFocus
          aria-label="Block suchen"
          placeholder="Block suchen …"
          value={search}
          onChange={(event) => onSearch?.(event.target.value)}
          onKeyDown={onKey}
        />
      )}
      <div className="slash-menu-list">
        {items.length ? (
          items.map((item, index) => (
            <button
              key={item.name}
              type="button"
              data-index={index}
              data-active={index === active}
              aria-current={index === active ? "true" : undefined}
              onMouseMove={() => index !== active && onHover(index)}
              onClick={() => onPick(index)}
            >
              <span>
                <item.icon size={18} />
              </span>
              <div>
                <strong>{item.name}</strong>
                <small>{item.description}</small>
              </div>
            </button>
          ))
        ) : (
          <p className="slash-menu-empty">Kein passender Block</p>
        )}
      </div>
    </div>,
    container || document.body,
  );
}
