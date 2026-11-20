"use client";
// Settings → Benachrichtigungen → "Ton bei neuen Benachrichtigungen" (#401,
// lib/notification-sound.ts): off or one of three short sounds, played in
// the open app when a new notification arrives; "Anhören" plays the chosen
// one (the click itself allows the browser to make sound).
import { SpeakerHigh } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { NOTIFICATION_SOUNDS, type NotificationSound } from "@/lib/notification-sound";
import { notificationSound, playNotificationSound, setNotificationSoundLocal, useNotificationSound } from "@/lib/notification-sound-client";
import { SaveState, SettingGroup, SettingRow, useSaveState } from "./settings-ui";

export function NotificationSoundSettings({ save }: { save: (body: Record<string, unknown>) => Promise<unknown> }) {
  const t = useT();
  const sound = useNotificationSound();
  const [status, run] = useSaveState();
  const names: Record<NotificationSound, string> = {
    off: t("Aus", "Off"),
    soft: t("Sanft", "Soft"),
    clear: t("Klar", "Clear||sound"),
    bell: t("Glocke", "Bell"),
  };
  const choose = (value: NotificationSound) => {
    const before = notificationSound();
    setNotificationSoundLocal(value);
    // Choosing a sound lets you hear it.
    if (value !== "off") playNotificationSound(value, true);
    void run(async () => {
      try {
        await save({ action: "profile.notificationSound", notificationSound: value });
      } catch (e) {
        setNotificationSoundLocal(before);
        throw e;
      }
    });
  };
  return (
    <SettingGroup id="notification-sound" title={t("Ton", "Sound")} actions={<SaveState status={status} />}>
      <SettingRow
        wide
        label={t("Ton bei neuen Benachrichtigungen", "Sound for new notifications")}
        description={t(
          "Ein kurzer, leiser Ton, solange Flowplan offen ist – im Browser und im Fenster der Desktop-App. Nur ein Tab spielt ihn, nie für das, was du selbst ausgelöst hast. Der Browser erlaubt ihn erst, nachdem du einmal in Flowplan geklickt oder getippt hast. Gilt auf allen Geräten.",
          "A short, quiet sound while Flowplan is open – in the browser and in the desktop app's window. Only one tab plays it, never for what you set off yourself. The browser allows it only after you clicked or typed in Flowplan once. Applies on all devices.",
        )}
      >
        <div className="notification-sound-control">
          <div className="segmented" role="radiogroup" aria-label={t("Ton bei neuen Benachrichtigungen", "Sound for new notifications")}>
            {NOTIFICATION_SOUNDS.map((value) => (
              <label key={value} data-active={sound === value}>
                <input type="radio" name="notification-sound" checked={sound === value} onChange={() => choose(value)} /> {names[value]}
              </label>
            ))}
          </div>
          <button type="button" className="button" disabled={sound === "off"} onClick={() => playNotificationSound(sound, true)}>
            <SpeakerHigh size={16} aria-hidden /> {t("Anhören", "Listen")}
          </button>
        </div>
      </SettingRow>
    </SettingGroup>
  );
}
