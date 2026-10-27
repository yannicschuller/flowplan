"use client";
// The frames panel: every frame with a small picture, in presentation order.
// A click flies there; dragging (or Alt+arrow keys on the grip) changes the
// order of the presentation; the title can be renamed in place; the eye
// leaves a frame out of the presentation; each frame has speaker notes for
// the presenter view. On phones the panel is a sheet at the bottom.
import { memo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  DotsSixVertical,
  DownloadSimple,
  Eye,
  EyeSlash,
  LinkSimple,
  Notepad,
  PresentationChart,
  X,
} from "@phosphor-icons/react";
import { useT } from "../i18n";
import { SHEET_HANDLE } from "../sheet-drag";
import { WhiteboardDefs, WhiteboardShape, type PageRef, type RowCard } from "./render";
import { connectorPoint, type WhiteboardItem } from "@/lib/whiteboard-model";
import { frameMembers } from "@/lib/whiteboard-frames";

const FrameThumb = memo(function FrameThumb({
  frame,
  items,
  byId,
  pages,
  cards,
}: {
  frame: WhiteboardItem;
  items: WhiteboardItem[];
  byId: Map<string, WhiteboardItem>;
  pages: PageRef[];
  cards: Map<string, RowCard>;
}) {
  const members = frameMembers(frame, items, (end) => connectorPoint(end, byId));
  const shown = items.filter((i) => members.has(i.id) && i.type !== "comment" && i.type !== "frame").slice(0, 300);
  return (
    <svg className="wb-frame-thumb" viewBox={`${frame.x} ${frame.y} ${Math.max(1, frame.w)} ${Math.max(1, frame.h)}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <WhiteboardDefs />
      <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} fill={frame.fill && frame.fill !== "transparent" ? frame.fill : "#ffffff"} />
      {shown.map((item) => (
        <g key={item.id} className={`wb-${item.type}`}>
          <WhiteboardShape item={item} items={byId} pages={pages} cards={cards} />
        </g>
      ))}
    </svg>
  );
});

export function FramesPanel({
  frames,
  items,
  byId,
  pages,
  cards,
  editable,
  current,
  onFly,
  onRename,
  onToggleHidden,
  onMove,
  onNotes,
  onCopyLink,
  onExport,
  onPresent,
  onClose,
}: {
  frames: WhiteboardItem[];
  items: WhiteboardItem[];
  byId: Map<string, WhiteboardItem>;
  pages: PageRef[];
  cards: Map<string, RowCard>;
  editable: boolean;
  current: string | null;
  onFly: (frame: WhiteboardItem) => void;
  onRename: (id: string, text: string) => void;
  onToggleHidden: (id: string) => void;
  onMove: (from: number, to: number) => void;
  onNotes: (id: string, notes: string) => void;
  onCopyLink: (id: string) => void;
  onExport: (id: string) => void;
  onPresent: (frameId?: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [notesOpen, setNotesOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const shownCount = frames.filter((f) => !f.presentHidden).length;
  // Dragging a row by its grip: the gap follows the pointer.
  const target = (clientY: number) => {
    const rows = [...(list.current?.querySelectorAll<HTMLElement>(":scope > li") || [])];
    let index = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const box = rows[i].getBoundingClientRect();
      if (clientY < box.top + box.height / 2) {
        index = i;
        break;
      }
    }
    return index;
  };
  const gripDown = (e: ReactPointerEvent, index: number) => {
    if (!editable) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ from: index, to: index });
  };
  const gripMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const to = target(e.clientY);
    if (to !== drag.to) setDrag({ ...drag, to });
    // Long lists scroll while dragging near their edges.
    const box = list.current?.getBoundingClientRect();
    if (box && list.current) {
      if (e.clientY < box.top + 24) list.current.scrollTop -= 12;
      else if (e.clientY > box.bottom - 24) list.current.scrollTop += 12;
    }
  };
  const gripUp = () => {
    if (drag && drag.from !== drag.to) onMove(drag.from, drag.to);
    setDrag(null);
  };
  return (
    <aside className="wb-side-panel wb-frames-panel" aria-label={t("Rahmen", "Frames")} onPointerDown={(e) => e.stopPropagation()}>
      <div className={SHEET_HANDLE} aria-hidden />
      <header>
        <strong>{t("Rahmen", "Frames")}</strong>
        <small className="muted">
          {t(`${shownCount} von ${frames.length} in der Präsentation`, `${shownCount} of ${frames.length} in the presentation`)}
        </small>
        {shownCount > 0 && (
          <button type="button" className="text-button" onClick={() => onPresent()} title={t("Präsentieren", "Present")}>
            <PresentationChart size={15} /> {t("Präsentieren", "Present")}
          </button>
        )}
        <button type="button" className="icon-button" aria-label={t("Rahmen-Leiste schließen", "Close frames panel")} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {!frames.length ? (
        <p className="muted wb-side-empty">
          {t("Noch keine Rahmen. Mit dem Rahmen-Werkzeug (F) Bereiche anlegen – sie werden zu Folien.", "No frames yet. Create areas with the frame tool (F) – they become slides.")}
        </p>
      ) : (
        <ol ref={list} className="wb-frame-list" onPointerMove={gripMove} onPointerUp={gripUp} onPointerCancel={() => setDrag(null)}>
          {frames.map((frame, index) => {
            const gapBefore = drag && drag.to === index && drag.from > index;
            const gapAfter = drag && drag.to === index && drag.from < index;
            return (
              <li
                key={frame.id}
                className={`wb-frame-row${frame.presentHidden ? " hidden-slide" : ""}${current === frame.id ? " current" : ""}${drag?.from === index ? " dragging" : ""}${gapBefore ? " gap-before" : ""}${gapAfter ? " gap-after" : ""}`}
              >
                <div className="wb-frame-main">
                  {editable && (
                    <button
                      type="button"
                      className="wb-frame-grip"
                      aria-label={t(`„${frame.text || "Rahmen"}“ verschieben (Alt+Pfeiltasten)`, `Move “${frame.text || "Frame"}” (Alt+arrow keys)`)}
                      title={t("Ziehen, um die Reihenfolge zu ändern", "Drag to change the order")}
                      onPointerDown={(e) => gripDown(e, index)}
                      onKeyDown={(e) => {
                        if (!e.altKey && !e.metaKey && !e.ctrlKey) return;
                        if (e.key === "ArrowUp" && index > 0) {
                          e.preventDefault();
                          onMove(index, index - 1);
                        } else if (e.key === "ArrowDown" && index < frames.length - 1) {
                          e.preventDefault();
                          onMove(index, index + 1);
                        }
                      }}
                    >
                      <DotsSixVertical size={16} weight="bold" />
                    </button>
                  )}
                  <button type="button" className="wb-frame-fly" onClick={() => onFly(frame)} aria-label={t(`Zu „${frame.text || "Rahmen"}“`, `Go to “${frame.text || "Frame"}”`)}>
                    <span className="wb-frame-number">{frame.presentHidden ? "–" : frames.slice(0, index + 1).filter((f) => !f.presentHidden).length}</span>
                    <FrameThumb frame={frame} items={items} byId={byId} pages={pages} cards={cards} />
                  </button>
                  <div className="wb-frame-info">
                    {editable ? (
                      <input
                        key={`${frame.id}:${frame.text}`}
                        className="wb-frame-name"
                        defaultValue={frame.text || ""}
                        placeholder={t("Rahmen", "Frame")}
                        aria-label={t("Name des Rahmens", "Frame name")}
                        maxLength={200}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") {
                            e.currentTarget.value = frame.text || "";
                            e.currentTarget.blur();
                          }
                        }}
                        onBlur={(e) => e.currentTarget.value !== (frame.text || "") && onRename(frame.id, e.currentTarget.value)}
                      />
                    ) : (
                      <span className="wb-frame-name">{frame.text || t("Rahmen", "Frame")}</span>
                    )}
                    <span className="wb-frame-actions">
                      {editable && (
                        <button
                          type="button"
                          aria-pressed={!frame.presentHidden}
                          aria-label={frame.presentHidden ? t("In der Präsentation zeigen", "Show in the presentation") : t("In der Präsentation ausblenden", "Hide from the presentation")}
                          title={frame.presentHidden ? t("In der Präsentation zeigen", "Show in the presentation") : t("In der Präsentation ausblenden", "Hide from the presentation")}
                          onClick={() => onToggleHidden(frame.id)}
                        >
                          {frame.presentHidden ? <EyeSlash size={15} /> : <Eye size={15} />}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-expanded={notesOpen === frame.id}
                        className={frame.notes ? "has-notes" : undefined}
                        aria-label={t("Sprechernotizen", "Speaker notes")}
                        title={t("Sprechernotizen", "Speaker notes")}
                        onClick={() => setNotesOpen(notesOpen === frame.id ? null : frame.id)}
                      >
                        <Notepad size={15} />
                      </button>
                      <button type="button" aria-label={t("Link zu diesem Element kopieren", "Copy link to this element")} title={t("Link zu diesem Element kopieren", "Copy link to this element")} onClick={() => onCopyLink(frame.id)}>
                        <LinkSimple size={15} />
                      </button>
                      <button type="button" aria-label={t("Rahmen exportieren", "Export frame")} title={t("Rahmen exportieren", "Export frame")} onClick={() => onExport(frame.id)}>
                        <DownloadSimple size={15} />
                      </button>
                      {!frame.presentHidden && (
                        <button type="button" aria-label={t("Ab hier präsentieren", "Present from here")} title={t("Ab hier präsentieren", "Present from here")} onClick={() => onPresent(frame.id)}>
                          <PresentationChart size={15} />
                        </button>
                      )}
                    </span>
                  </div>
                </div>
                {notesOpen === frame.id &&
                  (editable ? (
                    <textarea
                      className="wb-frame-notes"
                      defaultValue={frame.notes || ""}
                      maxLength={20000}
                      placeholder={t("Notizen für die Referentenansicht …", "Notes for the presenter view …")}
                      aria-label={t(`Sprechernotizen zu „${frame.text || "Rahmen"}“`, `Speaker notes for “${frame.text || "Frame"}”`)}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => onNotes(frame.id, e.target.value)}
                    />
                  ) : (
                    <p className="wb-frame-notes">{frame.notes || t("Keine Notizen.", "No notes.")}</p>
                  ))}
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
