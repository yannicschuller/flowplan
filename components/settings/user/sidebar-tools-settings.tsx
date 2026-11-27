"use client";
// Settings → Darstellung & Sprache → Seitenleiste (#589,
// lib/sidebar-tools-pref.ts): a checkbox per symbol of the sidebar's bottom
// row. Each change is saved at once (profile.sidebarTools, all devices);
// "Alle anzeigen" shows every symbol again. The row's own menu ("Leiste
// anpassen …", components/sidebar-tools.tsx) leads here.
import { Cards, GearSix, Graph, Images, Question, SquaresFour, Tag, Trash, type Icon } from "@phosphor-icons/react";
import { SIDEBAR_TOOL_IDS, setSidebarToolShown, type SidebarToolId } from "@/lib/sidebar-tools-pref";
import { saveHiddenSidebarTools, useHiddenSidebarTools } from "@/lib/sidebar-tools-pref-client";
import { useT } from "../../i18n";
import { SaveState, SettingGroup, SettingRow, useSaveState } from "../../settings-ui";
import { useUserSettings } from "../user-context";

type Say = (de: string, en: string) => string;
// The names and symbols of the row (as in components/workspace-app.tsx).
export function sidebarToolNames(t: Say): Record<SidebarToolId, { label: string; icon: Icon }> {
  return {
    templates: { label: t("Vorlagen", "Templates"), icon: SquaresFour },
    media: { label: t("Medien", "Media"), icon: Images },
    study: { label: t("Lernen", "Study"), icon: Cards },
    tags: { label: t("Tags", "Tags"), icon: Tag },
    graph: { label: t("Graph", "Graph"), icon: Graph },
    trash: { label: t("Papierkorb", "Trash"), icon: Trash },
    settings: { label: t("Einstellungen", "Settings"), icon: GearSix },
    shortcuts: { label: t("Tastenkürzel", "Keyboard shortcuts"), icon: Question },
  };
}

export function SidebarToolsSettings() {
  const t = useT();
  const { mutate } = useUserSettings();
  const hidden = useHiddenSidebarTools();
  const [status, run] = useSaveState();
  const names = sidebarToolNames(t);
  const save = (next: SidebarToolId[]) => void run(() => saveHiddenSidebarTools(next, (list) => mutate({ action: "profile.sidebarTools", hidden: list })));
  return (
    <SettingGroup id="sidebar" title={t("Seitenleiste", "Sidebar")}>
      <SettingRow
        anchor="sidebar-tools"
        wide
        label={t("Symbole unten in der Seitenleiste", "Symbols at the bottom of the sidebar")}
        description={t(
          "Was du abwählst, verschwindet aus der Leiste – oder du klickst mit der rechten Maustaste auf ein Symbol (auf Touchscreens lange drücken) und wählst „Aus Leiste ausblenden“. Du erreichst es weiter über die Schnellsuche, und „Einstellungen“ steht dann im Menü oben links und auf dem Handy unter „Mehr“. Gilt auf allen Geräten.",
          "What you untick leaves the toolbar – or right-click a symbol (long-press it on touch screens) and choose “Hide from toolbar”. It stays reachable through the quick search, and “Settings” then shows in the menu at the top left and on phones under “More”. Applies on all devices.",
        )}
      >
        <div className="sidebar-tools-choice">
          <ul role="group" aria-label={t("Symbole unten in der Seitenleiste", "Symbols at the bottom of the sidebar")}>
            {SIDEBAR_TOOL_IDS.map((id) => {
              const { label, icon: ToolIcon } = names[id];
              return (
                <li key={id}>
                  <label className="toolbar-layout-check">
                    <input type="checkbox" checked={!hidden.includes(id)} onChange={(e) => save(setSidebarToolShown(hidden, id, e.target.checked))} />
                    <ToolIcon size={18} aria-hidden />
                    <span>{label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="sidebar-tools-choice-actions">
            <SaveState status={status} />
            {hidden.length > 0 && (
              <button type="button" className="button compact" onClick={() => save([])}>
                {t("Alle anzeigen", "Show all")}
              </button>
            )}
          </div>
        </div>
      </SettingRow>
    </SettingGroup>
  );
}
