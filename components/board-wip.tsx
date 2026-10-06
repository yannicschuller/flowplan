"use client";
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
            onBlur={(e) => {
              const max = Math.round(Number(e.target.value));
              if (!e.target.value) {
                if (wip[c.key]) set(c.key, null);
              } else if (max >= 1 && max <= 999 && max !== wip[c.key]?.max) set(c.key, { max, lock: wip[c.key]?.lock });
            }}
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
