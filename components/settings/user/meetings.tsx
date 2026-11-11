"use client";
// Settings → Arbeitsbereich → Besprechungen (#199, lib/meetings.ts): the
// default instructions of new meeting blocks, what happens to the audio
// after the transcript, and whether recording needs everyone's consent.
// Members read, owners change.
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { SettingGroup, SettingRow, SwitchRow } from "../../settings-ui";
import { Select } from "../../select";
import { useUserSettings } from "../user-context";
import { MEETING_PRESETS, MEETING_PRESET_LABELS } from "@/lib/meeting-core";
import { getJson, postJson } from "@/lib/meeting-recorder";

type Settings = {
  instructions: string;
  prompt: string;
  retention: "delete" | "keep" | "days";
  retentionDays: number;
  consentRequired: boolean;
  consentText: string;
  defaultConsentText: string;
  transcription: boolean;
};

export default function MeetingsSection() {
  const t = useT();
  const { boot, owner, onError } = useUserSettings();
  const [settings, setSettings] = useState<Settings | null>(null);
  const workspaceId = boot.workspace.id;
  useEffect(() => {
    void getJson<Settings>(`/api/meetings/settings?workspaceId=${workspaceId}`)
      .then(setSettings)
      .catch((e) => onError((e as Error).message));
  }, [workspaceId, onError]);
  const save = async (change: Partial<Settings>) => {
    if (!settings) return;
    setSettings({ ...settings, ...change });
    try {
      setSettings(await postJson<Settings>("/api/meetings/settings", { workspaceId, settings: change }));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  if (!settings) return <p className="muted">{t("Wird geladen …", "Loading …")}</p>;
  return (
    <>
      {!settings.transcription && (
        <p className="setting-note">
          {t(
            "Transkription ist auf diesem Server nicht eingerichtet (WHISPER_URL). Besprechungsblöcke funktionieren dann nur mit eigener Agenda.",
            "Transcription is not set up on this server (WHISPER_URL). Meeting blocks then only work with your own agenda.",
          )}
        </p>
      )}
      <SettingGroup
        id="instructions"
        title={t("Anweisungen", "Instructions")}
        description={t("Womit neue Besprechungsblöcke zusammengefasst werden; jeder Block kann sie ändern.", "How new meeting blocks are summarised; each block can change it.")}
      >
        <SettingRow label={t("Standard", "Default")} id="meeting-instructions">
          <Select id="meeting-instructions" value={settings.instructions} disabled={!owner} onChange={(e) => void save({ instructions: e.target.value })}>
            {MEETING_PRESETS.map((p) => (
              <option key={p} value={p}>
                {t(MEETING_PRESET_LABELS[p][0], MEETING_PRESET_LABELS[p][1])}
              </option>
            ))}
          </Select>
        </SettingRow>
        {settings.instructions === "custom" && (
          <SettingRow label={t("Eigene Anweisung", "Custom instructions")} id="meeting-prompt" wide>
            <textarea
              id="meeting-prompt"
              rows={3}
              maxLength={4000}
              disabled={!owner}
              defaultValue={settings.prompt}
              onBlur={(e) => e.target.value !== settings.prompt && void save({ prompt: e.target.value })}
            />
          </SettingRow>
        )}
      </SettingGroup>
      <SettingGroup
        id="audio"
        title={t("Audio aufbewahren", "Keep audio")}
        description={t(
          "Nach einem erfolgreichen Transkript. Aufbewahrtes Audio zählt zum Speicher und spielt beim Klick auf eine Quelle ab.",
          "After a successful transcript. Kept audio counts against the storage and plays when a source is clicked.",
        )}
      >
        <SettingRow label={t("Audio", "Audio")} id="meeting-retention">
          <Select id="meeting-retention" value={settings.retention} disabled={!owner} onChange={(e) => void save({ retention: e.target.value as Settings["retention"] })}>
            <option value="delete">{t("Nach dem Transkript löschen", "Delete after the transcript")}</option>
            <option value="days">{t("Nach einigen Tagen löschen", "Delete after some days")}</option>
            <option value="keep">{t("Behalten", "Keep")}</option>
          </Select>
        </SettingRow>
        {settings.retention === "days" && (
          <SettingRow label={t("Tage", "Days")} id="meeting-days">
            <input
              id="meeting-days"
              type="number"
              min={1}
              max={3650}
              disabled={!owner}
              defaultValue={settings.retentionDays}
              onBlur={(e) => {
                const days = Math.max(1, Math.min(3650, Math.round(Number(e.target.value) || 30)));
                if (days !== settings.retentionDays) void save({ retentionDays: days });
              }}
            />
          </SettingRow>
        )}
      </SettingGroup>
      <SettingGroup id="consent" title={t("Einwilligung", "Consent")} description={t("Vor jeder Aufnahme erscheint der Hinweis; er lässt sich vorlesen.", "The notice appears before every recording and can be read aloud.")}>
        <SwitchRow
          label={t("Einwilligung erforderlich", "Consent required")}
          description={t("Aufnehmen erst, nachdem bestätigt wurde, dass alle Transkribierten zugestimmt haben.", "Recording only after confirming that everyone transcribed has agreed.")}
          checked={settings.consentRequired}
          disabled={!owner}
          onChange={(consentRequired) => void save({ consentRequired })}
        />
        <SettingRow label={t("Hinweistext", "Notice text")} id="meeting-consent" wide>
          <textarea
            id="meeting-consent"
            rows={3}
            maxLength={2000}
            disabled={!owner}
            placeholder={settings.defaultConsentText}
            defaultValue={settings.consentText}
            onBlur={(e) => e.target.value !== settings.consentText && void save({ consentText: e.target.value })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
