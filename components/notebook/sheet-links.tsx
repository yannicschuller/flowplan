"use client";
// Links on a sheet (lib/notebook-organize-model.ts NotebookLink): a chip
// with text, or a marked area over the handwriting, that jumps to another
// sheet of the notebook or opens a page. A tap follows it – while writing,
// in the reading view and when presenting. Editors drag a link to move it
// (the corner of an area resizes it) and change it with its pencil.
// Areas take taps only while no writing tool is in hand (`areas`); their
// badge in the corner always does.
import { useRef, useState } from "react";
import { ArrowSquareOut, LinkSimple, PencilSimpleLine } from "@phosphor-icons/react";
import { useT } from "../i18n";
import type { PageSize } from "@/lib/ink/coords";
import type { NotebookLink, NotebookLinkTarget } from "@/lib/notebook-organize-model";

type Moving = { id: string; pointer: number; x: number; y: number; resize: boolean; base: NotebookLink; moved: boolean };

export const pageHref = (pageId: string) => `/#page=${pageId}`;

export function SheetLinks({
  links,
  size,
  editable,
  areas,
  sheetName,
  onFollow,
  onChange,
  onEdit,
}: {
  links: NotebookLink[];
  size: PageSize;
  editable: boolean;
  areas: boolean;
  sheetName: (sheetId: string) => string;
  onFollow: (target: NotebookLinkTarget) => void;
  onChange?: (links: NotebookLink[]) => void;
  onEdit?: (link: NotebookLink) => void;
}) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const moving = useRef<Moving | null>(null);
  const [preview, setPreview] = useState<NotebookLink | null>(null);
  const suppress = useRef(false);
  if (!links.length) return null;
  const pct = (v: number, of: number) => `${(v / (of || 1)) * 100}%`;
  const down = (event: React.PointerEvent, link: NotebookLink, resize = false) => {
    if (!editable || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    moving.current = { id: link.id, pointer: event.pointerId, x: event.clientX, y: event.clientY, resize, base: link, moved: false };
  };
  const move = (event: React.PointerEvent) => {
    const m = moving.current;
    if (!m || m.pointer !== event.pointerId || !root.current) return;
    const scale = root.current.clientWidth / (size.width || 1);
    const dx = (event.clientX - m.x) / scale,
      dy = (event.clientY - m.y) / scale;
    if (!m.moved && Math.hypot(event.clientX - m.x, event.clientY - m.y) < 6) return;
    m.moved = true;
    event.preventDefault();
    const b = m.base;
    setPreview(
      m.resize
        ? { ...b, w: Math.max(16, Math.min(size.width - b.x, b.w + dx)), h: Math.max(16, Math.min(size.height - b.y, b.h + dy)) }
        : { ...b, x: Math.max(0, Math.min(size.width - 16, b.x + dx)), y: Math.max(0, Math.min(size.height - 16, b.y + dy)) },
    );
  };
  const up = (event: React.PointerEvent) => {
    const m = moving.current;
    if (!m || m.pointer !== event.pointerId) return;
    moving.current = null;
    const next = preview;
    setPreview(null);
    if (!m.moved || !next) return;
    suppress.current = true;
    setTimeout(() => (suppress.current = false), 0);
    onChange?.(links.map((l) => (l.id === next.id ? next : l)));
  };
  const follow = (event: React.MouseEvent, target: NotebookLinkTarget) => {
    if (suppress.current) {
      event.preventDefault();
      return;
    }
    if ("sheet" in target) {
      event.preventDefault();
      onFollow(target);
    } else onFollow(target);
  };
  return (
    <div ref={root} className="notebook-links ink-ui" onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {links.map((stored) => {
        const link = preview?.id === stored.id ? preview : stored;
        const where = "sheet" in link.target ? t(`Zu ${sheetName(link.target.sheet)}`, `To ${sheetName(link.target.sheet)}`) : t("Seite öffnen", "Open page");
        const href = "page" in link.target ? pageHref(link.target.page) : `#sheet-${link.target.sheet}`;
        const style = { left: pct(link.x, size.width), top: pct(link.y, size.height) };
        if (link.label)
          return (
            <span key={link.id} className={`notebook-link-chip${editable ? " is-editable" : ""}`} style={style}>
              <a href={href} title={where} onPointerDown={(e) => down(e, stored)} onClick={(e) => follow(e, link.target)} draggable={false}>
                {"page" in link.target ? <ArrowSquareOut size={14} /> : <LinkSimple size={14} />}
                {link.label}
              </a>
              {editable && onEdit && (
                <button type="button" className="notebook-link-edit" aria-label={t(`Link „${link.label}“ bearbeiten`, `Edit link “${link.label}”`)} onClick={() => onEdit(stored)}>
                  <PencilSimpleLine size={13} />
                </button>
              )}
            </span>
          );
        return (
          <span
            key={link.id}
            className={`notebook-link-area${areas ? " is-active" : ""}${editable ? " is-editable" : ""}`}
            style={{ ...style, width: pct(link.w, size.width), height: pct(link.h, size.height) }}
          >
            {areas && <a href={href} className="notebook-link-hit" aria-label={where} title={where} onPointerDown={(e) => down(e, stored)} onClick={(e) => follow(e, link.target)} draggable={false} />}
            <a href={href} className="notebook-link-badge" aria-label={where} title={where} onPointerDown={(e) => down(e, stored)} onClick={(e) => follow(e, link.target)} draggable={false}>
              <LinkSimple size={13} />
            </a>
            {editable && onEdit && (
              <button type="button" className="notebook-link-edit" aria-label={t("Link bearbeiten", "Edit link")} onClick={() => onEdit(stored)}>
                <PencilSimpleLine size={13} />
              </button>
            )}
            {editable && <span className="notebook-link-resize" aria-hidden="true" onPointerDown={(e) => down(e, stored, true)} />}
          </span>
        );
      })}
    </div>
  );
}
