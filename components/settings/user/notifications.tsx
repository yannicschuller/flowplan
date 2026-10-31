"use client";
// Settings → Benachrichtigungen: kinds per channel, chat apps, the weekly
// digest and push on this device. Every switch saves at once; the state
// shows next to it.
import { useEffect, useRef, useState } from "react";
import type { MessengerOverview } from "@/lib/messenger-services";
import { NotificationSettings } from "../../notification-settings";
import { MessengerSettings } from "../../messenger-settings";
import { WeeklyDigestSettings } from "../../weekly-digest-settings";
import PushSettings from "../../push-settings";
import { api } from "../../ui";
import { useUserSettings } from "../user-context";

export default function NotificationsSection() {
  const { boot, mutate, onError } = useUserSettings();
  // Chat apps (lib/messengers.ts): what the instance allows and what is
  // connected. Not in the demo and not with API tokens – then none.
  const [messengers, setMessengers] = useState<MessengerOverview | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    if (boot.user.demo) return;
    api<MessengerOverview>("/api/messengers")
      .then(setMessengers)
      .catch((e) => errorRef.current((e as Error).message));
  }, [boot.user.demo]);
  const chatApps = !!messengers && messengers.services.length > 0;
  return (
    <>
      {boot.notificationPrefs && (
        <NotificationSettings
          prefs={boot.notificationPrefs}
          messenger={chatApps}
          onReset={() => mutate({ action: "notification.reset" })}
          onChange={(kind, value) => mutate({ action: "notification.prefs", kind, ...value })}
        />
      )}
      {chatApps && <MessengerSettings overview={messengers} onChange={setMessengers} />}
      <WeeklyDigestSettings prefs={boot.weeklyDigest} ai={boot.ai} mail={!!boot.instance?.mail} save={mutate} />
      <PushSettings group />
    </>
  );
}
