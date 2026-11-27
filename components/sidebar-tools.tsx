"use client";
// The less used places at the bottom of the sidebar (Vorlagen, Medien, Tags,
// Graph, Papierkorb, Einstellungen, Tastenkürzel, Administration). Wider
// windows show them as one row of symbols; on phones (the navigation drawer,
// up to 767 px, app/globals.css) one small "Mehr" button at the left of that
// row opens them as a list in a bottom sheet, so the page tree above keeps
// the height (#185, #613). Both come from the same list, rendered by
// components/workspace-app.tsx. The account's entries (design, about,
// legal, sign out) are in the workspace menu at the top of the sidebar on
// every screen (#565), so the sheet holds the tools alone (#613). Which
// symbols the row shows is each person's choice (#589,
// lib/sidebar-tools-pref.ts): a right click – on touch screens a long
// press – on a symbol offers to hide it or to customize the row in
// Settings.
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { EyeSlash, SlidersHorizontal, Toolbox, type Icon } from "@phosphor-icons/react";
import { Modal } from "./ui";
import { useT } from "./i18n";
import { safeCollisionPadding } from "./safe-area";

export type SidebarTool = {
  id: string;
  // The name read out and shown in the sheet.
  label: string;
  // The tooltip of the symbol (default: the label).
  title?: string;
  icon: Icon;
  selected?: boolean;
  className?: string;
  onSelect: () => void;
};

// The row of symbols (hidden on phones, app/mobile-ux.css). With `onHide`
// and `onCustomize` each symbol has a menu (right click, long press, the
// context menu key or Shift+F10): "Aus Leiste ausblenden" and "Leiste
// anpassen …" (#589).
export function SidebarToolRow({ tools, onHide, onCustomize }: { tools: SidebarTool[]; onHide?: (id: string) => void; onCustomize?: () => void }) {
  const t = useT();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const row = useRef<HTMLDivElement>(null);
  // Where the focus goes when the menu closes (a symbol's id; null: none).
  const focusAfter = useRef<string | null>(null);
  // Touch: holding a symbol for half a second opens its menu; moving the
  // finger or letting go earlier is a tap as usual.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; opened: boolean } | null>(null);
  const withMenu = !!(onHide || onCustomize);
  const open = (id: string, x: number, y: number) => {
    focusAfter.current = id;
    setMenu({ id, x, y });
  };
  const focusTool = (id: string | null) => {
    if (!id) return;
    requestAnimationFrame(() => row.current?.querySelector<HTMLElement>(`[data-sidebar-tool="${id}"]`)?.focus());
  };
  const menuHandlers = (id: string) =>
    withMenu
      ? {
          onContextMenu: (e: ReactMouseEvent<HTMLButtonElement>) => {
            e.preventDefault();
            // A long press already opened it (Android sends contextmenu too).
            if (press.current?.opened) return;
            open(id, e.clientX, e.clientY);
          },
          onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
            if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
            e.preventDefault();
            const box = e.currentTarget.getBoundingClientRect();
            open(id, box.left + box.width / 2, box.top);
          },
          onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
            clearTimeout(press.current?.timer);
            if (e.pointerType !== "touch") {
              press.current = null;
              return;
            }
            const { clientX: x, clientY: y } = e;
            press.current = {
              x,
              y,
              opened: false,
              timer: setTimeout(() => {
                if (!press.current) return;
                press.current.opened = true;
                navigator.vibrate?.(10);
                open(id, x, y);
              }, 480),
            };
          },
          onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
            const state = press.current;
            if (state && !state.opened && Math.hypot(e.clientX - state.x, e.clientY - state.y) > 8) {
              clearTimeout(state.timer);
              press.current = null;
            }
          },
          onPointerUp: () => {
            if (press.current && !press.current.opened) {
              clearTimeout(press.current.timer);
              press.current = null;
            }
          },
          onPointerCancel: () => {
            clearTimeout(press.current?.timer);
            press.current = null;
          },
          // The tap that ends a long press must not also open the place.
          onClickCapture: (e: ReactMouseEvent<HTMLButtonElement>) => {
            if (press.current?.opened) {
              e.preventDefault();
              e.stopPropagation();
              press.current = null;
            }
          },
        }
      : {};
  const target = menu ? tools.find((tool) => tool.id === menu.id) : undefined;
  return (
    <div className="sidebar-tools" ref={row}>
      {tools.map(({ id, label, title, icon: ToolIcon, selected, className, onSelect }) => (
        <button
          key={id}
          data-sidebar-tool={id}
          aria-label={label}
          title={title ?? label}
          className={[className, selected ? "selected" : ""].filter(Boolean).join(" ") || undefined}
          onClick={onSelect}
          {...menuHandlers(id)}
        >
          <ToolIcon size={18} />
        </button>
      ))}
      {menu && target && (
        <Dropdown.Root open modal={false} onOpenChange={(o) => !o && setMenu(null)}>
          <Dropdown.Trigger asChild>
            <span className="context-anchor" style={{ left: menu.x, top: menu.y }} aria-hidden="true" />
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content
              className="dropdown sidebar-tool-menu"
              side="top"
              align="start"
              sideOffset={4}
              collisionPadding={safeCollisionPadding()}
              aria-label={t(`Aktionen für ${target.label}`, `Actions for ${target.label}`)}
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                focusTool(focusAfter.current);
              }}
            >
              {onHide && (
                <Dropdown.Item
                  className="dropdown-item"
                  onSelect={() => {
                    // The focus moves on to the next symbol (or the one before).
                    const index = tools.findIndex((tool) => tool.id === target.id);
                    focusAfter.current = (tools[index + 1] ?? tools[index - 1])?.id ?? null;
                    onHide(target.id);
                    // The symbol is gone with its menu: no close event may come.
                    focusTool(focusAfter.current);
                  }}
                >
                  <EyeSlash />
                  {t("Aus Leiste ausblenden", "Hide from toolbar")}
                </Dropdown.Item>
              )}
              {onCustomize && (
                <Dropdown.Item
                  className="dropdown-item"
                  onSelect={() => {
                    focusAfter.current = null;
                    onCustomize();
                  }}
                >
                  <SlidersHorizontal />
                  {t("Leiste anpassen …", "Customize toolbar…")}
                </Dropdown.Item>
              )}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      )}
    </div>
  );
}

// "Mehr" and its sheet (shown on phones only, app/mobile-ux.css).
export function SidebarMore({ tools }: { tools: SidebarTool[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // A chosen tool takes the focus where it leads (another dialog, a screen
  // after the drawer closed).
  const chosen = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const title = t("Mehr", "More");
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="sidebar-more"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          chosen.current = false;
          setOpen(true);
        }}
      >
        <Toolbox size={18} aria-hidden />
        <span>{title}</span>
      </button>
      <Modal
        open={open}
        sheet
        title={title}
        className="sidebar-more-sheet"
        onClose={() => setOpen(false)}
        onCloseAutoFocus={(event) => {
          // Otherwise back to "Mehr" – also after a tap, which on iOS does
          // not focus the button it opened from.
          event.preventDefault();
          if (!chosen.current) trigger.current?.focus();
        }}
      >
        <ul className="sidebar-more-list">
          {tools.map(({ id, label, icon: ToolIcon, selected, onSelect }) => (
            <li key={id}>
              <button
                type="button"
                aria-current={selected ? "page" : undefined}
                className={selected ? "selected" : undefined}
                onClick={() => {
                  chosen.current = true;
                  setOpen(false);
                  onSelect();
                }}
              >
                <ToolIcon size={22} aria-hidden />
                <span>{label}</span>
              </button>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
