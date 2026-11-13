"use client";
import { tr } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { Select } from "./select";
import dynamic from "next/dynamic";
import { loadView } from "@/components/view-fallback";
import { useRef, useState } from "react";
import { ImageSquare, Trash } from "@phosphor-icons/react";
import { DEFAULT_SPACE_ICON, spaceColors, spaceImage } from "@/lib/space-appearance";
import { PageIcon } from "./ui";
import { squareImage } from "./workspace-icon";
const EmojiPicker = dynamic(() => loadView(() => import("./emoji-picker")), {
  loading: () => <p>{tr("Emojis werden geladen …", "Loading emojis …")}</p>,
});
export function SpaceIcon({
  icon,
  color = "none",
}: {
  icon: string;
  color?: string;
}) {
  // An uploaded image (#251) fills the square; the colour does not show.
  if (spaceImage(icon))
    return (
      <span className="space-icon has-image" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={icon} alt="" />
      </span>
    );
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
  const [open, setOpen] = useState(false),
    [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  return (
    <fieldset className="space-appearance" disabled={disabled}>
      <legend>{t("Bereichssymbol", "Space icon")}</legend>
      <div className="space-appearance-controls">
        <div className="space-appearance-buttons">
          <button
            type="button"
            className="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <SpaceIcon icon={icon} color={color} /> {t("Symbol auswählen", "Choose icon")}
          </button>
          <button type="button" className="button" onClick={() => file.current?.click()}>
            <ImageSquare size={16} /> {t("Bild hochladen", "Upload image")}
          </button>
          {icon !== DEFAULT_SPACE_ICON && (
            <button
              type="button"
              className="button"
              onClick={() => {
                setError("");
                onChange(DEFAULT_SPACE_ICON, color);
              }}
            >
              <Trash size={16} /> {t("Entfernen", "Remove")}
            </button>
          )}
        </div>
        <input
          ref={file}
          type="file"
          hidden
          aria-label={t("Bild für den Bereich", "Image for the space")}
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={async (event) => {
            const chosen = event.target.files?.[0];
            event.target.value = "";
            if (!chosen) return;
            setError("");
            try {
              onChange(await squareImage(chosen), color);
              setOpen(false);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
        {!spaceImage(icon) && (
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
        )}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {open && (
        <EmojiPicker
          selected={spaceImage(icon) ? undefined : icon}
          onSelect={async (value) => {
            setError("");
            onChange(value, color);
            setOpen(false);
          }}
        />
      )}
    </fieldset>
  );
}
