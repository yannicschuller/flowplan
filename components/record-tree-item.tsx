"use client";
// A record in the page tree (#231): below its database, for records that
// have sub-pages (the database's other records stay in the database).
// Opens the record as a page of its own; its sub-pages unfold below it;
// pages dropped onto it move below the record.
import type { KeyboardEvent, ReactNode } from "react";
import { CaretRight, Plus } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Collapse } from "./motion";
import { PageIcon } from "./ui";
import type { TreeKeyItem } from "./journal-nav";

export function RecordTreeItem({
  id,
  parentTree,
  level,
  stop,
  icon,
  label,
  href,
  selected,
  open,
  dropping,
  onToggle,
  onOpen,
  onFocus,
  onKey,
  onDragOver,
  onDragLeave,
  onDrop,
  onAdd,
  children,
}: {
  id: string;
  parentTree: string;
  level: number;
  stop: string | null;
  icon: string;
  label: string;
  href: string;
  selected: boolean;
  open: boolean;
  dropping: boolean;
  onToggle: (open: boolean) => void;
  onOpen: () => void;
  onFocus: (id: string) => void;
  onKey: (e: KeyboardEvent<HTMLDivElement>, item: TreeKeyItem) => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onAdd?: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <div>
      <div
        className={`page-nav record-tree-item${selected ? " selected" : ""}${dropping ? " drop-inside" : ""}`}
        data-tree-id={id}
        data-record-tree={id}
        role="treeitem"
        aria-level={level + 1}
        aria-label={t(`Eintrag ${label}`, `Record ${label}`)}
        aria-selected={selected}
        aria-expanded={open}
        tabIndex={stop === id ? 0 : -1}
        onFocus={() => onFocus(id)}
        onKeyDown={(e) => onKey(e, { children: true, closed: !open, parentTree, fold: (fold) => onToggle(!fold), activate: onOpen })}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{ paddingLeft: 12 + level * 14 }}
      >
        <button
          className="tree-toggle"
          tabIndex={-1}
          aria-label={open ? t("Unterseiten schließen", "Collapse sub-pages") : t("Unterseiten öffnen", "Expand sub-pages")}
          onClick={() => onToggle(!open)}
        >
          <CaretRight size={12} className="nav-caret" style={{ transform: open ? "rotate(90deg)" : undefined }} />
        </button>
        {/* A real link: ⌘/Ctrl or the middle button open a new tab. */}
        <a className="page-nav-title" tabIndex={-1} href={href} onClick={onOpen}>
          <PageIcon name={icon || "file"} size={17} />
          <span className="page-nav-label">{label || t("Ohne Titel", "Untitled")}</span>
        </a>
        {onAdd && (
          <button
            className="nav-add"
            tabIndex={-1}
            title={t("Unterseite hinzufügen", "Add sub-page")}
            aria-label={t(`Unterseite in ${label} hinzufügen`, `Add sub-page in ${label}`)}
            onClick={onAdd}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      <Collapse open={open} className="nav-children">
        {open ? <div role="group">{children}</div> : null}
      </Collapse>
    </div>
  );
}
