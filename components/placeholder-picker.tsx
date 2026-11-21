"use client";
// The placeholder picker's list (#413): a search field and a list box –
// arrows, Enter, Esc – shared by the workflow editor (components/workflow/
// template-input.tsx) and the database rules (components/rule-text-
// input.tsx). Its looks are the .wf-picker rules in app/globals.css. Inside
// a dialog it is a layer (data-layer): Escape closes the list, not the
// dialog (components/layer-host.ts).
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "./i18n";

export type PickerItem = {
  id: string;
  group: string;
  label: string;
  // What it puts into the text.
  stored: string;
  // Small text after the label (a type), a sample in monospace, and the
  // indent below a parent (0–2).
  detail?: string;
  example?: string;
  depth?: number;
};

export function PickerList({
  items,
  query,
  onQuery,
  onPick,
  onClose,
  empty,
  hint,
  className = "",
}: {
  items: PickerItem[];
  query: string;
  onQuery: (query: string) => void;
  onPick: (stored: string) => void;
  onClose: () => void;
  empty: string;
  hint?: string;
  className?: string;
}) {
  const t = useT();
  const [active, setActive] = useState(0);
  const list = useId();
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => search.current?.focus(), []);
  useEffect(() => setActive(0), [query]);
  // A block, not an arrow's value: newer Chromium (Electron 45, Chrome 156)
  // returns a Promise from scrollIntoView, and an effect's return value is
  // its cleanup – React called the Promise when the picker closed (#182).
  useEffect(() => {
    document.getElementById(`${list}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, list]);
  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((a) => Math.min(items.length - 1, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Enter" && items[active]) onPick(items[active].stored);
    else if (e.key === "Escape") onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  let group = "";
  return (
    <div className={`wf-picker ${className}`.trim()} role="dialog" aria-label={t("Platzhalter wählen", "Choose a placeholder")} data-layer="">
      <input
        ref={search}
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls={list}
        aria-activedescendant={items[active] ? `${list}-${active}` : undefined}
        aria-label={t("Platzhalter suchen", "Search placeholders")}
        placeholder={t("Suchen …", "Search …")}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={key}
      />
      <ul id={list} role="listbox" aria-label={t("Platzhalter", "Placeholders")}>
        {items.map((item, i) => {
          const head = item.group !== group;
          group = item.group;
          const depth = Math.min(2, item.depth || 0);
          return (
            <li key={item.id} role="presentation">
              {head && (
                <div className="wf-picker-group" aria-hidden>
                  {item.group}
                </div>
              )}
              <div
                id={`${list}-${i}`}
                role="option"
                aria-selected={i === active}
                className={[i === active ? "active" : "", depth ? `wf-picker-depth-${depth}` : ""].filter(Boolean).join(" ")}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(item.stored)}
              >
                <span className="wf-picker-label">{item.label}</span>
                {item.detail && <span className="wf-picker-type">{item.detail}</span>}
                {item.example && <span className="wf-picker-example">{item.example}</span>}
                <span className="sr-only">{` – ${item.group}`}</span>
              </div>
            </li>
          );
        })}
        {!items.length && (
          <li role="presentation" className="muted wf-picker-empty">
            {empty}
          </li>
        )}
      </ul>
      {hint && <p className="wf-picker-hint muted">{hint}</p>}
    </div>
  );
}
