"use client";
// Building blocks of the tool panels (components/ink/ink-panel.tsx and the
// shape tool's sections in components/ink/shape-panel.tsx): segmented radio
// buttons, the slider, section heads and setting rows with a switch.
import { useRef } from "react";
import { Switch } from "../settings-ui";

// Radio buttons in a row (role radiogroup): one tab stop, arrow keys move.
// `iconOnly`: the icons alone show, the names stay for screen readers and
// as tooltips (choices whose names would not fit in every language).
export function Segmented<V extends string | number>({
  label,
  value,
  options,
  onChange,
  className = "",
  iconOnly = false,
}: {
  label: string;
  value: V | null;
  options: { value: V; label: string; icon?: React.ReactNode }[];
  onChange: (value: V) => void;
  className?: string;
  iconOnly?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = options.findIndex((o) => o.value === value);
  const onKey = (event: React.KeyboardEvent, index: number) => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div className={`ink-segmented ${className}`} role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={i === chosen}
          tabIndex={i === chosen || (chosen < 0 && i === 0) ? 0 : -1}
          className={i === chosen ? "active" : ""}
          title={iconOnly ? o.label : undefined}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.icon}
          <span className={iconOnly ? "sr-only" : undefined}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

// A slider on a square-root scale (fine widths get more room), with dots
// where the presets are. Native range input: keys, VoiceOver, Pencil.
export function InkSlider({
  label,
  value,
  min,
  max,
  onChange,
  valueText,
  ticks = [],
  lo,
  hi,
  linear = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  valueText: string;
  ticks?: number[];
  lo: React.ReactNode;
  hi: React.ReactNode;
  linear?: boolean;
}) {
  const STEPS = 1000;
  const toPos = (v: number) => {
    const f = Math.min(1, Math.max(0, (v - min) / (max - min)));
    return linear ? f : Math.sqrt(f);
  };
  const fromPos = (p: number) => min + (max - min) * (linear ? p : p * p);
  const pos = toPos(value);
  return (
    <div className="ink-slider">
      <span className="ink-slider-end" aria-hidden="true">
        {lo}
      </span>
      <div className="ink-slider-track" style={{ "--p": pos } as React.CSSProperties}>
        {ticks.map((tick) => (
          <span key={tick} className="ink-slider-tick" style={{ "--t": toPos(tick) } as React.CSSProperties} aria-hidden="true" />
        ))}
        <input
          type="range"
          min={0}
          max={STEPS}
          step={1}
          value={Math.round(pos * STEPS)}
          aria-label={label}
          aria-valuetext={valueText}
          onChange={(e) => onChange(fromPos(Number(e.target.value) / STEPS))}
        />
      </div>
      <span className="ink-slider-end" aria-hidden="true">
        {hi}
      </span>
    </div>
  );
}

export function SectionHead({ id, label, value }: { id?: string; label: string; value?: string }) {
  return (
    <div className="ink-panel-sec-head">
      <span id={id}>{label}</span>
      {value && <output className="ink-panel-pill">{value}</output>}
    </div>
  );
}

export function SettingSwitch({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="ink-panel-setting">
      <span className="ink-panel-setting-title">{title}</span>
      <span className="ink-panel-setting-desc">{description}</span>
      <Switch checked={checked} onChange={onChange} label={title} />
    </div>
  );
}
