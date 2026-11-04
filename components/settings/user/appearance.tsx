"use client";
// Settings → Darstellung & Sprache: language (profile, all devices),
// light or dark (this device), the editor's code blocks and draw.io's theme
// and interface (this device),
// keyboard shortcuts and the introduction.
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { CircleHalf, Keyboard, Moon, Sun } from "@phosphor-icons/react";
import { LANGUAGES, LOCALES, isLocale } from "@/lib/i18n";
import { clearLocale, setLocale, useT } from "../../i18n";
import { Select } from "../../select";
import { CONTROL, SaveState, SettingGroup, SettingRow, SwitchRow, useSaveState } from "../../settings-ui";
import { setLineNumbersByDefault, useLineNumbersByDefault } from "@/lib/code-block-prefs";
import { useUserSettings } from "../user-context";
import { setDrawioPref, useDrawioPrefs } from "@/lib/drawio-prefs";
import { DRAWIO_UIS, type DrawioUi } from "@/lib/drawio";

export default function AppearanceSection() {
  const t = useT();
  const keyHints = useKeyboardHints();
  const { boot, mutate, theme, setTheme } = useUserSettings();
  const [status, run] = useSaveState();
  const lineNumbers = useLineNumbersByDefault();
  const drawio = useDrawioPrefs();
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
      <SettingGroup id="editor" title={t("Editor", "Editor")}>
        <SwitchRow
          label={t("Zeilennummern standardmäßig anzeigen", "Show line numbers by default")}
          description={t(
            "Für Codeblöcke ohne eigene Einstellung, beim Bearbeiten und Lesen. Nur auf diesem Gerät.",
            "For code blocks without a setting of their own, when editing and reading. On this device only.",
          )}
          checked={lineNumbers}
          onChange={setLineNumbersByDefault}
        />
        <SettingRow
          label={t("draw.io-Design", "draw.io theme")}
          description={t(
            "Hell oder dunkel beim Bearbeiten von draw.io-Diagrammen; Automatisch folgt Flowplan. Nur auf diesem Gerät.",
            "Light or dark when editing draw.io diagrams; Automatic follows Flowplan. On this device only.",
          )}
        >
          <div className="segmented" role="radiogroup" aria-label={t("draw.io-Design", "draw.io theme")}>
            {(
              [
                ["auto", t("Automatisch", "Automatic")],
                ["light", t("Hell", "Light")],
                ["dark", t("Dunkel", "Dark")],
              ] as const
            ).map(([value, label]) => (
              <label key={value} data-active={drawio.theme === value}>
                <input type="radio" name="drawio-theme" checked={drawio.theme === value} onChange={() => setDrawioPref("theme", value)} /> {label}
              </label>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          label={t("draw.io-Oberfläche", "draw.io interface")}
          description={t("Wie draw.io beim Bearbeiten aussieht. Nur auf diesem Gerät.", "How draw.io looks while editing. On this device only.")}
        >
          <Select
            className={CONTROL.md}
            name="drawio-ui"
            aria-label={t("draw.io-Oberfläche", "draw.io interface")}
            value={drawio.ui}
            onChange={(e) => setDrawioPref("ui", DRAWIO_UIS.includes(e.target.value as DrawioUi) ? (e.target.value as DrawioUi) : "kennedy")}
          >
            <option value="kennedy">{t("Standard (Kennedy)", "Standard (Kennedy)")}</option>
            <option value="min">{t("Minimal", "Minimal")}</option>
            <option value="sketch">{t("Skizze (Sketch)", "Sketch")}</option>
          </Select>
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
