"use client";
import { useEffect, useRef } from "react";
import { useT } from "./i18n";
import type { View } from "@/lib/types";

type Limits = NonNullable<View["wip"]>;

// Work-in-progress limits per board column: a number marks the column when
// it holds more; "lock" refuses further records.
export function BoardWipSettings({
  columns,
  wip,
  disabled,
  onChange,
}: {
  columns: { key: string; label: string }[];
  wip: Limits;
  disabled: boolean;
  onChange: (wip: Limits | undefined) => void;
}) {
  const t = useT();
  const set = (key: string, next: { max: number; lock?: boolean } | null) => {
    const all = { ...wip };
    if (next) all[key] = next;
    else delete all[key];
    onChange(Object.keys(all).length ? all : undefined);
  };
  // Typed limits not saved yet. Enter and leaving the field save them; when
  // the panel closes while a field still has focus (it unmounts without a
  // blur), the pending values are saved on unmount (#131).
  const drafts = useRef(new Map<string, string>());
  const latest = useRef({ wip, onChange });
  useEffect(() => {
    latest.current = { wip, onChange };
  });
  const commit = useRef((only?: string) => {
    const { wip, onChange } = latest.current;
    const all = { ...wip };
    let changed = false;
    for (const [key, value] of drafts.current) {
      if (only !== undefined && key !== only) continue;
      drafts.current.delete(key);
      const max = Math.round(Number(value));
      if (!value.trim()) {
        if (all[key]) {
          delete all[key];
          changed = true;
        }
      } else if (max >= 1 && max <= 999 && max !== all[key]?.max) {
        all[key] = { max, lock: all[key]?.lock };
        changed = true;
      }
    }
    if (changed) onChange(Object.keys(all).length ? all : undefined);
  }).current;
  useEffect(() => () => commit(), [commit]);
  return (
    <fieldset className="board-wip">
      <legend>{t("WIP-Limits", "WIP limits")}</legend>
      <p className="muted">{t("Höchstzahl je Spalte; leer heißt ohne Limit.", "Maximum per column; empty means no limit.")}</p>
      {columns.map((c) => (
        <div className="board-wip-row" key={c.key}>
          <span>{c.label}</span>
          <input
            type="number"
            min={1}
            max={999}
            inputMode="numeric"
            aria-label={t(`Limit für ${c.label}`, `Limit for ${c.label}`)}
            disabled={disabled}
            defaultValue={wip[c.key]?.max ?? ""}
            onChange={(e) => drafts.current.set(c.key, e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              commit(c.key);
            }}
            onBlur={() => commit(c.key)}
          />
          <label className="checkbox-label">
            <input
              type="checkbox"
              disabled={disabled || !wip[c.key]}
              checked={!!wip[c.key]?.lock}
              onChange={(e) => wip[c.key] && set(c.key, { ...wip[c.key], lock: e.target.checked || undefined })}
            />
            {t("sperren", "lock")}
          </label>
        </div>
      ))}
    </fieldset>
  );
}

// "3/3" in a column header, marked when over the limit.
export function WipCount({ count, limit }: { count: number; limit?: { max: number; lock?: boolean } }) {
  const t = useT();
  if (!limit) return <span className="muted">{count}</span>;
  const over = count > limit.max,
    full = count >= limit.max;
  return (
    <span
      className={`wip-count${over ? " over" : full ? " full" : ""}`}
      title={
        over
          ? t(`Mehr als ${limit.max} – über dem WIP-Limit`, `More than ${limit.max} – over the WIP limit`)
          : limit.lock && full
            ? t("Voll: weitere Einträge werden abgelehnt", "Full: further records are refused")
            : t(`WIP-Limit ${limit.max}`, `WIP limit ${limit.max}`)
      }
    >
      {count}/{limit.max}
      {limit.lock && full ? " 🔒" : ""}
    </span>
  );
}
