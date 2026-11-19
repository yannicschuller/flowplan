"use client";
// The docked side panel (#392, lib/side-panel.ts): a record of a database
// view or a PDF (components/pdf-panel.tsx) beside the page. In the app it
// takes the shell's right column (a portal into #side-dock-root, the shell
// gives it the width through lib/side-dock.ts) and the page narrows; on a
// published page it sits beside the content (`inline`). Its width is
// dragged at the left edge and kept per device; on phones it is a bottom
// sheet that is swiped down to close. Escape and × close it, focus goes
// back to where it came from. Loaded with its first opening.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { SidebarResize } from "./sidebar-resize";
import { SHEET_HANDLE, useSheetDrag } from "./sheet-drag";
import { useMedia } from "./use-media";
import { addBackCloser } from "@/lib/app-back";
import { claimDock, releaseDock, updateDock } from "@/lib/side-dock";
import {
  clampSidePanel,
  readSidePanelWidth,
  SIDE_PANEL_WIDTH,
  SIDE_SHEET_MEDIA,
  sidePanelMax,
  writeSidePanelWidth,
  type SidePanelKind,
} from "@/lib/side-panel";

export const SIDE_DOCK_ROOT = "side-dock-root";

function useViewportWidth() {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1280 : document.documentElement.clientWidth || window.innerWidth));
  useEffect(() => {
    const update = () => setWidth(document.documentElement.clientWidth || window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

// Dialogs, menus and lists that take Escape themselves.
const OWN_ESCAPE = '[aria-modal="true"], [role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], .dropdown, .modal-backdrop';
const editableTarget = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest("input, textarea, select, [contenteditable=true]");

export function SidePanel({
  kind,
  owner,
  label,
  title,
  icon,
  actions,
  onClose,
  children,
  className = "",
  inline = false,
  autoFocus = true,
  onKeyDown,
}: {
  kind: SidePanelKind;
  // Who has the panel (one at a time, lib/side-dock.ts).
  owner: string;
  // The panel's name for screen readers (the title may hold more).
  label: string;
  title: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  // Beside the content of a published page instead of the shell's column.
  inline?: boolean;
  // Focus moves into the panel when it opens.
  autoFocus?: boolean;
  onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
}) {
  const t = useT();
  const headingId = useId();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [placed, setPlaced] = useState(inline);
  useLayoutEffect(() => {
    if (!inline) setRoot(document.getElementById(SIDE_DOCK_ROOT));
    setPlaced(true);
  }, [inline]);
  const sheet = useMedia(SIDE_SHEET_MEDIA);
  const viewport = useViewportWidth();
  const [wanted, setWanted] = useState<number | null>(() => readSidePanelWidth(kind));
  const width = clampSidePanel(kind, wanted, viewport);
  const chooseWidth = (value: number | null) => {
    setWanted(value);
    writeSidePanelWidth(kind, value);
  };
  const close = useRef(onClose);
  close.current = onClose;
  // The shell's column: claimed while open, the panel before closes.
  const docked = !inline && !!root && !sheet;
  useLayoutEffect(() => {
    if (inline || !root) return;
    claimDock({ owner, kind, width, docked, onEvict: () => close.current() });
    return () => releaseDock(owner);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, inline, root]);
  useLayoutEffect(() => {
    if (!inline && root) updateDock(owner, { width, docked });
  }, [owner, inline, root, width, docked]);
  // Beside a published page: the page keeps the room for it.
  useLayoutEffect(() => {
    if (!inline) return;
    const style = document.documentElement.style;
    style.setProperty("--side-panel-inline-width", `${width}px`);
    return () => void style.removeProperty("--side-panel-inline-width");
  }, [inline, width]);

  const panel = useRef<HTMLElement | null>(null);
  const [panelElement, setPanelElement] = useState<HTMLElement | null>(null);
  const panelRef = useCallback((node: HTMLElement | null) => {
    panel.current = node;
    setPanelElement(node);
  }, []);
  // Focus: into the panel when it opens, back where it came from when it
  // closes (if it was inside the panel or nowhere).
  const returnTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) returnTo.current = active;
    return () => {
      const now = document.activeElement;
      const back = returnTo.current;
      if (now && now !== document.body && now.isConnected && !panel.current?.contains(now)) return;
      if (back?.isConnected && back.getClientRects().length) back.focus({ preventScroll: true });
      else document.getElementById("main-content")?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!autoFocus || !placed) return;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(".side-panel-heading")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed]);
  // Escape closes – in the panel unless something in it took the key; from
  // the page beside it unless a field, a dialog or a menu has it.
  useEffect(() => {
    let blocked = false;
    const capture = (event: KeyboardEvent) => {
      // Only what is on screen (a closed dialog may stay in the page).
      if (event.key === "Escape") blocked = [...document.querySelectorAll(OWN_ESCAPE)].some((el) => el.getClientRects().length > 0);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || blocked) return;
      const inside = !!panel.current?.contains(event.target as Node);
      if (!inside && editableTarget(event.target)) return;
      event.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", capture, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", capture, true);
      document.removeEventListener("keydown", key);
    };
  }, []);
  // Phones: swiped down or "back" closes the sheet.
  useSheetDrag(panelElement, sheet && placed, { onDismiss: () => close.current(), media: SIDE_SHEET_MEDIA });
  useEffect(() => (sheet ? addBackCloser(() => close.current()) : undefined), [sheet]);

  if (!placed || (!inline && !root)) return null;
  const body = (
    <aside
      ref={panelRef}
      className={`side-panel side-panel-${kind}${inline ? " side-panel-inline" : ""}${sheet ? " is-sheet" : ""} ${className}`.trim()}
      aria-labelledby={headingId}
      data-side-panel={kind}
      style={{ "--side-panel-width": `${width}px` } as React.CSSProperties}
      onKeyDown={onKeyDown}
    >
      <div className={SHEET_HANDLE} aria-hidden />
      {!sheet && (
        <SidebarResize
          edge="start"
          width={width}
          onWidth={chooseWidth}
          min={SIDE_PANEL_WIDTH[kind].min}
          max={sidePanelMax(kind, viewport)}
          fallback={SIDE_PANEL_WIDTH[kind].fallback}
          label={t("Breite des Seitenfensters", "Side panel width")}
          hint={t("Ziehen zum Ändern, Doppelklick setzt zurück", "Drag to resize, double-click to reset")}
        />
      )}
      <header className="side-panel-head">
        {icon}
        <h2 id={headingId} className="side-panel-heading" tabIndex={-1} aria-label={label}>
          {title}
        </h2>
        <span className="side-panel-actions">
          {actions}
          <button type="button" className="icon-button side-panel-close" aria-label={t("Seitenfenster schließen", "Close side panel")} title={t("Schließen (Esc)", "Close (Esc)")} onClick={() => close.current()}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className="side-panel-body">{children}</div>
    </aside>
  );
  return inline ? body : createPortal(body, root!);
}
export default SidePanel;
