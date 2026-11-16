"use client";
// The page's "⋯" menu (components/workspace-app.tsx): a dropdown on wider
// screens, a bottom sheet on phones (Modal `sheet`, components/ui.tsx), so
// its many entries scroll to the last one instead of running behind the
// editor's toolbar. The entries are written once with Item, CheckboxItem,
// Group and Separator from here; they render as Radix menu items in the
// dropdown and as buttons in the sheet – there still a menu of menu items
// (roles, checked state, arrow keys), so it reads and is found alike.
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { createContext, useContext, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { safeCollisionPadding } from "./safe-area";
import { Modal } from "./ui";

// Set inside the sheet: closes it after an entry was chosen.
const SheetMenu = createContext<(() => void) | null>(null);

export function Root({
  label,
  sheet,
  icon,
  children,
}: {
  // The trigger's name and the sheet's title.
  label: string;
  sheet: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!sheet)
    return (
      <Dropdown.Root>
        <Dropdown.Trigger className="icon-button" aria-label={label}>
          {icon}
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown" align="end">
            {children}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    );
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {icon}
      </button>
      <Modal
        open={open}
        sheet
        title={label}
        className="page-menu-sheet"
        onClose={() => setOpen(false)}
        onCloseAutoFocus={(event) => {
          // A chosen entry may open a dialog of its own, which keeps the
          // focus; otherwise it returns to "⋯" (also after a tap, which on
          // iOS does not focus the button).
          event.preventDefault();
          requestAnimationFrame(() => {
            const active = document.activeElement;
            if (!active || active === document.body) trigger.current?.focus();
          });
        }}
      >
        <SheetMenu.Provider value={() => setOpen(false)}>
          <div className="page-menu-sheet-list" role="menu" aria-label={label} onKeyDown={moveFocus}>
            {children}
          </div>
        </SheetMenu.Provider>
      </Modal>
    </>
  );
}

// Up, Down, Home and End move between the entries, as in the dropdown.
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role^='menuitem']:not([aria-disabled='true'])")];
  if (!items.length) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "Home" ? 0
    : event.key === "End" ? items.length - 1
    : event.key === "ArrowDown" ? (at + 1) % items.length
    : (at - 1 + items.length) % items.length;
  items[next].focus();
}

type ItemProps = {
  className?: string;
  disabled?: boolean;
  title?: string;
  // As Radix: preventDefault() keeps the menu open.
  onSelect?: (event: Event) => void;
  children: ReactNode;
};

// Runs the entry's action and closes the sheet unless it was kept open.
function choose({ onSelect, disabled }: ItemProps, close: () => void) {
  if (disabled) return;
  const event = new Event("select", { cancelable: true });
  onSelect?.(event);
  if (!event.defaultPrevented) close();
}

export function Item({ className, disabled, title, onSelect, children }: ItemProps) {
  const close = useContext(SheetMenu);
  if (!close)
    return (
      <Dropdown.Item className={className} disabled={disabled} title={title} onSelect={onSelect}>
        {children}
      </Dropdown.Item>
    );
  return (
    <button
      type="button"
      role="menuitem"
      className={className}
      aria-disabled={disabled || undefined}
      data-disabled={disabled ? "" : undefined}
      title={title}
      onClick={() => choose({ onSelect, disabled, children }, close)}
    >
      {children}
    </button>
  );
}

export function CheckboxItem({ checked, ...props }: ItemProps & { checked: boolean }) {
  const close = useContext(SheetMenu);
  if (!close)
    return (
      <Dropdown.CheckboxItem
        className={props.className}
        disabled={props.disabled}
        title={props.title}
        checked={checked}
        onSelect={props.onSelect}
      >
        {props.children}
      </Dropdown.CheckboxItem>
    );
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      className={props.className}
      aria-disabled={props.disabled || undefined}
      data-disabled={props.disabled ? "" : undefined}
      title={props.title}
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      onClick={() => choose(props, close)}
    >
      {props.children}
    </button>
  );
}

export function Group({ className, children }: { className?: string; children: ReactNode }) {
  const close = useContext(SheetMenu);
  if (!close) return <Dropdown.Group className={className}>{children}</Dropdown.Group>;
  return (
    <div role="group" className={className}>
      {children}
    </div>
  );
}

export function Separator({ className }: { className?: string }) {
  const close = useContext(SheetMenu);
  if (!close) return <Dropdown.Separator className={className} />;
  return <div role="separator" className={className} />;
}
