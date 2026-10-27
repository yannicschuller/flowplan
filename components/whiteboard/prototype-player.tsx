"use client";
// Clickable prototypes: "Prototyp abspielen" shows one frame at a time,
// full screen, and follows the click links of its elements (with hints
// where one can click, back, restart and Esc). Links are set in the style
// bar ("Bei Klick → …"); a small badge on the board shows them.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowCounterClockwise, ArrowLeft, CursorClick, X } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Select } from "../select";
import type { WhiteboardItem } from "@/lib/whiteboard-model";
import { linkTarget } from "@/lib/whiteboard-diagram-model";
import { followLink, frameContents, hotspots, prototypeFrames } from "@/lib/whiteboard-prototype";
import { WhiteboardDefs, WhiteboardShape, type PageRef } from "./render";

export function PrototypePlayer({
  items,
  start,
  pages,
  onClose,
}: {
  items: WhiteboardItem[];
  start: string | null;
  pages: PageRef[];
  onClose: () => void;
}) {
  const t = useT();
  const frames = useMemo(() => prototypeFrames(items), [items]);
  const frameIds = useMemo(() => new Set(frames.map((f) => f.id)), [frames]);
  const first = start && frameIds.has(start) ? start : frames[0]?.id;
  const [history, setHistory] = useState<string[]>(first ? [first] : []);
  const [hint, setHint] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = frames.find((f) => f.id === history[history.length - 1]) || frames[0];
  const map = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const content = useMemo(() => (current ? frameContents(current, items).sort((a, b) => (a.z || 0) - (b.z || 0)) : []), [current, items]);
  const spots = useMemo(() => (current ? hotspots(current, items) : []), [current, items]);
  useEffect(() => {
    root.current?.focus();
  }, []);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(false), 1400);
    return () => clearTimeout(timer);
  }, [hint, history]);
  const back = () => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));
  const restart = () => first && setHistory([first]);
  // Keys on the whole page: buttons that become disabled (back, restart)
  // drop the focus to the page, the keys must keep working.
  const keys = useRef({ back, restart, onClose });
  keys.current = { back, restart, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || (e.target as HTMLElement | null)?.closest?.("select, input, textarea")) return;
      if (e.key === "Escape") keys.current.onClose();
      else if (e.key === "Backspace" || e.key === "ArrowLeft") keys.current.back();
      else if (e.key === "Home") keys.current.restart();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const go = (spot: (typeof spots)[number]) => {
    if (!spot.valid) return setHint(true);
    setHistory((h) => followLink(h, spot.target, frameIds));
  };
  const title = (frame: WhiteboardItem) => frame.text || t("Rahmen", "Frame");
  const player = (
    <div
      ref={root}
      className="wb-player"
      role="dialog"
      aria-modal="true"
      aria-label={t("Prototyp", "Prototype")}
      tabIndex={-1}
    >
      <div className="wb-player-bar">
        <button type="button" onClick={back} disabled={history.length <= 1} aria-label={t("Zurück", "Back")} title={t("Zurück (←)", "Back (←)")}>
          <ArrowLeft size={18} />
        </button>
        <button type="button" onClick={restart} disabled={history.length <= 1} aria-label={t("Neu starten", "Restart")} title={t("Neu starten (Pos1)", "Restart (Home)")}>
          <ArrowCounterClockwise size={18} />
        </button>
        <strong aria-live="polite">{current ? title(current) : t("Keine Rahmen", "No frames")}</strong>
        <button type="button" className={hint ? "active" : undefined} onClick={() => setHint(true)} aria-label={t("Klickbare Stellen zeigen", "Show clickable areas")} title={t("Klickbare Stellen zeigen", "Show clickable areas")}>
          <CursorClick size={18} />
        </button>
        <button type="button" onClick={onClose} aria-label={t("Prototyp beenden", "Close prototype")} title={t("Beenden (Esc)", "Close (Esc)")}>
          <X size={18} />
        </button>
      </div>
      {current ? (
        <svg
          key={current.id}
          className={`wb-player-stage${hint ? " hint" : ""}`}
          viewBox={`${current.x} ${current.y} ${Math.max(1, current.w)} ${Math.max(1, current.h)}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={title(current)}
          onPointerDown={(e) => {
            if (!(e.target as Element).closest(".wb-hotspot")) setHint(true);
          }}
        >
          <WhiteboardDefs />
          <rect x={current.x} y={current.y} width={current.w} height={current.h} fill={current.fill && current.fill !== "transparent" ? current.fill : "#ffffff"} />
          {content.map((item) => (
            <g key={item.id} className={`wb-${item.type}`}>
              <WhiteboardShape item={{ ...item, proto: undefined }} items={map} pages={pages} />
            </g>
          ))}
          {spots.map((spot) => {
            const target = "back" in spot.target ? t("Zurück", "Back") : title(frames.find((f) => f.id === (spot.target as { frame: string }).frame) || current);
            return (
              <rect
                key={spot.id}
                className={`wb-hotspot${spot.valid ? "" : " broken"}`}
                x={spot.x}
                y={spot.y}
                width={spot.w}
                height={spot.h}
                rx={6}
                role="button"
                tabIndex={0}
                aria-label={spot.valid ? t(`Gehe zu ${target}`, `Go to ${target}`) : t("Ziel fehlt", "Target missing")}
                onClick={() => go(spot)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    go(spot);
                  }
                }}
              >
                <title>{spot.valid ? target : t("Ziel fehlt", "Target missing")}</title>
              </rect>
            );
          })}
        </svg>
      ) : (
        <p className="wb-player-empty">{t("Lege Rahmen als Bildschirme an und verknüpfe Elemente mit „Bei Klick“.", "Add frames as screens and link elements with “On click”.")}</p>
      )}
      <p className="wb-player-help" aria-hidden="true">
        {t("Klicke auf verknüpfte Elemente · ← zurück · Esc beendet", "Click linked elements · ← back · Esc closes")}
      </p>
    </div>
  );
  return typeof document === "undefined" ? null : createPortal(player, document.body);
}

// "Bei Klick → …" for the selected elements.
export function PrototypeLinkSelect({
  items,
  selected,
  onChange,
}: {
  items: WhiteboardItem[];
  selected: WhiteboardItem[];
  onChange: (link: string | undefined) => void;
}) {
  const t = useT();
  const frames = prototypeFrames(items);
  const own = new Set(selected.map((i) => i.id));
  const value = selected[0]?.proto && linkTarget(selected[0].proto) ? selected[0].proto : "";
  if (!frames.length) return null;
  return (
    <Select aria-label={t("Bei Klick", "On click")} title={t("Prototyp: wohin ein Klick führt", "Prototype: where a click leads")} value={value} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{t("Bei Klick: nichts", "On click: nothing")}</option>
      <option value="back">{t("Bei Klick → zurück", "On click → back")}</option>
      {frames
        .filter((f) => !own.has(f.id))
        .map((f) => (
          <option key={f.id} value={`frame:${f.id}`}>
            {t("Bei Klick →", "On click →")} {f.text || t("Rahmen", "Frame")}
          </option>
        ))}
    </Select>
  );
}

// Small link badges at the elements with a click link (not exported).
export function PrototypeBadges({ items, zoom }: { items: WhiteboardItem[]; zoom: number }) {
  const linked = items.filter((i) => i.proto && i.type !== "connector" && linkTarget(i.proto));
  if (!linked.length) return null;
  const r = 8 / zoom;
  return (
    <g data-ui className="wb-link-badges" pointerEvents="none">
      {linked.map((i) => (
        <g key={i.id} transform={`translate(${i.x + i.w} ${i.y})`}>
          <circle r={r} className="wb-link-badge" strokeWidth={1.5 / zoom} />
          <path d={`M ${-r * 0.35} ${r * 0.35} L ${r * 0.4} ${-r * 0.4} M ${-r * 0.1} ${-r * 0.4} H ${r * 0.4} V ${r * 0.1}`} className="wb-link-badge-arrow" strokeWidth={1.6 / zoom} fill="none" />
        </g>
      ))}
    </g>
  );
}
