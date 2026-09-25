"use client";
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
        aria-label="Symbole durchsuchen"
        placeholder="Symbol suchen, z. B. Ziel, Team, Kalender …"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="icon-colors" role="radiogroup" aria-label="Symbolfarbe">
        {iconColors.map(([label, value]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={color === value}
            aria-label={`Farbe ${label}`}
            className="icon-color"
            style={{ background: value }}
            onClick={() => setColor(value)}
          />
        ))}
      </div>
      <div className="icon-grid" role="listbox" aria-label="Symbole">
        {names.map((name) => {
          const Symbol = libraryIcons[name];
          const value = libraryIconValue(name, color);
          return (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={current === value}
              aria-label={`Symbol ${name}`}
              title={iconLibrary[name]}
              onClick={() => onSelect(value)}
            >
              <Symbol size={22} color={color} weight="duotone" />
            </button>
          );
        })}
        {!names.length && <p className="muted">Kein Symbol gefunden.</p>}
      </div>
    </div>
  );
}
