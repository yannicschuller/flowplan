"use client";
import { useT } from "./i18n";
import { useEffect, useId, useRef, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { CaretLeft, CaretRight, ClockCounterClockwise } from "@phosphor-icons/react";
import type { SlashCommand, SlashGroup, SlashSection } from "@/lib/slash-commands";

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
  advanced: t("Weitere", "More"),
});

// The block menu next to the caret: sections of blocks that follow typing
// after "/", arrow keys move across the sections, Enter chooses. From the
// toolbar button it brings its own search field. An entry with a second
// level (the callout kinds) opens that level in place.
export function SlashMenu({
  sections,
  active,
  anchor,
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
  // Inside a dialog the menu lives in the dialog (its focus trap and
  // outside-click handling); the dialog is transformed, so positions are
  // relative to it.
  const frame = container?.getBoundingClientRect() || {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  };
  const height = 360,
    fitsBelow = anchor.bottom + 6 + height < Math.min(window.innerHeight, frame.top + frame.height) - 8;
  const style = {
    left: Math.max(8, Math.min(anchor.left - frame.left, frame.width - 328)),
    top: fitsBelow ? anchor.bottom - frame.top + 6 : anchor.top - frame.top - 6,
    ...(fitsBelow ? {} : { transform: "translateY(-100%)" }),
  };
  const label = t("Block hinzufügen", "Add block");
  let index = 0;
  return createPortal(
    <div
      ref={box}
      className="slash-menu"
      style={style}
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
