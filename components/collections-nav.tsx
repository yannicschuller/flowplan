"use client";
// "Sammlungen" in the sidebar (#86): the person's own collections (in their
// order: drag them, or "Nach oben"/"Nach unten" in the menu) and, below
// "Geteilt", those others shared with the workspace. Folding is remembered
// on this device.
import { useEffect, useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowDown, ArrowUp, CaretRight, Copy, DotsThree, FunnelSimple, PencilSimple, Plus, ShareNetwork, Trash } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Collapse } from "./motion";
import type { CollectionInfo } from "@/lib/collections";

const FOLD_KEY = "flowplan:collections-folded";

export function CollectionsNav({
  collections,
  current,
  onOpen,
  onNew,
  onEdit,
  onDuplicate,
  onDelete,
  onReorder,
}: {
  collections: CollectionInfo[];
  current: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onEdit: (c: CollectionInfo) => void;
  onDuplicate: (c: CollectionInfo) => void;
  onDelete: (c: CollectionInfo) => void;
  onReorder: (order: string[], moved: CollectionInfo) => void;
}) {
  const t = useT();
  const [folded, setFolded] = useState(false),
    [drag, setDrag] = useState<string | null>(null);
  useEffect(() => {
    try {
      setFolded(localStorage.getItem(FOLD_KEY) === "1");
    } catch {}
  }, []);
  const fold = (next: boolean) => {
    setFolded(next);
    try {
      localStorage.setItem(FOLD_KEY, next ? "1" : "0");
    } catch {}
  };
  const own = collections.filter((c) => c.mine),
    others = collections.filter((c) => !c.mine);
  const order = collections.map((c) => c.id);
  const move = (c: CollectionInfo, by: number) => {
    const list = c.mine ? own : others;
    const at = list.indexOf(c),
      to = at + by;
    if (to < 0 || to >= list.length) return;
    const ids = list.map((x) => x.id);
    ids.splice(at, 1);
    ids.splice(to, 0, c.id);
    onReorder(c.mine ? [...ids, ...others.map((x) => x.id)] : [...own.map((x) => x.id), ...ids], c);
  };
  const item = (c: CollectionInfo, list: CollectionInfo[]) => {
    const at = list.indexOf(c);
    return (
      <div
        key={c.id}
        className={`collection-nav${current === c.id ? " selected" : ""}${drag === c.id ? " dragging" : ""}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-flowplan-collection", c.id);
          e.dataTransfer.effectAllowed = "move";
          setDrag(c.id);
        }}
        onDragEnd={() => setDrag(null)}
        onDragOver={(e) => {
          if (!drag || drag === c.id || !list.some((x) => x.id === drag)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          const source = e.dataTransfer.getData("application/x-flowplan-collection");
          setDrag(null);
          if (!source || source === c.id) return;
          e.preventDefault();
          const moved = collections.find((x) => x.id === source);
          if (!moved || moved.mine !== c.mine) return;
          const ids = order.filter((x) => x !== source);
          ids.splice(ids.indexOf(c.id), 0, source);
          onReorder(ids, moved);
        }}
      >
        <button
          type="button"
          className="favorite-nav"
          aria-current={current === c.id ? "page" : undefined}
          title={c.query}
          onClick={() => onOpen(c.id)}
        >
          <span className="collection-nav-icon" aria-hidden>
            {c.icon || <FunnelSimple size={16} />}
          </span>
          <span>{c.name}</span>
          {c.mine && c.shared && <ShareNetwork size={12} className="collection-nav-shared" aria-label={t("Geteilt", "Shared")} />}
        </button>
        <Dropdown.Root>
          <Dropdown.Trigger className="icon-button collection-nav-menu" aria-label={t(`Sammlung ${c.name} verwalten`, `Manage collection ${c.name}`)}>
            <DotsThree size={16} />
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className="dropdown" align="end">
              {c.canEdit && (
                <Dropdown.Item className="dropdown-item" onSelect={() => onEdit(c)}>
                  <PencilSimple /> {t("Bearbeiten", "Edit")}
                </Dropdown.Item>
              )}
              <Dropdown.Item className="dropdown-item" onSelect={() => onDuplicate(c)}>
                <Copy /> {c.mine ? t("Duplizieren", "Duplicate") : t("Als meine Sammlung duplizieren", "Duplicate as my collection")}
              </Dropdown.Item>
              {at > 0 && (
                <Dropdown.Item className="dropdown-item" onSelect={() => move(c, -1)}>
                  <ArrowUp /> {t("Nach oben", "Move up")}
                </Dropdown.Item>
              )}
              {at < list.length - 1 && (
                <Dropdown.Item className="dropdown-item" onSelect={() => move(c, 1)}>
                  <ArrowDown /> {t("Nach unten", "Move down")}
                </Dropdown.Item>
              )}
              {c.canEdit && (
                <Dropdown.Item className="dropdown-item danger" onSelect={() => onDelete(c)}>
                  <Trash /> {t("Löschen", "Delete")}
                </Dropdown.Item>
              )}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>
    );
  };
  return (
    <section className={`nav-section collections-section${folded ? " space-collapsed" : ""}`} aria-label={t("Sammlungen", "Collections")}>
      <div className="nav-section-title">
        <button type="button" className="space-toggle" aria-expanded={!folded} aria-controls="collections-list" onClick={() => fold(!folded)}>
          <CaretRight size={10} className="space-caret" aria-hidden="true" />
          <span className="space-name">{t("Sammlungen", "Collections")}</span>
        </button>
        <span className="nav-section-tools">
          <button type="button" className="icon-button" aria-label={t("Neue Sammlung", "New collection")} title={t("Neue Sammlung", "New collection")} onClick={onNew}>
            <Plus size={14} />
          </button>
        </span>
      </div>
      <Collapse open={!folded} className="space-tree">
        {!folded ? (
          <div id="collections-list">
            {own.map((c) => item(c, own))}
            {!collections.length && (
              <button type="button" className="sidebar-empty collection-nav-empty" onClick={onNew}>
                {t("Suchen und Filter als Sammlung speichern", "Save searches and filters as a collection")}
              </button>
            )}
            {others.length > 0 && (
              <>
                <div className="collection-nav-heading">{t("Geteilt", "Shared")}</div>
                {others.map((c) => item(c, others))}
              </>
            )}
          </div>
        ) : null}
      </Collapse>
    </section>
  );
}
