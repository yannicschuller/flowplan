"use client";
// Settings → Darstellung & Sprache: language (profile, all devices),
// light or dark (this device), keyboard shortcuts and the introduction.
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { CircleHalf, Keyboard, Moon, Sun } from "@phosphor-icons/react";
import { LANGUAGES, LOCALES, isLocale } from "@/lib/i18n";
import { clearLocale, setLocale, useT } from "../../i18n";
import { Select } from "../../select";
import { CONTROL, SaveState, SettingGroup, SettingRow, useSaveState } from "../../settings-ui";
import { useUserSettings } from "../user-context";

export default function AppearanceSection() {
  const t = useT();
  const keyHints = useKeyboardHints();
  const { boot, mutate, theme, setTheme } = useUserSettings();
  const [status, run] = useSaveState();
  return (
    <>
      <SettingGroup id="language" title={t("Sprache und Erscheinungsbild", "Language and appearance")}>
        <SettingRow label={t("Sprache", "Language")} description={t("Gilt auf allen Geräten, auch für E-Mails und Push-Hinweise.", "Applies on all devices, also to e-mails and push notifications.")}>
          <SaveState status={status} />
          <Select
            className={`language-select ${CONTROL.md}`}
            name="profile-language"
            aria-label={t("Sprache", "Language")}
            value={boot.language ?? ""}
            onChange={(e) => {
              const value = isLocale(e.target.value) ? e.target.value : null;
              void run(async () => {
                await mutate({ action: "profile.language", language: value });
                if (value) setLocale(value);
                else clearLocale();
              });
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
      <SettingGroup id="help" title={t("Hilfe", "Help")}>
        <SettingRow
          label={t("Alle Tastenkürzel", "All keyboard shortcuts")}
          description={
            keyHints.visible
              ? t(`Die Übersicht öffnet sich überall mit ? oder ${keyHints.keys("Mod+/")}.`, `The overview opens anywhere with ? or ${keyHints.keys("Mod+/")}.`)
              : t("Für eine angeschlossene Tastatur.", "For an attached keyboard.")
          }
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
