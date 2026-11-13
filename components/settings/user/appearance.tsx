"use client";
// Settings → Darstellung & Sprache: language (profile, all devices),
// light or dark (this device), the workspace's look or Flowplan's own (#196,
// profile, all devices), the page icon above or next to the title (#214,
// profile, all devices), the arrow after links to the web (#217, profile,
// all devices), the related pages and backlinks below pages
// and records (this device), what "> " creates in the editor (#230,
// profile, all devices), the editor's block handles and code blocks
// and draw.io's theme
// and interface (this device),
// keyboard shortcuts, the introduction and "Neuigkeiten nach Updates" with
// "Was ist neu" (#223, profile, all devices).
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { CircleHalf, Gift, Keyboard, Moon, Sun } from "@phosphor-icons/react";
import { LANGUAGES, LOCALES, isLocale } from "@/lib/i18n";
import { clearLocale, setLocale, useT } from "../../i18n";
import { Select } from "../../select";
import { CONTROL, SaveState, SettingGroup, SettingRow, Switch, SwitchRow, useSaveState } from "../../settings-ui";
import { setLineNumbersByDefault, useLineNumbersByDefault } from "@/lib/code-block-prefs";
import { setBlockHandlesAlways, useBlockHandlesAlways } from "@/lib/block-handle-prefs";
import { setDiscoveryPanelsShown, useDiscoveryPanelsShown } from "@/lib/discovery-panels-prefs";
import { useUserSettings } from "../user-context";
import { setDrawioPref, useDrawioPrefs } from "@/lib/drawio-prefs";
import { DRAWIO_UIS, type DrawioUi } from "@/lib/drawio";
import type { TextMenuPref } from "@/lib/text-menu-pref";
import { setTextMenuPrefLocal, textMenuPref, useTextMenuPref } from "@/lib/text-menu-pref-client";
import type { PageIconPref } from "@/lib/page-icon-pref";
import { pageIconPref, setPageIconPrefLocal, usePageIconPref } from "@/lib/page-icon-pref-client";
import { externalLinkIcon, setExternalLinkIconLocal, useExternalLinkIcon } from "@/lib/external-link-icon-pref-client";
import type { QuoteShortcutPref } from "@/lib/quote-shortcut-pref";
import { quoteShortcut, setQuoteShortcutLocal, useQuoteShortcut } from "@/lib/quote-shortcut-pref-client";
import type { FormattingToolbarPref } from "@/lib/toolbar-pref";
import { formattingToolbar, setFormattingToolbarLocal, useFormattingToolbar } from "@/lib/toolbar-pref-client";
import type { UpdateNotesLevel } from "@/lib/update-notes-pref";
import { openWhatsNew, setUpdateNotesLevelLocal, updateNotesLevel, useUpdateNotesLevel } from "@/lib/update-notes-client";

