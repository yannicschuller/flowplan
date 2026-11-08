"use client";
// The node palette (docs/specs/workflows.md §10.2): categories, a search,
// and the node types – dragged onto the canvas or clicked (appended behind
// the selected node and connected). The same list serves as the command
// list of "A" (append) and of "+" on a connection.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { NODE_CATEGORIES, isTrigger } from "@/lib/workflows/catalog";
import { CATEGORY_TEXT, PALETTE, useStableT } from "./model";
import { NodeIcon } from "./node-icon";

export const DRAG_TYPE = "application/x-flowplan-node";

export function Palette({ onPick, autoFocus = false, triggers = true, compact = false }: { onPick: (type: string) => void; autoFocus?: boolean; triggers?: boolean; compact?: boolean }) {
  const t = useStableT();
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const list = useId();
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (autoFocus) search.current?.focus();
  }, [autoFocus]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return NODE_CATEGORIES.map((c) => ({
      category: c,
      items: PALETTE.filter((s) => s.category === c && (triggers || !isTrigger(s.type))).filter(
        (s) => !q || `${t(s.name[0], s.name[1])} ${t(s.description[0], s.description[1])} ${s.name.join(" ")}`.toLowerCase().includes(q),
      ),
    })).filter((g) => g.items.length);
  }, [query, t, triggers]);
  const flat = groups.flatMap((g) => g.items);
  useEffect(() => setActive(0), [query]);
  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((a) => Math.min(flat.length - 1, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Enter" && flat[active]) onPick(flat[active].type);
    else return;
    e.preventDefault();
  };
  return (
    <div className={`wf-palette${compact ? " compact" : ""}`}>
      <input
        ref={search}
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls={list}
        aria-activedescendant={flat[active] ? `${list}-${flat[active].type}` : undefined}
        aria-label={t("Knoten suchen", "Search nodes")}
        placeholder={t("Knoten suchen …", "Search nodes …")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={key}
      />
      <div id={list} role="listbox" aria-label={t("Knoten", "Nodes")} className="wf-palette-list">
        {groups.map((g) => (
          <div role="group" key={g.category} aria-label={t(CATEGORY_TEXT[g.category][0], CATEGORY_TEXT[g.category][1])}>
            <div className="wf-palette-cat" aria-hidden>
              {t(CATEGORY_TEXT[g.category][0], CATEGORY_TEXT[g.category][1])}
            </div>
            {g.items.map((s) => {
              const i = flat.indexOf(s);
              return (
                <div
                  key={s.type}
                  id={`${list}-${s.type}`}
                  role="option"
                  aria-selected={i === active}
                  className={`wf-palette-item${i === active ? " active" : ""}`}
                  title={t(s.description[0], s.description[1])}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, s.type);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(s.type)}
                  onMouseEnter={() => setActive(i)}
                >
                  <NodeIcon type={s.type} size={16} />
                  <span>{t(s.name[0], s.name[1])}</span>
                </div>
              );
            })}
          </div>
        ))}
        {!flat.length && <p className="muted wf-picker-empty">{t("Kein Knoten passt.", "No node matches.")}</p>}
      </div>
    </div>
  );
}
