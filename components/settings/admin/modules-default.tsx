"use client";
// "Funktionen für neue Konten" in Administration → Instanz (#378,
// lib/feature-modules.ts): the features hidden for every account without a
// choice of its own (instance setting modulesDefault), with the switches of
// the personal setting, and "Allen bestehenden Konten zuweisen", which puts
// every account on this default (their own choices go).
import { useRef, useState } from "react";
import { hiddenModulesOf, type FeatureModule } from "@/lib/feature-modules";
import { setFeatureModulesStandard } from "@/lib/feature-modules-client";
import { useT } from "../../i18n";
import { SaveState, SettingGroup, SettingRow, useSaveState } from "../../settings-ui";
import { useAdmin } from "../admin-context";
import { ModuleSwitches } from "../user/feature-modules";
import { useInstanceSettings } from "./parts";

export function InstanceModules() {
  const t = useT();
  const { settings, save } = useInstanceSettings();
  const { mutate, onError } = useAdmin();
  const [local, setLocal] = useState<FeatureModule[] | null>(null);
  const [status, run] = useSaveState();
  const [applied, setApplied] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const hidden = local ?? hiddenModulesOf(settings?.modulesDefault);
  const change = (next: FeatureModule[]) => {
    const before = hidden;
    setLocal(next);
    setApplied(null);
    void run(async () => {
      const done = queue.current.then(() => save({ modulesDefault: next }));
      queue.current = done.catch(() => undefined);
      try {
        await done;
        // An administrator without a choice of their own sees it at once.
        setFeatureModulesStandard(next);
      } catch (e) {
        setLocal(before);
        throw e;
      }
    });
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
      <ModuleSwitches hidden={hidden} onChange={change} disabled={!settings} />
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
