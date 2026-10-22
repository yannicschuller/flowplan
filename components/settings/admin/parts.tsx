"use client";
// Pieces the administration's sections share: the status line at the top of
// a section, and rows that save one instance setting (lib/instance-settings.ts)
// as soon as it changes, with the saving state next to the control. A form
// sends only its own fields; the others keep their stored values.
import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import type { InstanceSettings } from "@/lib/instance-settings";
import { useLocale, useT } from "../../i18n";
import { Select } from "../../select";
import { SaveState, SettingRow, StatusBadge, Switch, useSaveState, type Tone } from "../../settings-ui";
import { useAdmin } from "../admin-context";

// The state of a section in one line: badges, a sentence and – for a
// problem – the way to fix it ("SMTP nicht eingerichtet · So richtest du es ein").
export type StatusItem = { tone: Tone; label: string };
export function AdminStatus({ items, children, action }: { items: StatusItem[]; children?: ReactNode; action?: ReactNode }) {
  const t = useT();
  return (
    <div className="admin-status" role="status" aria-label={t("Zustand", "State")}>
      <div className="admin-status-badges">
        {items.map((item) => (
          <StatusBadge key={item.label} tone={item.tone}>
            {item.label}
          </StatusBadge>
        ))}
      </div>
      {children && <p>{children}</p>}
      {action && <div className="admin-status-action">{action}</div>}
    </div>
  );
}

// A link to another section (or anchor) of the administration, or outside.
export function FixLink({ href, children }: { href: string; children: ReactNode }) {
  const external = /^https?:/.test(href);
  return (
    <a className="admin-fix-link" href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
      {children}
      <ArrowRight size={14} aria-hidden />
    </a>
  );
}

// Docs pages (docs.flowplan.org) in German or English, with the heading's
// anchor in that language.
export function useDocs() {
  const lang = useLocale() === "de" ? "de" : "en";
  return (page: string, anchorDe?: string, anchorEn?: string) => `https://docs.flowplan.org/${lang}/${page}${anchorDe ? `#${lang === "de" ? anchorDe : anchorEn || anchorDe}` : ""}`;
}

// Saves a part of the instance settings, then reloads /api/admin.
export function useInstanceSettings() {
  const { data, mutate, load } = useAdmin();
  const save = async (patch: Partial<InstanceSettings>) => {
    await mutate({ action: "admin.settings", settings: patch });
    await load();
  };
  return { settings: data?.settings ?? null, save };
}

type Key<V> = {
  [K in keyof InstanceSettings]-?: InstanceSettings[K] extends V ? K : never;
}[keyof InstanceSettings];

// A switch for one instance setting; settings that are not a boolean pass
// `checked` and `patch` (backupInterval: "hourly" ↔ on).
export function InstanceSwitch({
  field,
  label,
  description,
  disabled,
  checked,
  patch,
}: {
  field: keyof InstanceSettings;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
  checked?: boolean;
  patch?: (on: boolean) => Partial<InstanceSettings>;
}) {
  const { settings, save } = useInstanceSettings();
  const [status, run] = useSaveState();
  const stored = checked ?? !!settings?.[field];
  const [shown, setShown] = useState(stored);
  useEffect(() => setShown(stored), [stored]);
  return (
    <SettingRow label={label} description={description}>
      <SaveState status={status} />
      <Switch
        checked={shown}
        label={label}
        disabled={disabled || status.state === "saving"}
        onChange={async (on) => {
          setShown(on);
          if ((await run(() => save(patch ? patch(on) : { [field]: on }))) === undefined) setShown(stored);
        }}
      />
    </SettingRow>
  );
}

