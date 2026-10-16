// Light and dark: "Automatic" (the default) follows the system's setting and
// changes with it, "Light" and "Dark" stay. Chosen per device
// (Settings → General → Appearance). THEME_SCRIPT runs in <head> of every
// page, so the right colours are there before the first paint.
export type ThemeChoice = "system" | "light" | "dark";
export const THEME_KEY = "flowplan-theme";
const SYSTEM_DARK = "(prefers-color-scheme: dark)";

export function themeChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export const systemDark = () => typeof matchMedia === "function" && matchMedia(SYSTEM_DARK).matches;
export const isDark = (choice: ThemeChoice) => choice === "dark" || (choice === "system" && systemDark());

// Sets the page's colours; returns whether they are dark.
export function applyTheme(choice: ThemeChoice = themeChoice()) {
  const dark = isDark(choice);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  return dark;
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {}
  return applyTheme(choice);
}

// Follows the system while "Automatic" is chosen, and other tabs' choices.
export function watchTheme(onChange: (dark: boolean, choice: ThemeChoice) => void) {
  const media = typeof matchMedia === "function" ? matchMedia(SYSTEM_DARK) : null;
  const update = () => {
    const choice = themeChoice();
    onChange(applyTheme(choice), choice);
  };
  const system = () => {
    if (themeChoice() === "system") update();
  };
  const storage = (event: StorageEvent) => {
    if (event.key === THEME_KEY || event.key === null) update();
  };
  media?.addEventListener("change", system);
  window.addEventListener("storage", storage);
  return () => {
    media?.removeEventListener("change", system);
    window.removeEventListener("storage", storage);
  };
}

// Before the first paint (app/layout.tsx); the same rule as isDark(). It
// also follows later changes of the device and of other tabs, so pages
// without the app (sign-in, shared pages, forms) change along.
export const THEME_SCRIPT = `(function(){function a(){try{var c=localStorage.getItem(${JSON.stringify(THEME_KEY)});var d=c==="dark"||(c!=="light"&&window.matchMedia&&matchMedia(${JSON.stringify(SYSTEM_DARK)}).matches);document.documentElement.dataset.theme=d?"dark":"light"}catch(e){}}a();try{matchMedia(${JSON.stringify(SYSTEM_DARK)}).addEventListener("change",a);addEventListener("storage",a)}catch(e){}})()`;
