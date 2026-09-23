"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { spaceColors } from "@/lib/space-appearance";
import { PageIcon } from "./ui";
const EmojiPicker = dynamic(() => import("./emoji-picker"), {
  loading: () => <p>Emojis werden geladen …</p>,
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
  const [open, setOpen] = useState(false);
  return (
    <fieldset className="space-appearance" disabled={disabled}>
      <legend>Bereichssymbol</legend>
      <div className="space-appearance-controls">
        <button
          type="button"
          className="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <SpaceIcon icon={icon} color={color} /> Symbol auswählen
        </button>
        <label>
          Hintergrundfarbe
          <select
            value={color}
            onChange={(event) => onChange(icon, event.target.value)}
          >
            {spaceColors.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
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
