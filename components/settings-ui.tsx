"use client";
// Building blocks for settings pages (workspace settings and administration):
// groups of rows with the label and its explanation on the left and the
// control on the right, a switch, a number with its unit, and a bar that
// shows how much of a limit is used.
import type { ReactNode } from "react";
import { useId } from "react";

export function SettingGroup({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="setting-group">
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions}
      </header>
      <div className="setting-rows">{children}</div>
    </section>
  );
}

export function SettingRow({ label, description, children, id, wide = false }: { label: string; description?: ReactNode; children: ReactNode; id?: string; wide?: boolean }) {
  return (
    <div className={`setting-row${wide ? " wide" : ""}`}>
      <div className="setting-text">
        {id ? <label htmlFor={id}>{label}</label> : <span className="setting-label">{label}</span>}
        {description && <small>{description}</small>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

// A switch for one setting; the row's label names it.
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span aria-hidden />
    </button>
  );
}

// A switch row: the whole text is the switch's label.
export function SwitchRow({ label, description, checked, onChange, disabled }: { label: string; description?: ReactNode; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <SettingRow label={label} description={description}>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </SettingRow>
  );
}

// A number with its unit; empty means "not set" (null).
export function NumberField({
  value,
  onChange,
  unit,
  placeholder,
  min = 0,
  max,
  label,
  required = false,
  id,
}: {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  unit?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  label: string;
  required?: boolean;
  id?: string;
}) {
  const own = useId();
  return (
    <span className="number-field">
      <input
        id={id || own}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        required={required}
        aria-label={label}
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return onChange(null);
          const n = Math.round(Number(raw));
          if (Number.isFinite(n)) onChange(Math.min(max ?? n, Math.max(min, n)));
        }}
      />
      {unit && <span aria-hidden>{unit}</span>}
    </span>
  );
}

// How much of a limit is used: "120 MB of 500 MB".
export function UsageMeter({ used, limit, label, format }: { used: number; limit: number; label: string; format: (n: number) => string }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  const level = share >= 0.95 ? "full" : share >= 0.8 ? "high" : "";
  return (
    <div className={`usage-meter ${level}`}>
      <div className="usage-meter-text">
        <span>{label}</span>
        <strong>{limit > 0 ? `${format(used)} / ${format(limit)}` : `${format(used)} · ∞`}</strong>
      </div>
      {limit > 0 && (
        <div className="usage-meter-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)}>
          <span style={{ width: `${Math.max(share * 100, used > 0 ? 2 : 0)}%` }} />
        </div>
      )}
    </div>
  );
}

// "Unsaved changes" with save and discard, shown only when something changed.
export function SaveBar({ dirty, busy, onDiscard, saveLabel, discardLabel, message }: { dirty: boolean; busy?: boolean; onDiscard: () => void; saveLabel: string; discardLabel: string; message: string }) {
  if (!dirty) return null;
  return (
    <div className="save-bar" role="region" aria-label={message}>
      <span>{message}</span>
      <button type="button" className="button" onClick={onDiscard} disabled={busy}>
        {discardLabel}
      </button>
      <button type="submit" className="button primary" disabled={busy}>
        {saveLabel}
      </button>
    </div>
  );
}
