"use client";
// "Other server? Switch profile" at the bottom of the sign-in pages, only
// inside the iPhone, iPad and Android app (#69): someone who picked the
// wrong instance – or has not signed in yet – gets back to the app's
// profiles without knowing the icon's quick action (lib/native-app.ts).
import { useEffect, useState, type MouseEvent } from "react";
import { APP_PROFILES_LINK, appProfilesAction, openAppProfiles } from "@/lib/native-app";
import { useT } from "./i18n";

export function AppProfilesLink() {
  const t = useT();
  // Known only in the page (the app's bridge and user agent): nothing on
  // the server's first render.
  const [action, setAction] = useState<ReturnType<typeof appProfilesAction>>(null);
  useEffect(() => setAction(appProfilesAction()), []);
  if (!action) return null;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (action !== "bridge") return;
    event.preventDefault();
    openAppProfiles();
  };
  return (
    <p className="login-switch login-app-profiles">
      {t("Anderer Server?", "Other server?")}{" "}
      <a className="text-button" href={APP_PROFILES_LINK} onClick={open}>
        {t("Profil wechseln", "Switch profile")}
      </a>
    </p>
  );
}
