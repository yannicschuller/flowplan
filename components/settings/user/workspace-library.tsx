"use client";
// Settings → Arbeitsbereich → Allgemein → Bibliothek (#564,
// lib/workspace-navigation.ts): the whole workspace as a library – every
// space shown as shelves of books, the spaces' own choice kept – and the
// sidebar's places the workspace does without. Owners change it, members
// see what applies. Switching the library on asks which places to hide,
// My tasks and the journal ticked.
import { useState } from "react";
import { LIBRARY_SUGGESTED_HIDDEN, NO_NAVIGATION, WORKSPACE_PLACES, type WorkspaceNavigation, type WorkspacePlace } from "@/lib/workspace-navigation";
import { useT } from "../../i18n";
import { SaveState, SettingGroup, SettingRow, Switch, SwitchRow, useSaveState } from "../../settings-ui";
import { Modal } from "../../ui";
import { useUserSettings } from "../user-context";

type T = (de: string, en: string) => string;
export function placeTexts(t: T): Record<WorkspacePlace, { label: string; description: string }> {
  return {
    tasks: { label: t("Meine Aufgaben", "My tasks"), description: t("Der Eintrag in der Seitenleiste, der Befehl in der Schnellsuche und das Widget „Aufgaben“ mit meinen Aufgaben.", "The sidebar entry, the quick search command and the “Tasks” widget with my tasks.") },
    journal: { label: t("Journal", "Journal"), description: t("„Journal: Heute“ in der Schnellsuche, sein Tastenkürzel und das Widget. Journale im Seitenbaum bleiben.", "“Journal: Today” in the quick search, its shortcut and the widget. Journals in the page tree stay.") },
    study: { label: t("Lernen", "Study"), description: t("„Lernen“ in der Seitenleiste, die Lernbefehle der Schnellsuche, das Tastenkürzel und das Widget.", "“Study” in the sidebar, the study commands of the quick search, the shortcut and the widget.") },
    graph: { label: t("Graph", "Graph"), description: t("„Graph“ in der Seitenleiste und „Graph der Verlinkungen“ in der Schnellsuche.", "“Graph” in the sidebar and “Graph of links” in the quick search.") },
  };
}

export function WorkspaceLibrarySettings() {
  const t = useT();
  const { boot, owner, mutate, reload } = useUserSettings();
  const stored: WorkspaceNavigation = boot.navigation ?? NO_NAVIGATION;
  // Shown at once, the server's answer follows with the reload.
  const [local, setLocal] = useState<WorkspaceNavigation | null>(null);
  const nav = local ?? stored;
  const [status, run] = useSaveState();
  // Switching on: the places to hide with it, ticked as suggested.
  const [asking, setAsking] = useState<WorkspacePlace[] | null>(null);
  const texts = placeTexts(t);
  const save = (next: WorkspaceNavigation) => {
    setLocal(next);
    void run(async () => {
      try {
        await mutate({ action: "workspace.update", workspaceId: boot.workspace.id, library: next.library, hidden: next.hidden });
        await reload();
      } finally {
        setLocal(null);
      }
    });
  };
  const toggleLibrary = (on: boolean) => {
    if (on) setAsking(WORKSPACE_PLACES.filter((p) => nav.hidden.includes(p) || LIBRARY_SUGGESTED_HIDDEN.includes(p)));
    else save({ ...nav, library: false });
  };
  const label = t("Arbeitsbereich als Bibliothek", "Workspace as library");
  return (
    <SettingGroup
      id="library"
      title={t("Bibliothek", "Library")}
      description={
        owner
          ? t(
              "Für ein Handbuch oder eine Wissensbasis: Alle Bereiche erscheinen als Regale mit Büchern, und was nicht passt, blendest du für alle Mitglieder aus. Es wird nichts gelöscht, Links öffnen weiter.",
              "For a handbook or a knowledge base: every space appears as shelves of books, and you hide what doesn’t fit for every member. Nothing is deleted, links still open.",
            )
          : t("Nur Eigentümer des Arbeitsbereichs ändern das. So gilt es für alle Mitglieder.", "Only workspace owners change this. This is how it applies to every member.")
      }
    >
      <SettingRow
        label={label}
        anchor="library-mode"
        description={t(
          "Jeder Bereich erscheint als Bibliothek – auch Bereiche, die später dazukommen. Die Einstellung „Als Bibliothek anzeigen“ der Bereiche bleibt: Ausgeschaltet zeigt jeder Bereich sich wieder wie zuvor.",
          "Every space appears as a library – also spaces added later. The spaces’ own “Show as library” stays: switched off, each space shows as it did before.",
        )}
      >
        <SaveState status={status} />
        <Switch checked={nav.library} onChange={toggleLibrary} label={label} disabled={!owner || status.state === "saving"} />
      </SettingRow>
      <p className="setting-note ws-library-places" id="library-places">
        {t("In der Seitenleiste ausblenden – für alle Mitglieder:", "Hide in the sidebar – for every member:")}
      </p>
      {WORKSPACE_PLACES.map((place) => (
        <SwitchRow
          key={place}
          label={texts[place].label}
          description={texts[place].description}
          checked={nav.hidden.includes(place)}
          disabled={!owner || status.state === "saving"}
          onChange={(hide) => save({ ...nav, hidden: hide ? WORKSPACE_PLACES.filter((p) => p === place || nav.hidden.includes(p)) : nav.hidden.filter((p) => p !== place) })}
        />
      ))}
      {asking && (
        <Modal open title={label} onClose={() => setAsking(null)}>
          <form
            className="ws-library-confirm"
            onSubmit={(e) => {
              e.preventDefault();
              save({ library: true, hidden: asking });
              setAsking(null);
            }}
          >
            <p>
              {t(
                "Alle Bereiche erscheinen als Regale, ihre Seiten oben als Bücher. Was soll für alle Mitglieder aus der Seitenleiste verschwinden?",
                "Every space appears as shelves, its top pages as books. What should disappear from the sidebar for every member?",
              )}
            </p>
            <fieldset>
              <legend className="sr-only">{t("In der Seitenleiste ausblenden", "Hide in the sidebar")}</legend>
              {WORKSPACE_PLACES.map((place) => (
                <label key={place} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={asking.includes(place)}
                    onChange={(e) => setAsking((list) => (list ? WORKSPACE_PLACES.filter((p) => (p === place ? e.target.checked : list.includes(p))) : list))}
                  />
                  <span>
                    {texts[place].label}
                    <small>{texts[place].description}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="muted">{t("Du kannst das jederzeit hier ändern.", "You can change this here at any time.")}</p>
            <div className="modal-actions">
              <button type="button" className="button" onClick={() => setAsking(null)}>
                {t("Abbrechen", "Cancel")}
              </button>
              <button className="button primary">{t("Einschalten", "Switch on")}</button>
            </div>
          </form>
        </Modal>
      )}
    </SettingGroup>
  );
}
