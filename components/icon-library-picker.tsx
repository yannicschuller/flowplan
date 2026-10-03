"use client";
import { useT } from "./i18n";
import { useState } from "react";
import {
  iconColors,
  iconLibrary,
  libraryIconValue,
  parseLibraryIcon,
} from "@/lib/icon-library";
import { libraryIcons } from "./library-icons";

// Symbols from the icon library in one of ten colours.
export function IconLibraryPicker({
  current,
  onSelect,
}: {
  current: string;
  onSelect: (icon: string) => void;
}) {
  const t = useT();
  const selected = parseLibraryIcon(current);
  const [color, setColor] = useState<string>(
    selected?.color || iconColors[1][1],
  );
  const [query, setQuery] = useState("");
  const term = query.trim().toLocaleLowerCase("de");
  const names = Object.keys(iconLibrary).filter(
    (name) =>
      !term ||
      name.toLowerCase().includes(term) ||
      iconLibrary[name].includes(term),
  );
  return (
    <div className="icon-library">
      <input
        type="search"
        aria-label={t("Symbole durchsuchen", "Search icons")}
        placeholder={t("Symbol suchen, z. B. Ziel, Team, Kalender …", "Search icon, e.g. target, team, calendar …")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="icon-colors" role="radiogroup" aria-label={t("Symbolfarbe", "Icon colour")}>
        {iconColors.map(([label, value]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={color === value}
            aria-label={t(`Farbe ${label}`, `Colour ${label}`)}
            className="icon-color"
            style={{ background: value }}
            onClick={() => setColor(value)}
          />
        ))}
      </div>
      <div className="icon-grid" role="listbox" aria-label={t("Symbole", "Icons")}>
        {names.map((name) => {
          const Symbol = libraryIcons[name];
          const value = libraryIconValue(name, color);
          return (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={current === value}
              aria-label={t(`Symbol ${name}`, `Icon ${name}`)}
              title={iconLibrary[name]}
              onClick={() => onSelect(value)}
            >
              <Symbol size={22} color={color} weight="duotone" />
            </button>
          );
        })}
        {!names.length && <p className="muted">{t("Kein Symbol gefunden.", "No icon found.")}</p>}
      </div>
    </div>
  );
}
