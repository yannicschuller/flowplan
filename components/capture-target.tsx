"use client";
// The database a capture goes into, with the person's default capture
// database preselected; "Use as default" remembers another choice.
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { Select } from "./select";
import { api } from "./ui";
import { CONTROL, SaveState, SettingGroup, SettingRow, useSaveState } from "./settings-ui";

export type CaptureDatabase = { id: string; title: string; icon: string; space: string };
export type CaptureTargets = { databases: CaptureDatabase[]; default: string | null };

export function useCaptureTargets(workspaceId: string) {
  const [targets, setTargets] = useState<CaptureTargets | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let current = true;
    setTargets(null);
    api<CaptureTargets>(`/api/capture?workspace=${workspaceId}`)
      .then((t) => current && setTargets(t))
      .catch(() => current && setTargets({ databases: [], default: null }));
    return () => {
      current = false;
    };
  }, [workspaceId]);
  return [targets, setTargets] as const;
}

// After saving: remembers the chosen database as default when asked.
export async function rememberCaptureTarget(workspaceId: string, pageId: string, targets: CaptureTargets | null) {
  if (targets?.default === pageId) return;
  await api("/api/command", { action: "capture.target", workspaceId, pageId });
}

export function CaptureTargetPicker({
  targets,
  value,
  onChange,
  makeDefault,
  onMakeDefault,
}: {
  targets: CaptureTargets | null;
  value: string;
  onChange: (id: string) => void;
  makeDefault: boolean;
  onMakeDefault: (on: boolean) => void;
}) {
  const t = useT();
  if (!targets) return <p className="muted small">{t("Datenbanken werden geladen …", "Loading databases …")}</p>;
  if (!targets.databases.length)
    return <p className="muted small">{t("Es gibt keine Datenbank, in die du schreiben darfst.", "There is no database you may write to.")}</p>;
  const spaces = new Set(targets.databases.map((d) => d.space)).size > 1;
  return (
    <>
      <label>
        {t("Datenbank", "Database")}
        <Select value={value} onChange={(e) => onChange(e.target.value)}>
          {targets.databases.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title || t("Ohne Titel", "Untitled")}
              {spaces && d.space ? ` · ${d.space}` : ""}
            </option>
          ))}
        </Select>
      </label>
      {value && value !== targets.default && (
        <label className="checkbox-label">
          <input type="checkbox" checked={makeDefault} onChange={(e) => onMakeDefault(e.target.checked)} />
          {t("Als Standard zum Erfassen verwenden", "Use as default for capturing")}
        </label>
      )}
    </>
  );
}

// Settings → Web-Clipper: the default capture database of this workspace,
// as a card with one row; saves on change.
export function CaptureDefaultSetting({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const [targets, setTargets] = useCaptureTargets(workspaceId);
  const [status, run] = useSaveState();
  if (!targets?.databases.length) return null;
  return (
    <SettingGroup id="capture" title={t("Erfassen", "Capture")}>
      <SettingRow
        id="capture-default"
        label={t("Datenbank zum Erfassen", "Database for capturing")}
        description={t(
          `Teilen, Web-Clipper und „Schnell erfassen“${keyHints.action("capture") && ` (${keyHints.action("capture")})`} legen Einträge in dieser Datenbank an, etwa in deinem Eingang. Die Standardvorlage der Datenbank wird übernommen.`,
          `Share, the web clipper and “Quick capture”${keyHints.action("capture") && ` (${keyHints.action("capture")})`} create records in this database, e.g. your inbox. The database's default record template applies.`,
        )}
      >
        <Select
          id="capture-default"
          className={CONTROL.lg}
          value={targets.default || ""}
          onChange={(e) => {
            const pageId = e.target.value || null;
            void run(async () => {
              await api("/api/command", { action: "capture.target", workspaceId, pageId });
              setTargets({ ...targets, default: pageId });
            });
          }}
        >
          <option value="">{t("Keine – als Seite speichern", "None – save as a page")}</option>
          {targets.databases.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title || t("Ohne Titel", "Untitled")}
              {d.space ? ` · ${d.space}` : ""}
            </option>
          ))}
        </Select>
        <SaveState status={status} />
      </SettingRow>
    </SettingGroup>
  );
}
