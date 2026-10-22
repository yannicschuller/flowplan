"use client";
// Settings → Benachrichtigungen: kinds per channel, the weekly digest and
// push on this device. Every switch saves at once; the state shows next to it.
import { NotificationSettings } from "../../notification-settings";
import { WeeklyDigestSettings } from "../../weekly-digest-settings";
import PushSettings from "../../push-settings";
import { useUserSettings } from "../user-context";

export default function NotificationsSection() {
  const { boot, mutate } = useUserSettings();
  return (
    <>
      {boot.notificationPrefs && (
        <NotificationSettings
          prefs={boot.notificationPrefs}
          onReset={() => mutate({ action: "notification.reset" })}
          onChange={(kind, value) => mutate({ action: "notification.prefs", kind, ...value })}
        />
      )}
      <WeeklyDigestSettings prefs={boot.weeklyDigest} ai={boot.ai} mail={!!boot.instance?.mail} save={mutate} />
      <PushSettings group />
    </>
  );
}
