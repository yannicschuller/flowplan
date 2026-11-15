"use client";
// "Standard-Formatierungsleiste" in Administration → Instanz (#292): the
// formatting toolbar of everyone without a layout of their own
// (instance setting toolbarLayoutDefault, lib/instance-settings.ts), with
// the editor of the personal setting. Its "Zurücksetzen" goes back to the
// built-in toolbar.
import { useRef, useState } from "react";
import { defaultToolbarLayout, isDefaultToolbarLayout, type ToolbarLayout } from "@/lib/toolbar-layout";
import { setToolbarLayoutFromServer, toolbarLayoutState } from "@/lib/toolbar-layout-client";
import { useT } from "../../i18n";
import { ToolbarLayoutCustomizer } from "../user/toolbar-layout-editor";
import { useInstanceSettings } from "./parts";

export function InstanceToolbarLayout() {
  const t = useT();
  const { settings, save } = useInstanceSettings();
  // Shown at once; saved one after the other, always the latest.
  const [local, setLocal] = useState<ToolbarLayout | null | undefined>(undefined);
  const latest = useRef<ToolbarLayout | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const stored = local !== undefined ? local : (settings?.toolbarLayoutDefault ?? null);
  const layout = stored ?? defaultToolbarLayout();
  return (
    <ToolbarLayoutCustomizer
      anchor="toolbar-layout-default"
      label={t("Standard-Formatierungsleiste", "Default formatting toolbar")}
      description={t(
        "Die Formatierungsleiste aller Personen, die ihre Leiste nicht selbst angepasst haben (Einstellungen → Darstellung & Sprache → Formatierungsleiste anpassen). Wer sie angepasst hat, behält die eigene; „Zurücksetzen“ dort führt zu diesem Standard zurück. Hier stellt „Zurücksetzen“ die ursprüngliche Leiste wieder her.",
        "The formatting toolbar of everyone who has not customized theirs (Settings → Appearance & language → Customize formatting toolbar). Whoever customized it keeps their own; “Reset” there goes back to this default. Here, “Reset” restores the original bar.",
      )}
      layout={layout}
      resetTo={defaultToolbarLayout()}
      state={stored ? "custom" : "default"}
      resetNote={t("Die Leiste zeigt wieder die ursprünglichen Schaltflächen in der ursprünglichen Reihenfolge.", "The bar shows the original buttons in the original order again.")}
      commit={async (next, reset) => {
        const value = reset || isDefaultToolbarLayout(next) ? null : next;
        const before = stored;
        latest.current = value;
        setLocal(value);
        const done = queue.current.then(() => save({ toolbarLayoutDefault: latest.current }));
        queue.current = done.catch(() => undefined);
        try {
          await done;
        } catch (e) {
          latest.current = before;
          setLocal(before);
          throw e;
        }
        // An administrator without a layout of their own sees it at once.
        const own = toolbarLayoutState();
        if (!own.custom) setToolbarLayoutFromServer(latest.current, latest.current, false);
      }}
    />
  );
}