// A choice for one instance setting.
export function InstanceSelect<K extends keyof InstanceSettings>({
  field,
  label,
  description,
  options,
}: {
  field: K;
  label: string;
  description?: ReactNode;
  options: { value: string; label: string }[];
}) {
  const id = useId();
  const { settings, save } = useInstanceSettings();
  const [status, run] = useSaveState();
  return (
    <SettingRow id={id} label={label} description={description}>
      <SaveState status={status} />
      <Select
        id={id}
        className="control-md"
        value={String(settings?.[field] ?? options[0].value)}
        disabled={status.state === "saving"}
        onChange={(e) => void run(() => save({ [field]: e.target.value } as Partial<InstanceSettings>))}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}

// A number for one instance setting, saved when the field is left (or with
// Enter). Empty means "not set" unless `required`; out-of-range values are
// brought into range when saving, not while typing.
export function InstanceNumber({
  field,
  label,
  description,
  unit,
  min = 0,
  max,
  placeholder,
  fallback,
}: {
  field: Key<number | null | undefined>;
  label: string;
  description?: ReactNode;
  unit?: string;
  min?: number;
  max?: number;
  placeholder?: string;
  // Used when the field is required and left empty.
  fallback?: number;
}) {
  const id = useId();
  const { settings, save } = useInstanceSettings();
  const [status, run] = useSaveState();
  const stored = (settings?.[field] as number | null | undefined) ?? null;
  return (
    <SettingRow id={id} label={label} description={description}>
      <SaveState status={status} />
      <NumberInput id={id} value={stored} unit={unit} min={min} max={max} placeholder={placeholder} fallback={fallback} onCommit={(value) => void run(() => save({ [field]: value }))} />
    </SettingRow>
  );
}

// A number field that reports its value when it is left: empty → null (or
// the fallback), otherwise clamped to min…max.
export function NumberInput({
  id,
  value,
  unit,
  min = 0,
  max,
  placeholder,
  fallback,
  label,
  onCommit,
}: {
  id?: string;
  value: number | null;
  unit?: string;
  min?: number;
  max?: number;
  placeholder?: string;
  fallback?: number;
  // Without a row label (e.g. in a table).
  label?: string;
  onCommit: (value: number | null) => void;
}) {
  const [raw, setRaw] = useState(value === null ? "" : String(value));
  useEffect(() => setRaw(value === null ? "" : String(value)), [value]);
  const commit = () => {
    const text = raw.trim();
    let next: number | null = text === "" ? (fallback ?? null) : Math.round(Number(text));
    if (next !== null && !Number.isFinite(next)) next = value;
    if (next !== null) next = Math.min(max ?? next, Math.max(min, next));
    setRaw(next === null ? "" : String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <span className="number-field">
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        aria-label={label}
        placeholder={placeholder}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      {unit && <span aria-hidden>{unit}</span>}
    </span>
  );
}

// A text for one instance setting: "Speichern" appears once it changed
// (Enter in a single-line field saves too).
export function InstanceText({
  field,
  label,
  description,
  placeholder,
  maxLength,
  multiline = false,
}: {
  field: "name" | "announcement";
  label: string;
  description?: ReactNode;
  placeholder?: string;
  maxLength: number;
  multiline?: boolean;
}) {
  const t = useT();
  const id = useId();
  const { settings, save } = useInstanceSettings();
  const [status, run] = useSaveState();
  const stored = settings?.[field] ?? "";
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);
  const dirty = draft !== stored;
  const submit = () => void run(() => save({ [field]: draft.trim() }));
  const props = {
    id,
    maxLength,
    placeholder,
    value: draft,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
  };
  return (
    <SettingRow wide={multiline} id={id} label={label} description={description}>
      <div className={`admin-text-setting${multiline ? " multiline" : ""}`}>
        {multiline ? (
          <textarea rows={3} {...props} />
        ) : (
          <input
            className="control-lg"
            {...props}
            onKeyDown={(e) => {
              if (e.key === "Enter" && dirty) {
                e.preventDefault();
                submit();
              }
            }}
          />
        )}
        {(dirty || status.state !== "idle") && (
          <span className="admin-text-actions">
            {dirty && (
              <>
                <button type="button" className="button" onClick={() => setDraft(stored)} disabled={status.state === "saving"}>
                  {t("Verwerfen", "Discard")}
                </button>
                <button type="button" className="button primary" onClick={submit} disabled={status.state === "saving"}>
                  {t("Speichern", "Save")}
                </button>
              </>
            )}
            <SaveState status={status} />
          </span>
        )}
      </div>
    </SettingRow>
  );
}
