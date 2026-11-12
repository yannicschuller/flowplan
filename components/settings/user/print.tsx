"use client";
// Settings → Persönlich → Drucken / PDF and Settings → Arbeitsbereich →
// Druckvorlagen (#215, lib/print-options.ts): named sets of print options
// the print dialog offers. A person's own presets; the workspace's, which
// owners define for everyone (members use them, the dialog marks them).
import { useT } from "../../i18n";
import { SettingGroup } from "../../settings-ui";
import { useUserSettings } from "../user-context";
import { PresetManager, savePresets } from "../../print-dialog";
import type { PrintPreset, WorkspacePrintPresets } from "@/lib/print-options";

export function PrintSection() {
  const t = useT();
  const { boot, mutate, onError, onRefresh } = useUserSettings();
  const mine = boot.print?.presets ?? [];
  const shared = boot.printPresets ?? { presets: [], defaultId: null };
  const save = async (presets: PrintPreset[]) => {
    try {
      await savePresets(mutate, boot.workspace.id, "user", presets);
      await onRefresh();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    }
  };
  return (
    <>
      <SettingGroup
        id="print-presets"
        title={t("Meine Druckvorlagen", "My print presets")}
        description={t(
          "Benannte Einstellungen für „Drucken / PDF“: was auf dem Papier steht (Titelbild, Icon, Tags, Eigenschaften, Seitenzahlen) und wie es aussieht. Du wählst sie im Druckdialog; deine letzte Auswahl merkt sich Flowplan.",
          "Named settings for “Print / PDF”: what is on the paper (cover image, icon, tags, properties, page numbers) and how it looks. You pick them in the print dialog; Flowplan remembers your last choice.",
        )}
      >
        <div className="setting-row wide">
          <PresetManager presets={mine} editable scope="user" onSave={(presets) => save(presets)} emptyText={t("Noch keine eigenen Druckvorlagen. Du kannst sie auch im Druckdialog speichern.", "No print presets of your own yet. You can also save them in the print dialog.")} />
        </div>
      </SettingGroup>
      {shared.presets.length > 0 && (
        <SettingGroup id="print-presets-workspace" title={t("Druckvorlagen des Arbeitsbereichs", "The workspace's print presets")} description={t("Für alle im Arbeitsbereich; Eigentümer ändern sie unter Arbeitsbereich → Druckvorlagen.", "For everyone in the workspace; owners change them under Workspace → Print presets.")}>
          <div className="setting-row wide">
            <PresetManager presets={shared.presets} defaultId={shared.defaultId} editable={false} scope="workspace" onSave={async () => false} emptyText="" />
          </div>
        </SettingGroup>
      )}
    </>
  );
}

export function WorkspacePrintSection() {
  const t = useT();
  const { boot, owner, mutate, onError, onRefresh } = useUserSettings();
  const shared: WorkspacePrintPresets = boot.printPresets ?? { presets: [], defaultId: null };
  const canEdit = owner && !boot.workspace.guest;
  const save = async (presets: PrintPreset[], defaultId: string | null) => {
    try {
      await savePresets(mutate, boot.workspace.id, "workspace", presets, defaultId);
      await onRefresh();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    }
  };
  return (
    <SettingGroup
      id="workspace-print-presets"
      title={t("Druckvorlagen", "Print presets")}
      description={
        canEdit
          ? t(
              "Vorlagen für „Drucken / PDF“, die alle im Arbeitsbereich wählen können, z. B. „Intern“ und „Sauber für extern“. Die Standardvorlage (Stern) nimmt der Druckdialog für alle, die noch nichts gewählt haben.",
              "Presets for “Print / PDF” that everyone in the workspace can pick, e.g. “Internal” and “Clean for external”. The default preset (star) is what the print dialog starts with for everyone who has not chosen yet.",
            )
          : t("Alle im Arbeitsbereich können sie im Druckdialog wählen; nur Eigentümer ändern sie.", "Everyone in the workspace can pick them in the print dialog; only owners change them.")
      }
    >
      <div className="setting-row wide">
        <PresetManager presets={shared.presets} defaultId={shared.defaultId} editable={canEdit} scope="workspace" onSave={save} emptyText={t("Noch keine Druckvorlagen für den Arbeitsbereich.", "No print presets for the workspace yet.")} />
      </div>
    </SettingGroup>
  );
}
