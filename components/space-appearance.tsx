"use client";
import { tr } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { Select } from "./select";
import dynamic from "next/dynamic";
import { useState } from "react";
import { spaceColors } from "@/lib/space-appearance";
import { PageIcon } from "./ui";
const EmojiPicker = dynamic(() => import("./emoji-picker"), {
  loading: () => <p>{tr("Emojis werden geladen …", "Loading emojis …")}</p>,
});
export function SpaceIcon({
  icon,
  color = "none",
}: {
  icon: string;
  color?: string;
}) {
  return (
    <span
      className={`space-icon space-color-${spaceColors.some(([value]) => value === color) ? color : "none"}`}
      aria-hidden="true"
    >
      <PageIcon name={icon} size={17} />
    </span>
  );
}
export function SpaceAppearance({
  icon,
  color,
  onChange,
  disabled = false,
}: {
  icon: string;
  color: string;
  onChange: (icon: string, color: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <fieldset className="space-appearance" disabled={disabled}>
      <legend>{t("Bereichssymbol", "Space icon")}</legend>
      <div className="space-appearance-controls">
        <button
          type="button"
          className="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <SpaceIcon icon={icon} color={color} /> {t("Symbol auswählen", "Choose icon")}
        </button>
        <label>
          {t("Hintergrundfarbe", "Background colour")}
          <Select
            value={color}
            onChange={(event) => onChange(icon, event.target.value)}
          >
            {spaceColors.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {open && (
        <EmojiPicker
          selected={icon}
          onSelect={async (value) => {
            onChange(value, color);
            setOpen(false);
          }}
        />
      )}
    </fieldset>
  );
}
