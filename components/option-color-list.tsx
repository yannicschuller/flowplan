"use client";
// Property settings of a select or multi-select (#242): every option as its
// chip; a click opens the colours. "Assign colours automatically" colours
// all options in turn (the caller offers "Undo").
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { CaretDown, Palette } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { colorLabel } from "./settings/user/tags";
import { safeCollisionPadding } from "./safe-area";
import { OPTION_COLORS, choiceChipClass, type OptionColor } from "@/lib/option-colors";

export function OptionColorList({
  options,
  colors,
  disabled,
  onChange,
  onAuto,
}: {
  options: string[];
  // The colours as they will be stored (new options with their coming one).
  colors: Record<string, OptionColor> | undefined;
  disabled?: boolean;
  onChange: (option: string, color: OptionColor) => void;
  onAuto: () => void;
}) {
  const t = useT();
  if (!options.length) return null;
  const field = { type: "select" as const, optionColors: colors };
  return (
    <div className="option-colors" role="group" aria-labelledby="option-colors-label">
      <div className="option-colors-head">
        <span id="option-colors-label">{t("Farben der Optionen", "Option colours")}</span>
        <button type="button" className="text-button" disabled={disabled} onClick={onAuto}>
          <Palette size={14} aria-hidden />
          {t("Farben automatisch vergeben", "Assign colours automatically")}
        </button>
      </div>
      <ul className="option-colors-list">
        {options.map((option) => {
          const current = colors?.[option];
          return (
            <li key={option}>
              <Dropdown.Root modal={false}>
                <Dropdown.Trigger asChild disabled={disabled}>
                  <button
                    type="button"
                    className="option-color-button"
                    aria-label={`${t(`Farbe von ${option}`, `Colour of ${option}`)}: ${current ? colorLabel(current, t) : t("Standard", "Default")}`}
                  >
                    <span className={choiceChipClass(field, option)}>{option}</span>
                    <CaretDown size={11} aria-hidden />
                  </button>
                </Dropdown.Trigger>
                <Dropdown.Portal>
                  <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown" align="start" sideOffset={4}>
                    <Dropdown.RadioGroup value={current || ""} onValueChange={(value) => onChange(option, value as OptionColor)}>
                      {OPTION_COLORS.map((color) => (
                        <Dropdown.RadioItem key={color} value={color} className="dropdown-item">
                          <span className={`option-swatch opt-${color}`} aria-hidden />
                          {colorLabel(color, t)}
                        </Dropdown.RadioItem>
                      ))}
                    </Dropdown.RadioGroup>
                  </Dropdown.Content>
                </Dropdown.Portal>
              </Dropdown.Root>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
