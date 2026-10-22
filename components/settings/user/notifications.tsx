"use client";
// Settings → Benachrichtigungen: kinds per channel, the weekly digest and
// push on this device.
import { NotificationSettings } from "../../notification-settings";
import { WeeklyDigestSettings } from "../../weekly-digest-settings";
import PushSettings from "../../push-settings";
import { useUserSettings } from "../user-context";

export default function NotificationsSection() {
  const { boot, mutate, onError } = useUserSettings();
  return (
    <>
      {boot.notificationPrefs && (
        <NotificationSettings
          prefs={boot.notificationPrefs}
          onReset={async () => {
            try {
              await mutate({ action: "notification.reset" });
            } catch (e) {
              onError((e as Error).message);
            }
          }}
          onChange={async (kind, value) => {
            try {
              await mutate({ action: "notification.prefs", kind, ...value });
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        />
      )}
      <WeeklyDigestSettings prefs={boot.weeklyDigest} ai={boot.ai} mail={!!boot.instance?.mail} save={mutate} onError={onError} />
      <PushSettings />
    </>
  );
}
