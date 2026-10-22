"use client";
// Which SSO groups a membership (target "") or group membership came from,
// and the note after changing something SSO manages.
import { useT } from "../../i18n";
import { useUserSettings } from "../user-context";

export function useSsoVia() {
  const t = useT();
  const { workspace } = useUserSettings();
  const ssoVia = (userId: string, target: string) =>
    (workspace?.ssoSources || [])
      .filter((s) => s.user_id === userId && s.target === target)
      .map((s) => s.sso_group)
      .join(", ");
  const ssoNotice = t(
    "Geändert. Diese Zuordnung kommt aus SSO: Bei der nächsten SSO-Anmeldung der Person gilt wieder, was die SSO-Zuordnung sagt.",
    "Changed. This comes from SSO: at the person's next SSO sign-in, what the SSO mapping says applies again.",
  );
  return { ssoVia, ssoNotice };
}
