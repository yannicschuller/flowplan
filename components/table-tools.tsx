"use client";
// The commands of a table in a document, next to the table while the
// cursor is in it (#52): rows above or below, columns left or right, and in
// "…" deleting a row, a column or the table and the header row. The bar
// sits under the table; when that is off screen it stays at the bottom of
// the visible area – above the keyboard and the docked formatting toolbar
// on phones. Inside a dialog (a record) it lives in the dialog, so clicks
// reach it. Tab in the last cell adds a row (the table extension does it).
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  ColumnsPlusLeft,
  ColumnsPlusRight,
  DotsThree,
  RowsPlusBottom,
  RowsPlusTop,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { safeCollisionPadding, safeInsets } from "./safe-area";

type Place = { host: HTMLElement; top: number; left: number };

// The table element around the cursor.
function tableAt(editor: Editor): HTMLElement | null {
  try {
    const { node } = editor.view.domAtPos(editor.state.selection.from);
    const el = node instanceof HTMLElement ? node : node.parentElement;
    return (
      (el?.closest(".tableWrapper") as HTMLElement | null) ||
      (el?.closest("table") as HTMLElement | null)
    );
  } catch {
    return null;
  }
}

export function TableTools({ editor }: { editor: Editor }) {
  const t = useT();
  const bar = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const position = useCallback(() => {
    const table = tableAt(editor);
    if (!table) return setPlace(null);
    const host =
      (table.closest("[role=dialog]") as HTMLElement | null) || document.body;
    const rect = table.getBoundingClientRect();
    const height = bar.current?.offsetHeight || 36;
    const width = bar.current?.offsetWidth || 260;
    const vv = window.visualViewport;
    const safe = safeInsets();
    let bottom =
      (vv ? vv.offsetTop + vv.height : window.innerHeight) - safe.bottom - 8;
    // The formatting toolbar docked at the bottom on phones.
    const docked = document.querySelector<HTMLElement>(
      ".page-layout .editor-toolbar",
    );
    if (docked && getComputedStyle(docked).position === "fixed")
      bottom = Math.min(bottom, docked.getBoundingClientRect().top - 8);
    const top = Math.max(
      rect.top + 4,
      Math.min(rect.bottom + 6, bottom - height),
    );
    const left = Math.max(
      safe.left + 8,
      Math.min(rect.left, window.innerWidth - safe.right - width - 8),
    );
    const base =
      host === document.body
        ? { top: -window.scrollY, left: -window.scrollX }
        : (() => {
            const r = host.getBoundingClientRect();
            return {
              top: r.top + host.clientTop - host.scrollTop,
              left: r.left + host.clientLeft - host.scrollLeft,
            };
          })();
    setPlace((prev) => {
      const next = { host, top: top - base.top, left: left - base.left };
      return prev &&
        prev.host === next.host &&
        Math.abs(prev.top - next.top) < 0.5 &&
        Math.abs(prev.left - next.left) < 0.5
        ? prev
        : next;
    });
  }, [editor]);
  // After every editor update (the parent renders on each transaction), on
  // scroll anywhere and when the visible area changes (keyboard).
  useLayoutEffect(() => {
    position();
  });
  useLayoutEffect(() => {
    const vv = window.visualViewport;
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    vv?.addEventListener("resize", position);
    vv?.addEventListener("scroll", position);
    return () => {
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
      vv?.removeEventListener("resize", position);
      vv?.removeEventListener("scroll", position);
    };
  }, [position]);
  if (!place) return null;
  const run = (
    command: (
      chain: ReturnType<Editor["chain"]>,
    ) => ReturnType<Editor["chain"]>,
  ) => command(editor.chain().focus()).run();
  // The editor keeps the cursor: buttons do not take the focus.
  const keep = (e: React.MouseEvent | React.PointerEvent) => e.preventDefault();
  return createPortal(
    <div
      ref={bar}
      className="table-tools"
      role="toolbar"
      aria-label={t("Tabelle", "Table")}
      style={{ top: place.top, left: place.left }}
      onMouseDown={keep}
      onPointerDown={keep}
    >
      <button
        type="button"
        title={t("Zeile darüber", "Row above")}
        aria-label={t("Zeile darüber einfügen", "Insert row above")}
        onClick={() => run((c) => c.addRowBefore())}
      >
        <RowsPlusTop size={17} />
      </button>
      <button
        type="button"
        title={t("Zeile darunter", "Row below")}
        aria-label={t("Zeile darunter einfügen", "Insert row below")}
        onClick={() => run((c) => c.addRowAfter())}
      >
        <RowsPlusBottom size={17} />
      </button>
      <span className="table-tools-gap" aria-hidden="true" />
      <button
        type="button"
        title={t("Spalte links", "Column left")}
        aria-label={t("Spalte links einfügen", "Insert column left")}
        onClick={() => run((c) => c.addColumnBefore())}
      >
        <ColumnsPlusLeft size={17} />
      </button>
      <button
        type="button"
        title={t("Spalte rechts", "Column right")}
        aria-label={t("Spalte rechts einfügen", "Insert column right")}
        onClick={() => run((c) => c.addColumnAfter())}
      >
        <ColumnsPlusRight size={17} />
      </button>
      <span className="table-tools-gap" aria-hidden="true" />
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button
            type="button"
            title={t("Weitere Tabellenbefehle", "More table commands")}
            aria-label={t("Weitere Tabellenbefehle", "More table commands")}
          >
            <DotsThree size={17} weight="bold" />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal container={place.host}>
          <Dropdown.Content
            className="dropdown"
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={safeCollisionPadding()}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <Dropdown.Item
              className="dropdown-item"
              onSelect={() => run((c) => c.toggleHeaderRow())}
            >
              {t("Kopfzeile ein/aus", "Header row on/off")}
            </Dropdown.Item>
            <Dropdown.Separator className="dropdown-separator" />
            <Dropdown.Item
              className="dropdown-item"
              disabled={!editor.can().deleteRow()}
              onSelect={() => run((c) => c.deleteRow())}
            >
              {t("Zeile löschen", "Delete row")}
            </Dropdown.Item>
            <Dropdown.Item
              className="dropdown-item"
              disabled={!editor.can().deleteColumn()}
              onSelect={() => run((c) => c.deleteColumn())}
            >
              {t("Spalte löschen", "Delete column")}
            </Dropdown.Item>
            <Dropdown.Item
              className="dropdown-item danger"
              onSelect={() => run((c) => c.deleteTable())}
            >
              {t("Tabelle löschen", "Delete table")}
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </div>,
    place.host,
  );
}
