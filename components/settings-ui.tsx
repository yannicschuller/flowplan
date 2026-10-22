"use client";
// Building blocks for the settings and the administration
// (docs/settings-architecture.md): a card of rows with the label and its
// explanation on the left and the control on the right (stacked on phones),
// fixed control widths, a switch, a number with its unit, a usage bar,
// status badges, the inline saving state, a danger zone, an empty state and
// a table that becomes a list on phones. Panels use these instead of their
// own layout CSS.
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CheckCircle, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { useT } from "./i18n";

// A card: a titled group of setting rows. `id` makes it a target of the
// search and of addresses like #settings/account/passkeys.
export function SettingGroup({
  title,
  description,
  children,
  actions,
  id,
  tone,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  id?: string;
  tone?: "danger";
}) {
  return (
    <section className={`setting-group${tone === "danger" ? " danger-zone" : ""}`} id={id} aria-labelledby={id ? `${id}-title` : undefined}>
      <header>
        <div>
          <h2 id={id ? `${id}-title` : undefined}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="setting-group-actions">{actions}</div>}
      </header>
      <div className="setting-rows">{children}</div>
    </section>
  );
}

// The red card at the end of a section for what cannot be undone.
export function DangerZone({ title, description, children, id }: { title?: string; description?: ReactNode; children: ReactNode; id?: string }) {
  const t = useT();
  return (
    <SettingGroup tone="danger" id={id} title={title || t("Gefahrenzone", "Danger zone")} description={description}>
      {children}
    </SettingGroup>
  );
}

// One setting: label and explanation left, control right. With `id` the
// label belongs to the control of that id; `wide` puts the control under
// the text (text areas, lists). `anchor` gives the row itself an id: a
// target of the search and of #settings/<section>/<anchor>.
export function SettingRow({ label, description, children, id, wide = false, anchor }: { label: string; description?: ReactNode; children: ReactNode; id?: string; wide?: boolean; anchor?: string }) {
  return (
    <div className={`setting-row${wide ? " wide" : ""}`} id={anchor}>
      <div className="setting-text">
        {id ? <label htmlFor={id}>{label}</label> : <span className="setting-label">{label}</span>}
        {description && <small>{description}</small>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

// The three widths a control in a row may have; on phones every control
// takes the full width. Use as className on inputs and selects.
export const CONTROL = { sm: "control-sm", md: "control-md", lg: "control-lg" } as const;

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

// ok · warn · error · off · info. The dot and the text carry the meaning
// together, never the colour alone.
export type Tone = "ok" | "warn" | "error" | "off" | "info";
export function StatusBadge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`status-badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

// The saving state of a setting that saves on change, shown next to it:
// "Speichert …", "Gespeichert", or the error. `useSaveState().run(fn)`
// wraps the request; the "saved" note fades after a few seconds.
export type SaveStatus = { state: "idle" | "saving" | "saved" | "error"; error?: string };
export function useSaveState(): [SaveStatus, <T>(fn: () => Promise<T>) => Promise<T | undefined>] {
  const [status, setStatus] = useState<SaveStatus>({ state: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = useCallback(async <T,>(fn: () => Promise<T>) => {
    clearTimeout(timer.current);
    setStatus({ state: "saving" });
    try {
      const result = await fn();
      setStatus({ state: "saved" });
      timer.current = setTimeout(() => setStatus({ state: "idle" }), 3000);
      return result;
    } catch (e) {
      setStatus({ state: "error", error: (e as Error).message });
      return undefined;
    }
  }, []);
  return [status, run];
}
export function SaveState({ status }: { status: SaveStatus }) {
  const t = useT();
  return (
    <span className={`save-state ${status.state}`} role="status" aria-live="polite">
      {status.state === "saving" && (
        <>
          <CircleNotch size={14} aria-hidden className="spin" />
          {t("Speichert …", "Saving …")}
        </>
      )}
      {status.state === "saved" && (
        <>
          <CheckCircle size={14} aria-hidden />
          {t("Gespeichert", "Saved")}
        </>
      )}
      {status.state === "error" && (
        <>
          <WarningCircle size={14} aria-hidden />
          {status.error || t("Nicht gespeichert", "Not saved")}
        </>
      )}
    </span>
  );
}

// Nothing there yet: an icon, one sentence and, if it helps, the action.
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="settings-empty">
      {icon && <span className="settings-empty-icon" aria-hidden>{icon}</span>}
      <div>
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}

// A table on wide screens, a list of cards on phones: the `primary` column
// is the card's title, the others follow with their header as label.
export type Column<T> = { key: string; header: string; render: (row: T) => ReactNode; align?: "end"; primary?: boolean; hideOnPhone?: boolean };
export function ResponsiveTable<T>({ label, columns, rows, rowKey, empty }: { label: string; columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; empty?: ReactNode }) {
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <table className="responsive-table" aria-label={label}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} scope="col" className={c.align === "end" ? "end" : undefined}>
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((c) => (
              <td key={c.key} data-label={c.primary ? undefined : c.header} className={[c.primary ? "primary" : "", c.align === "end" ? "end" : "", c.hideOnPhone ? "hide-phone" : ""].filter(Boolean).join(" ") || undefined}>
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
