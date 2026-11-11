"use client";
// "Other server? Switch profile" at the bottom of the sign-in pages, only
// inside the iPhone, iPad and Android app (#69): someone who picked the
// wrong instance – or has not signed in yet – gets back to the app's
// profiles without knowing the icon's quick action (lib/native-app.ts).
import { useEffect, useState, type MouseEvent } from "react";
import { APP_PROFILES_LINK, appProfilesAction, openAppProfiles } from "@/lib/native-app";
import { useT } from "./i18n";

// inline: only the link ("Anderer Server"), for the one quiet line under
// the sign-in buttons (components/login.tsx).
export function AppProfilesLink({ inline = false }: { inline?: boolean }) {
  const t = useT();
  // Known only in the page (the app's bridge and user agent): nothing on
  // the server's first render.
  const [action, setAction] = useState<Awaited<ReturnType<typeof appProfilesAction>>>(null);
  useEffect(() => setAction(appProfilesAction()), []);
  if (!action) return null;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (action !== "bridge") return;
    event.preventDefault();
    openAppProfiles();
  };
  if (inline)
    return (
      <a className="text-button login-app-profiles" href={APP_PROFILES_LINK} onClick={open} title={t("Profil wechseln", "Switch profile")}>
        {t("Anderer Server", "Other server")}
      </a>
    );
  return (
    <p className="login-switch login-app-profiles">
      {t("Anderer Server?", "Other server?")}{" "}
      <a className="text-button" href={APP_PROFILES_LINK} onClick={open}>
        {t("Profil wechseln", "Switch profile")}
      </a>
    </p>
  );
}