export default function AppearanceSection() {
  const t = useT();
  const keyHints = useKeyboardHints();
  const { boot, mutate, theme, setTheme } = useUserSettings();
  const [status, run] = useSaveState();
  const [lookStatus, runLook] = useSaveState();
  const lineNumbers = useLineNumbersByDefault();
  const handlesAlways = useBlockHandlesAlways();
  const discoveryPanels = useDiscoveryPanelsShown();
  const drawio = useDrawioPrefs();
  const textMenu = useTextMenuPref();
  const [textMenuStatus, runTextMenu] = useSaveState();
  const chooseTextMenu = (value: TextMenuPref) => {
    const before = textMenuPref();
    setTextMenuPrefLocal(value);
    void runTextMenu(async () => {
      try {
        await mutate({ action: "profile.textMenu", textMenu: value });
      } catch (e) {
        setTextMenuPrefLocal(before);
        throw e;
      }
    });
  };
  const pageIcon = usePageIconPref();
  const [pageIconStatus, runPageIcon] = useSaveState();
  const choosePageIcon = (value: PageIconPref) => {
    const before = pageIconPref();
    setPageIconPrefLocal(value);
    void runPageIcon(async () => {
      try {
        await mutate({ action: "profile.pageIcon", pageIcon: value });
      } catch (e) {
        setPageIconPrefLocal(before);
        throw e;
      }
    });
  };
  const linkIcon = useExternalLinkIcon();
  const [linkIconStatus, runLinkIcon] = useSaveState();
  const chooseLinkIcon = (on: boolean) => {
    const before = externalLinkIcon();
    setExternalLinkIconLocal(on);
    void runLinkIcon(async () => {
      try {
        await mutate({ action: "profile.externalLinkIcon", externalLinkIcon: on });
      } catch (e) {
        setExternalLinkIconLocal(before);
        throw e;
      }
    });
  };
  const quoteMarker = useQuoteShortcut();
  const [quoteStatus, runQuote] = useSaveState();
  const chooseQuoteMarker = (value: QuoteShortcutPref) => {
    const before = quoteShortcut();
    setQuoteShortcutLocal(value);
    void runQuote(async () => {
      try {
        await mutate({ action: "profile.quoteShortcut", quoteShortcut: value });
      } catch (e) {
        setQuoteShortcutLocal(before);
        throw e;
      }
    });
  };
  const toolbar = useFormattingToolbar();
  const [toolbarStatus, runToolbar] = useSaveState();
  const chooseToolbar = (value: FormattingToolbarPref) => {
    const before = formattingToolbar();
    setFormattingToolbarLocal(value);
    void runToolbar(async () => {
      try {
        await mutate({ action: "profile.formattingToolbar", formattingToolbar: value });
      } catch (e) {
        setFormattingToolbarLocal(before);
        throw e;
      }
    });
  };
  const notesLevel = useUpdateNotesLevel();
  const [notesStatus, runNotes] = useSaveState();
  const chooseNotesLevel = (value: UpdateNotesLevel) => {
    const before = updateNotesLevel();
    setUpdateNotesLevelLocal(value);
    void runNotes(async () => {
      try {
        await mutate({ action: "profile.updateNotes", level: value });
      } catch (e) {
        setUpdateNotesLevelLocal(before);
        throw e;
      }
    });
  };
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
        <SettingRow
          anchor="workspace-look"
          label={t("Darstellung des Arbeitsbereichs verwenden", "Use the workspace's appearance")}
          description={t(
            "Akzentfarbe, Hintergrund und Schriften, die Eigentümer für ihren Arbeitsbereich gewählt haben. Aus: Flowplans eigene Darstellung in allen Arbeitsbereichen. Gilt auf allen Geräten.",
            "The accent colour, background and typefaces owners chose for their workspace. Off: Flowplan's own look in every workspace. Applies on all devices.",
          )}
        >
          <SaveState status={lookStatus} />
          <Switch
            checked={!boot.plainLook}
            label={t("Darstellung des Arbeitsbereichs verwenden", "Use the workspace's appearance")}
            onChange={(on) => void runLook(async () => await mutate({ action: "profile.plainLook", plain: !on }))}
          />
        </SettingRow>
        <SettingRow
          anchor="page-icon"
          label={t("Seitensymbol", "Page icon")}
          description={t(
            "Groß über dem Titel oder klein neben dem Titel in seiner ersten Zeile – weniger Platz über dem Text. Ein Cover bleibt darüber. Nur deine Ansicht: Titel und Symbol der Seite ändern sich nicht. Gilt auf allen Geräten.",
            "Large above the title or small next to the title on its first line – less space above the text. A cover stays above it. Only how you see pages: the page's title and icon do not change. Applies on all devices.",
          )}
        >
          <SaveState status={pageIconStatus} />
          <div className="segmented" role="radiogroup" aria-label={t("Seitensymbol", "Page icon")}>
            {(
              [
                ["above", t("Über dem Titel", "Above the title")],
                ["inline", t("Neben dem Titel", "Next to the title")],
              ] as const
            ).map(([value, label]) => (
              <label key={value} data-active={pageIcon === value}>
                <input type="radio" name="page-icon" checked={pageIcon === value} onChange={() => choosePageIcon(value)} /> {label}
              </label>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          anchor="external-link-icon"
          label={t("Symbol bei externen Links", "Icon on external links")}
          description={t(
            "Ein kleiner Pfeil hinter Links ins Web, in Seiten, Einträgen und Kommentaren. Aus: Links bleiben farbig und unterstrichen. Veröffentlichte Seiten zeigen den Pfeil weiter, gedruckt wird er nie. Gilt auf allen Geräten.",
            "A small arrow after links to the web, in pages, records and comments. Off: links stay coloured and underlined. Published pages keep showing the arrow; it is never printed. Applies on all devices.",
          )}
        >
          <SaveState status={linkIconStatus} />
          <Switch checked={linkIcon} label={t("Symbol bei externen Links", "Icon on external links")} onChange={chooseLinkIcon} />
        </SettingRow>
        <SwitchRow
          label={t("Verwandte Seiten und Rückverweise anzeigen", "Show related pages and backlinks")}
          description={t(
            "Unter Seiten und Einträgen: Verwandte Seiten, „Verlinkt von“, „Verknüpft von“ und nicht verlinkte Erwähnungen. Nur auf diesem Gerät.",
            "Below pages and records: Related pages, Linked from and Unlinked mentions. On this device only.",
          )}
          checked={discoveryPanels}
          onChange={setDiscoveryPanelsShown}
        />
      </SettingGroup>
      <SettingGroup id="editor" title={t("Editor", "Editor")}>
        <SettingRow
          anchor="text-menu"
          label={t("Menü bei Textauswahl", "Menu on text selection")}
          description={t(
            "Das Menü mit Reaktionen, Formatierung und Kommentieren über markiertem Text. Nur am Computer: beim Markieren mit Maus, Trackpad oder Tastatur, nicht mit dem Finger. Ein Rechtsklick öffnet es immer. Gilt auf allen Geräten.",
            "The menu with reactions, formatting and comments above selected text. Only on a computer: when selecting with a mouse, trackpad or keyboard, not with a finger. A right click always opens it. Applies on all devices.",
          )}
        >
          <SaveState status={textMenuStatus} />
          <div className="segmented" role="radiogroup" aria-label={t("Menü bei Textauswahl", "Menu on text selection")}>
            {(
              [
                ["always", t("Immer", "Always")],
                ["computer", t("Nur am Computer", "Only on a computer")],
                ["never", t("Nie", "Never")],
              ] as const
            ).map(([value, label]) => (
              <label key={value} data-active={textMenu === value}>
                <input type="radio" name="text-menu" checked={textMenu === value} onChange={() => chooseTextMenu(value)} /> {label}
              </label>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          anchor="formatting-toolbar"
          label={t("Formatierungsleiste", "Formatting toolbar")}
          description={t(
            "Die feste Leiste über dem Text von Seiten und Einträgen. Ausgeblendet bietet das Menü über markiertem Text alle Formatierungen, wie im Fokusmodus. Auf dem Handy bleibt die Leiste über der Tastatur. Gilt auf allen Geräten.",
            "The fixed bar above the text of pages and records. Hidden, the menu above selected text offers all formatting, as in focus mode. On a phone the bar above the keyboard stays. Applies on all devices.",
          )}
        >
          <SaveState status={toolbarStatus} />
          <div className="segmented" role="radiogroup" aria-label={t("Formatierungsleiste", "Formatting toolbar")}>
            {(
              [
                ["show", t("Anzeigen", "Show")],
                ["hide", t("Ausblenden", "Hide")],
              ] as const
            ).map(([value, label]) => (
              <label key={value} data-active={toolbar === value}>
                <input type="radio" name="formatting-toolbar" checked={toolbar === value} onChange={() => chooseToolbar(value)} /> {label}
              </label>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          anchor="quote-shortcut"
          label={t("„>“ erzeugt", "“>” creates")}
          description={t(
            "Was „>“ und ein Leerzeichen am Anfang einer leeren Zeile erzeugen. Ein Zitat bekommst du immer mit „\"“ und einem Leerzeichen; eingefügtes und importiertes Markdown „> Text“ bleibt ein Zitat. Gilt auf allen Geräten.",
            "What “>” and a space at the start of an empty line create. A quote is always “\"” and a space; pasted and imported Markdown “> text” stays a quote. Applies on all devices.",
          )}
        >
          <SaveState status={quoteStatus} />
          <div className="segmented" role="radiogroup" aria-label={t("„>“ erzeugt", "“>” creates")}>
            {(
              [
                ["toggle", t("Aufklappbaren Block", "Toggle")],
                ["quote", t("Zitat", "Quote")],
              ] as const
            ).map(([value, label]) => (
              <label key={value} data-active={quoteMarker === value}>
                <input type="radio" name="quote-shortcut" checked={quoteMarker === value} onChange={() => chooseQuoteMarker(value)} /> {label}
              </label>
            ))}
          </div>
        </SettingRow>
        <SwitchRow
          label={t("Griffe immer anzeigen", "Always show block handles")}
          description={t(
            "Den Griff ⠿ neben jedem Block zeigen, nicht nur am Block unter dem Mauszeiger und am Block mit dem Cursor. Nur auf diesem Gerät.",
            "Show the ⠿ handle next to every block, not only at the block under the pointer and the block with the caret. On this device only.",
          )}
          checked={handlesAlways}
          onChange={setBlockHandlesAlways}
        />
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
        <SettingRow
          anchor="update-notes"
          label={t("Neuigkeiten nach Updates", "What’s new after updates")}
          description={t(
            "Nach einem Update von Flowplan einmal zeigen, was sich geändert hat. Nur Breaking Changes: nur wenn sich etwas so ändert, dass du dich darauf einstellen musst. Gilt auf allen Geräten.",
            "After Flowplan was updated, show once what changed. Only breaking changes: only when something changes in a way you need to adapt to. Applies on all devices.",
          )}
        >
          <SaveState status={notesStatus} />
          <div className="segmented" role="radiogroup" aria-label={t("Neuigkeiten nach Updates", "What’s new after updates")}>
            {(
              [
                ["all", t("Alle anzeigen", "Show all")],
                ["breaking", t("Nur Breaking Changes", "Only breaking changes")],
                ["never", t("Nie", "Never")],
              ] as const
            ).map(([value, label]) => (
              <label key={value} data-active={notesLevel === value}>
                <input type="radio" name="update-notes" checked={notesLevel === value} onChange={() => chooseNotesLevel(value)} /> {label}
              </label>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          anchor="whats-new"
          label={t("Was ist neu", "What’s new")}
          description={t("Die Versionshinweise der letzten Versionen, unabhängig von der Einstellung darüber.", "The release notes of the latest versions, whatever the setting above.")}
        >
          <button type="button" className="button" onClick={openWhatsNew}>
            <Gift size={16} aria-hidden="true" />
            {t("Was ist neu anzeigen", "Show what’s new")}
          </button>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
