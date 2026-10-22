"use client";
// Settings → Darstellung & Sprache: language (profile, all devices),
// light or dark (this device), keyboard shortcuts and the introduction.
import { CircleHalf, Keyboard, Moon, Sun } from "@phosphor-icons/react";
import { LANGUAGES, LOCALES, isLocale } from "@/lib/i18n";
import { clearLocale, setLocale, useT } from "../../i18n";
import { Select } from "../../select";
import { SettingGroup, SettingRow } from "../../settings-ui";
import { useUserSettings } from "../user-context";

export default function AppearanceSection() {
  const t = useT();
  const { boot, mutate, onError, theme, setTheme } = useUserSettings();
  return (
    <>
      <SettingGroup title={t("Sprache und Erscheinungsbild", "Language and appearance")}>
        <SettingRow label={t("Sprache", "Language")} description={t("Gilt auf allen Geräten, auch für E-Mails und Push-Hinweise.", "Applies on all devices, also to e-mails and push notifications.")}>
          <Select
            className="language-select"
            name="profile-language"
            aria-label={t("Sprache", "Language")}
            value={boot.language ?? ""}
            onChange={async (e) => {
              const value = isLocale(e.target.value) ? e.target.value : null;
              try {
                await mutate({ action: "profile.language", language: value });
                if (value) setLocale(value);
                else clearLocale();
              } catch (err) {
                onError((err as Error).message);
              }
            }}
          >
            <option value="">{`🌐 ${t("Automatisch (folgt dem Browser)", "Automatic (follows the browser)")}`}</option>
            {LOCALES.map((l) => (
              <option key={l} value={l} lang={l}>{`${LANGUAGES[l].flag} ${LANGUAGES[l].name}`}</option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          label={t("Erscheinungsbild", "Appearance")}
          description={t("Automatisch folgt dem Hell- oder Dunkelmodus des Geräts. Nur auf diesem Gerät.", "Automatic follows the device's light or dark mode. On this device only.")}
        >
          <div className="segmented" role="radiogroup" aria-label={t("Erscheinungsbild", "Appearance")}>
            <label data-active={theme === "system"}>
              <input type="radio" name="profile-theme" checked={theme === "system"} onChange={() => setTheme("system")} />
              <CircleHalf size={15} aria-hidden /> {t("Automatisch", "Automatic")}
            </label>
            <label data-active={theme === "light"}>
              <input type="radio" name="profile-theme" checked={theme === "light"} onChange={() => setTheme("light")} />
              <Sun size={15} aria-hidden /> {t("Hell", "Light")}
            </label>
            <label data-active={theme === "dark"}>
              <input type="radio" name="profile-theme" checked={theme === "dark"} onChange={() => setTheme("dark")} />
              <Moon size={15} aria-hidden /> {t("Dunkel", "Dark")}
            </label>
          </div>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title={t("Hilfe", "Help")}>
        <SettingRow
          label={t("Alle Tastenkürzel", "All keyboard shortcuts")}
          description={t("Die Übersicht öffnet sich überall mit ? oder ⌘ / Ctrl + /.", "The overview opens anywhere with ? or ⌘ / Ctrl + /.")}
        >
          <button type="button" className="button" onClick={() => window.dispatchEvent(new Event("flowplan:shortcuts"))}>
            <Keyboard size={16} aria-hidden="true" />
            {t("Tastenkürzel anzeigen", "Show keyboard shortcuts")}
          </button>
        </SettingRow>
        <SettingRow label={t("Einführung ansehen", "Show introduction")} description={t("Die kurze Tour durch Flowplan und die ersten Einstellungen, wie nach dem Anlegen des Kontos.", "The short tour of Flowplan and the first settings, as after creating your account.")}>
          <button type="button" className="button" onClick={() => window.dispatchEvent(new Event("flowplan:onboarding"))}>
            {t("Einführung starten", "Start introduction")}
          </button>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
