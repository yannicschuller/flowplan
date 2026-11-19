"use client";
// Light or dark on published and shared pages (#393): one button cycling
// Automatic (the system's) → Light → Dark, kept per device like the app's
// setting (lib/theme.ts, localStorage "flowplan-theme" – the script in
// <head> applies it before the first paint on every page).
import { useEffect, useState } from "react";
import { CircleHalf, Moon, Sun } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { setThemeChoice, themeChoice, watchTheme, type ThemeChoice } from "@/lib/theme";

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };

export function PublicThemeToggle() {
  const t = useT();
  // "system" until hydrated: the server does not know the device's choice.
  const [choice, setChoice] = useState<ThemeChoice>("system");
  useEffect(() => {
    setChoice(themeChoice());
    return watchTheme((_dark, next) => setChoice(next));
  }, []);
  const label = {
    system: t("Farbschema: automatisch (wie das System) – wechseln zu hell", "Colour scheme: automatic (like the system) – switch to light"),
    light: t("Farbschema: hell – wechseln zu dunkel", "Colour scheme: light – switch to dark"),
    dark: t("Farbschema: dunkel – wechseln zu automatisch", "Colour scheme: dark – switch to automatic"),
  }[choice];
  const Icon = choice === "light" ? Sun : choice === "dark" ? Moon : CircleHalf;
  return (
    <button
      type="button"
      className="icon-button public-theme-toggle"
      aria-label={label}
      title={label}
      data-choice={choice}
      onClick={() => {
        const next = NEXT[choice];
        setThemeChoice(next);
        setChoice(next);
      }}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  );
}
