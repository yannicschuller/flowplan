"use client";
// Settings levels in the interface (#294, lib/settings-level.ts): the
// coloured mark of a setting's level, the gate that leaves out what is
// above the person's level, the switch at the top of Settings and the note
// when the search or a link leads to something above it.
//
// Settings → a section (components/settings/shell.tsx) provides the view:
// the level that applies there and the section. SettingGroup and SettingRow
// (components/settings-ui.tsx) ask useLevelGate() with their anchor; a
// block that is neither wraps itself in <SettingLevel anchor=…>. Outside
// the levelled view (the administration, dialogs) nothing is gated or marked.
import { createContext, useContext, type ReactNode } from "react";
import { anchorLevel, sectionLevel, SETTINGS_LEVELS, withinLevel, type SettingsLevel } from "@/lib/settings-level";
import type { SectionMeta } from "@/lib/settings-sections";
import { useT } from "./i18n";

type LevelView = { level: SettingsLevel; section: Pick<SectionMeta, "level" | "entries"> };
const LevelViewContext = createContext<LevelView | null>(null);
// The level of the enclosing card or block: rows without one of their own
// take it.
const ParentLevelContext = createContext<SettingsLevel | null>(null);

export function LevelViewProvider({ level, section, children }: LevelView & { children: ReactNode }) {
  return <LevelViewContext.Provider value={{ level, section }}>{children}</LevelViewContext.Provider>;
}

export type LevelGate = {
  // The level of the item (null outside the levelled view).
  level: SettingsLevel | null;
  // The level is the item's own (an explicit one or its registry entry):
  // it shows its mark.
  own: boolean;
  hidden: boolean;
};
// The level of a row, card or block: its own (`level`), else the registry
// entry with its anchor, else its card's, else the section's.
export function useLevelGate(anchor?: string, level?: SettingsLevel): LevelGate {
  const view = useContext(LevelViewContext);
  const parent = useContext(ParentLevelContext);
  if (!view) return { level: null, own: false, hidden: false };
  const own = level ?? anchorLevel(view.section, anchor);
  const resolved = own ?? parent ?? sectionLevel(view.section);
  return { level: resolved, own: !!own, hidden: !withinLevel(resolved, view.level) };
}
export function LevelScope({ level, children }: { level: SettingsLevel | null; children: ReactNode }) {
  return level ? <ParentLevelContext.Provider value={level}>{children}</ParentLevelContext.Provider> : <>{children}</>;
}

// A setting above the level leaves this behind, so a card whose rows are
// all left out disappears too (app/globals.css, .setting-rows).
export const LevelHidden = () => <span hidden data-level-hidden="" />;

// A block of a section that is not a SettingGroup or SettingRow.
export function SettingLevel({ anchor, level, children }: { anchor?: string; level?: SettingsLevel; children: ReactNode }) {
  const gate = useLevelGate(anchor, level);
  if (gate.hidden) return <LevelHidden />;
  return <LevelScope level={gate.level}>{children}</LevelScope>;
}

export function useLevelName() {
  const t = useT();
  return (level: SettingsLevel) => (level === "beginner" ? t("Einsteiger", "Beginner") : level === "expert" ? t("Experte", "Expert") : t("Normal", "Normal"));
}

// The mark: green circle (Einsteiger), yellow diamond (Normal), red
// triangle (Experte) – shape and colour, with the name as its label and
// tooltip, so it never relies on colour alone. `decorative`: the text next
// to it names the level already.
export function LevelDot({ level, decorative }: { level: SettingsLevel; decorative?: boolean }) {
  const t = useT();
  const name = useLevelName()(level);
  const label = t(`Stufe: ${name}`, `Level: ${name}`);
  if (decorative) return <span className="level-dot" data-level={level} aria-hidden />;
  return <span className="level-dot" data-level={level} role="img" aria-label={label} title={label} />;
}

// The compact switch at the top of Settings.
export function LevelSwitch({ value, onChange }: { value: SettingsLevel; onChange: (level: SettingsLevel) => void }) {
  const t = useT();
  const name = useLevelName();
  return (
    <div className="settings-level">
      <span className="settings-level-label" id="settings-level-label">
        {t("Einstellungsstufe", "Settings level")}
      </span>
      <div className="segmented settings-level-switch" role="radiogroup" aria-labelledby="settings-level-label">
        {SETTINGS_LEVELS.map((level) => (
          <label key={level} data-active={value === level}>
            <input type="radio" name="settings-level" checked={value === level} onChange={() => onChange(level)} />
            <LevelDot level={level} decorative />
            {name(level)}
          </label>
        ))}
      </div>
      <small className="settings-level-hint">
        {value === "beginner"
          ? t("Das Wichtigste für den Anfang. Die Suche findet alle Einstellungen.", "The essentials to start with. The search finds every setting.")
          : value === "normal"
            ? t("Die meisten Einstellungen, ohne die für Fortgeschrittene. Die Suche findet alle.", "Most settings, without the advanced ones. The search finds all of them.")
            : t("Alle Einstellungen, auch für Entwickler und Fortgeschrittene.", "Every setting, also those for developers and advanced use.")}
      </small>
    </div>
  );
}

// Above the section's content when the search or a link led to something
// above the level: switch the level, or show it this once.
export function LevelNotice({
  target,
  whole,
  revealed,
  onSwitch,
  onReveal,
}: {
  target: SettingsLevel;
  // The whole section is above the level (else one setting).
  whole: boolean;
  revealed: boolean;
  onSwitch: () => void;
  onReveal: () => void;
}) {
  const t = useT();
  const name = useLevelName()(target);
  return (
    <div className="level-notice" role="note" data-level={target}>
      <LevelDot level={target} decorative />
      <p>
        {revealed
          ? t(`Vorübergehend mit allen Einstellungen bis zur Stufe ${name} angezeigt.`, `Shown for now with every setting up to the ${name} level.`)
          : whole
            ? t(`Dieser Bereich gehört zur Stufe ${name}.`, `This section belongs to the ${name} level.`)
            : t(`Diese Einstellung gehört zur Stufe ${name}.`, `This setting belongs to the ${name} level.`)}
      </p>
      <div className="level-notice-actions">
        <button type="button" className="button primary" onClick={onSwitch}>
          {t(`Stufe wechseln: ${name}`, `Switch level: ${name}`)}
        </button>
        {!revealed && (
          <button type="button" className="button" onClick={onReveal}>
            {t("Trotzdem zeigen", "Show anyway")}
          </button>
        )}
      </div>
    </div>
  );
}

// Below a section's content: how many of its settings the level leaves out.
export function LevelMore({ count, onReveal }: { count: number; onReveal: () => void }) {
  const t = useT();
  if (!count) return null;
  return (
    <p className="level-more">
      {count === 1
        ? t("1 weitere Einstellung gehört zu einer höheren Stufe.", "1 more setting belongs to a higher level.")
        : t(`${count} weitere Einstellungen gehören zu höheren Stufen.`, `${count} more settings belong to higher levels.`)}{" "}
      <button type="button" className="text-button" onClick={onReveal}>
        {t("Trotzdem zeigen", "Show anyway")}
      </button>
    </p>
  );
}
