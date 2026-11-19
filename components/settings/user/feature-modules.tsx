"use client";
// Settings → Darstellung & Sprache → Funktionen (#378, lib/feature-modules.ts):
// a switch per feature; off takes its entry points out of the interface,
// never what exists. The same list sets the instance's default in
// Administration → Instanz (components/settings/admin/modules-default.tsx).
import { FEATURE_MODULES, type FeatureModule } from "@/lib/feature-modules";
import { saveFeatureModules, useFeatureModules } from "@/lib/feature-modules-client";
import { useT } from "../../i18n";
import { SaveState, SettingGroup, SettingRow, SwitchRow, useSaveState } from "../../settings-ui";
import { useUserSettings } from "../user-context";

type T = (de: string, en: string) => string;
export function moduleTexts(t: T): Record<FeatureModule, { label: string; description: string }> {
  return {
    flashcards: {
      label: t("Lernkarten", "Flashcards"),
      description: t("Die Datenbankart „Lernkarten“, die Ansicht „Lernen“, „Lernen“ in der Seitenleiste, Lücken im Editor und das Widget.", "The database kind “Flashcards”, the view “Study”, “Study” in the sidebar, clozes in the editor and the widget."),
    },
    whiteboards: { label: t("Whiteboards", "Whiteboards"), description: t("Neue Whiteboards und „/whiteboard“ in Seiten.", "New whiteboards and “/whiteboard” in pages.") },
    notebooks: { label: t("Notizbücher", "Notebooks"), description: t("Neue Notizbücher für Handschrift und PDFs.", "New notebooks for handwriting and PDFs.") },
    journal: { label: t("Journal", "Journal"), description: t("Neue Journale, „Journal: Heute“ in der Schnellsuche und das Widget.", "New journals, “Journal: Today” in the quick search and the widget.") },
    dashboards: { label: t("Dashboards", "Dashboards"), description: t("Neue Dashboards und der Block „Dashboard“.", "New dashboards and the “Dashboard” block.") },
    workflows: { label: t("Workflows", "Workflows"), description: t("Neue Workflows und der Workflow-Knopf in Seiten.", "New workflows and the workflow button in pages.") },
    drawio: { label: t("draw.io", "draw.io"), description: t("Der Block „draw.io-Diagramm“.", "The “draw.io diagram” block.") },
    ai: { label: t("KI", "AI"), description: t("Alle Einstiege in die KI: Assistent, „KI fragen“, Zusammenfassungen, mit KI erstellen.", "Every way into the AI: assistant, “Ask AI”, summaries, create with AI.") },
    views: {
      label: t("Weitere Ansichten", "More view types"),
      description: t("Board, Kalender, Zeitleiste, Galerie, Diagramm, Feed und Sprints beim Hinzufügen einer Ansicht. Tabelle und Liste bleiben immer.", "Board, calendar, timeline, gallery, chart, feed and sprints when adding a view. Table and list always stay."),
    },
    forms: { label: t("Formulare", "Forms"), description: t("Die Ansicht „Formular“ mit Umfragen.", "The view “Form” with surveys.") },
    meetings: { label: t("Besprechungen", "Meetings"), description: t("Der Block „Besprechung“ und „Besprechungsnotiz anlegen“ im Journal.", "The “Meeting” block and “Create meeting note” in the journal.") },
  };
}

// One switch per feature: on = shown.
export function ModuleSwitches({ hidden, onChange, disabled }: { hidden: readonly FeatureModule[]; onChange: (next: FeatureModule[]) => void; disabled?: boolean }) {
  const t = useT();
  const texts = moduleTexts(t);
  return (
    <>
      {FEATURE_MODULES.map((module) => (
        <SwitchRow
          key={module}
          label={texts[module].label}
          description={texts[module].description}
          checked={!hidden.includes(module)}
          disabled={disabled}
          onChange={(on) => onChange(on ? hidden.filter((m) => m !== module) : [...hidden, module])}
        />
      ))}
    </>
  );
}

export function FeatureModulesSettings() {
  const t = useT();
  const { mutate } = useUserSettings();
  const state = useFeatureModules();
  const [status, run] = useSaveState();
  const save = (hidden: FeatureModule[] | null) => void run(() => saveFeatureModules(mutate, hidden));
  return (
    <SettingGroup
      id="modules"
      title={t("Funktionen", "Features")}
      description={t(
        "Was du nicht brauchst, blendest du hier aus – aus „Neue Seite“, dem „/“-Menü, der Seitenleiste, der Schnellsuche, den Widgets und den Ansichten. Vorhandenes bleibt: Seiten dieser Art, auch von anderen, siehst und öffnest du weiter über Links, die Seitenleiste und die Suche. Gilt auf allen Geräten.",
        "Hide what you don’t need – from “New page”, the “/” menu, the sidebar, the quick search, the widgets and the views. What exists stays: pages of that kind, also other people’s, still show and open from links, the sidebar and the search. Applies on all devices.",
      )}
    >
      <SettingRow
        label={state.own ? t("Deine Auswahl", "Your choice") : t("Standard der Instanz", "Instance default")}
        description={
          state.own
            ? t("Du hast selbst gewählt. „Standard“ übernimmt wieder, was die Administration für neue Konten vorgibt.", "You chose yourself. “Default” goes back to what the administration sets for new accounts.")
            : t("Die Administration gibt diese Auswahl für neue Konten vor. Sobald du etwas umschaltest, gilt deine eigene.", "The administration sets this choice for new accounts. Once you switch something, your own applies.")
        }
      >
        <SaveState status={status} />
        {state.own && (
          <button type="button" className="button compact" onClick={() => save(null)}>
            {t("Standard", "Default")}
          </button>
        )}
      </SettingRow>
      <ModuleSwitches hidden={state.hidden} onChange={save} />
    </SettingGroup>
  );
}
