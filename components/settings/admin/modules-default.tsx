"use client";
// "Funktionen für neue Konten" in Administration → Instanz (#378,
// lib/feature-modules.ts): the features hidden for every account without a
// choice of its own (instance setting modulesDefault), with the switches of
// the personal setting, and "Allen bestehenden Konten zuweisen", which puts
// every account on this default (their own choices go). Above it
// "Funktionen dieser Instanz" (#386, lib/instance-modules.ts): switched off
// there, a feature is off on the server for everyone.
import { useRef, useState } from "react";
import { FEATURE_MODULES, hiddenModulesOf, type FeatureModule } from "@/lib/feature-modules";
import { setFeatureModulesOff, setFeatureModulesStandard } from "@/lib/feature-modules-client";
import { useT } from "../../i18n";
import { SaveState, SettingGroup, SettingRow, useSaveState } from "../../settings-ui";
import { useAdmin } from "../admin-context";
import { ModuleSwitches, moduleTexts } from "../user/feature-modules";
import { useInstanceSettings } from "./parts";
import { FeatureTiles } from "../previews";

// A list of features as an instance setting: saved one after the other, a
// failed save goes back; `after` once saved.
function useModulesSetting(field: "modulesDefault" | "modulesOff", after: (next: FeatureModule[]) => void) {
  const { settings, save } = useInstanceSettings();
  const [local, setLocal] = useState<FeatureModule[] | null>(null);
  const [status, run] = useSaveState();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const list = local ?? hiddenModulesOf(settings?.[field]);
  const change = (next: FeatureModule[]) => {
    const before = list;
    setLocal(next);
    void run(async () => {
      const done = queue.current.then(() => save({ [field]: next }));
      queue.current = done.catch(() => undefined);
      try {
        await done;
        after(next);
      } catch (e) {
        setLocal(before);
        throw e;
      }
    });
  };
  return { settings, list, change, status };
}

// "Funktionen dieser Instanz" (#386): off is off for everyone, on the
// server as well – what exists is kept and comes back when switched on.
export function InstanceModulesOff() {
  const t = useT();
  // The administrator's own interface follows at once.
  const { settings, list: off, change, status } = useModulesSetting("modulesOff", setFeatureModulesOff);
  const texts = moduleTexts(t);
  const toggle = (module: FeatureModule, on: boolean) => {
    if (
      !on &&
      !confirm(
        t(
          `„${texts[module].label}“ für die ganze Instanz ausschalten? Niemand kann es dann nutzen oder Neues anlegen, Hintergrundarbeit dafür pausiert und öffentliche Links dazu sind nicht erreichbar. Vorhandenes bleibt unverändert erhalten und lässt sich nur lesen, exportieren und löschen.`,
          `Switch “${texts[module].label}” off for the whole instance? Nobody can use it or create anything new, background work for it pauses and public links to it are not available. What exists is kept unchanged and can only be read, exported and deleted.`,
        ),
      )
    )
      return;
    change(on ? off.filter((m) => m !== module) : FEATURE_MODULES.filter((m) => m === module || off.includes(m)));
  };
  return (
    <SettingGroup
      id="modules-off"
      title={t("Funktionen dieser Instanz", "Features of this instance")}
      description={t(
        "Ausgeschaltet ist eine Funktion für alle aus – nicht nur ausgeblendet: Der Server lehnt sie ab, ihre Hintergrundarbeit pausiert, öffentliche Links und Formulare dazu sind geschlossen. Vorhandene Seiten bleiben erhalten, öffnen sich nur zum Lesen und lassen sich weiter exportieren, sichern und löschen. Eingeschaltet ist alles wieder wie vorher.",
        "Switched off, a feature is off for everyone – not only hidden: the server refuses it, its background work pauses, public links and forms of it are closed. Existing pages are kept, open read-only and can still be exported, backed up and deleted. Switched on again, everything is as before.",
      )}
    >
      <SettingRow label={t("Auf dieser Instanz eingeschaltet", "On for this instance")}>
        <SaveState status={status} />
      </SettingRow>
      {/* Tiles that switch (#532), and what disappears for people. */}
      <FeatureTiles off={off} disabled={!settings} onToggle={toggle} />
    </SettingGroup>
  );
}

export function InstanceModules() {
  const t = useT();
  const { mutate, onError } = useAdmin();
  const [applied, setApplied] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // An administrator without a choice of their own sees it at once.
  const { settings, list: hidden, change: save, status } = useModulesSetting("modulesDefault", (next) => setFeatureModulesStandard(next));
  const change = (next: FeatureModule[]) => {
    setApplied(null);
    save(next);
  };
  const applyAll = async () => {
    if (
      !confirm(
        t(
          "Allen bestehenden Konten diese Auswahl zuweisen? Eigene Auswahlen gehen verloren; alle folgen ab jetzt dem Standard der Instanz. Jede Person kann danach wieder selbst wählen.",
          "Apply this choice to all existing accounts? Their own choices are lost; everyone follows the instance default from now on. Everyone can choose for themselves again afterwards.",
        ),
      )
    )
      return;
    setBusy(true);
    try {
      const result = (await mutate({ action: "admin.modulesApplyAll" })) as { changed: number; standard: FeatureModule[] };
      setApplied(result.changed);
      // The administrator's own choice went as well.
      setFeatureModulesStandard(hiddenModulesOf(result.standard), true);
    } catch (e) {
      onError?.((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingGroup
      id="modules-default"
      title={t("Funktionen für neue Konten", "Features for new accounts")}
      description={t(
        "Welche Funktionen neue Konten sehen. Ausgeblendet heißt nur: kein Eintrag in „Neue Seite“, im „/“-Menü, in der Seitenleiste und der Schnellsuche – vorhandene Seiten bleiben für alle sichtbar und nutzbar, an den Rechten ändert sich nichts. Jede Person kann es unter Darstellung & Sprache → Funktionen selbst ändern. Konten von vor dieser Einstellung sehen weiter alles.",
        "Which features new accounts see. Hidden only means: no entry in “New page”, the “/” menu, the sidebar and the quick search – existing pages stay visible and usable for everyone, permissions do not change. Everyone can change it under Appearance & language → Features. Accounts from before this setting keep seeing everything.",
      )}
    >
      <ModuleSwitches hidden={hidden} onChange={change} disabled={!settings} off={hiddenModulesOf(settings?.modulesOff)} />
      <SettingRow
        label={t("Allen bestehenden Konten zuweisen", "Apply to all existing accounts")}
        description={
          applied === null
            ? t("Setzt alle Konten auf diesen Standard zurück, auch spätere Änderungen gelten dann für sie.", "Puts every account on this default; later changes then apply to them as well.")
            : t(`Zugewiesen – ${applied} Konten hatten eine eigene Auswahl.`, `Applied – ${applied} accounts had a choice of their own.`)
        }
      >
        <SaveState status={status} />
        <button type="button" className="button compact" disabled={busy || !settings} onClick={() => void applyAll()}>
          {t("Allen zuweisen", "Apply to all")}
        </button>
      </SettingRow>
    </SettingGroup>
  );
}
