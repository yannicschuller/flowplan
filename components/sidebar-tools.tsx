"use client";
// The less used places at the bottom of the sidebar (Vorlagen, Medien, Tags,
// Graph, Papierkorb, Einstellungen, Tastenkürzel, Administration). Wider
// windows show them as one row of symbols; on phones (the navigation drawer,
// up to 767 px, app/globals.css) one labelled "Mehr" button next to the
// profile opens them as a list in a bottom sheet, so the page tree above
// keeps the height (#185). Both come from the same list, rendered by
// components/workspace-app.tsx. On phones the sheet also carries the account
// menu (design, about, legal, sign out), so the profile row has one button
// and the name and status keep the room (#197).
import { useRef, useState } from "react";
import { Toolbox, type Icon } from "@phosphor-icons/react";
import { Modal } from "./ui";
import { useT } from "./i18n";

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

// An entry of the sheet's account part: an action or a link.
export type SidebarAccountItem = {
  id: string;
  label: string;
  icon: Icon;
  href?: string;
  // Opens in a new tab (legal notice, privacy).
  external?: boolean;
  // Leaves the sheet open (the design switch shows its effect at once).
  keepOpen?: boolean;
  onSelect?: () => void;
};

// The row of symbols (hidden on phones, app/mobile-ux.css).
export function SidebarToolRow({ tools }: { tools: SidebarTool[] }) {
  return (
    <div className="sidebar-tools">
      {tools.map(({ id, label, title, icon: ToolIcon, selected, className, onSelect }) => (
        <button
          key={id}
          aria-label={label}
          title={title ?? label}
          className={[className, selected ? "selected" : ""].filter(Boolean).join(" ") || undefined}
          onClick={onSelect}
        >
          <ToolIcon size={18} />
        </button>
      ))}
    </div>
  );
}

// "Mehr" and its sheet (shown on phones only, app/mobile-ux.css).
export function SidebarMore({
  tools,
  account = [],
  signOut,
}: {
  tools: SidebarTool[];
  // The account menu's entries (phones; wider windows keep the "⋯" menu).
  account?: SidebarAccountItem[];
  // Last and set apart, so it is not tapped by mistake.
  signOut?: SidebarAccountItem;
}) {
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
        <Toolbox size={20} aria-hidden />
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
        {(account.length > 0 || signOut) && (
          <div className="sidebar-more-account" role="group" aria-label={t("Konto", "Account")}>
            <ul className="sidebar-more-account-list">
              {account.map((item) => (
                <li key={item.id}>
                  <AccountEntry
                    item={item}
                    onPick={() => {
                      if (item.keepOpen) return;
                      // A screen of the app takes the focus; after a new
                      // tab it returns to "Mehr".
                      chosen.current = !!item.href && !item.external;
                      setOpen(false);
                    }}
                  />
                </li>
              ))}
            </ul>
            {signOut && (
              <AccountEntry
                item={signOut}
                className="sidebar-more-sign-out"
                onPick={() => {
                  chosen.current = true;
                  setOpen(false);
                }}
              />
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

function AccountEntry({ item, className, onPick }: { item: SidebarAccountItem; className?: string; onPick: () => void }) {
  const { label, icon: ItemIcon, href, external, onSelect } = item;
  const content = (
    <>
      <ItemIcon size={22} aria-hidden />
      <span>{label}</span>
    </>
  );
  const select = () => {
    onPick();
    onSelect?.();
  };
  return href ? (
    <a href={href} className={className} onClick={select} {...(external ? { target: "_blank", rel: "noopener" } : {})}>
      {content}
    </a>
  ) : (
    <button type="button" className={className} onClick={select}>
      {content}
    </button>
  );
}
