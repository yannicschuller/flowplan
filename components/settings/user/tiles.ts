// The tiles of the settings' landing page: what the bootstrap already says
// about each section. Sections without a summary show their description.
import { LANGUAGES } from "@/lib/i18n";
import type { Bootstrap } from "@/lib/types";
import type { ThemeChoice } from "@/lib/theme";
import type { TileSummary } from "../shell";

type T = (de: string, en: string) => string;

export function userTiles(boot: Bootstrap, theme: ThemeChoice, t: T): Record<string, TileSummary> {
  const managed = boot.managedSpaces?.length ?? 0;
  const members = boot.members.length;
  const guests = boot.members.filter((m) => m.guest).length;
  return {
    account: {
      line: boot.user.email,
      badge: boot.localAccount ? t("E-Mail-Konto", "E-mail account") : boot.ldapAccount ? "LDAP" : "SSO",
    },
    appearance: {
      line: [
        boot.language ? LANGUAGES[boot.language].name : t("Sprache automatisch", "Language automatic"),
        theme === "dark" ? t("Dunkel", "Dark") : theme === "light" ? t("Hell", "Light") : t("Hell/Dunkel automatisch", "Light/dark automatic"),
      ].join(" · "),
    },
    members: {
      line: [members === 1 ? t("1 Mitglied", "1 member") : t(`${members} Mitglieder`, `${members} members`), guests ? t(`davon ${guests} Gäste`, `${guests} of them guests`) : ""].filter(Boolean).join(" · "),
    },
    spaces: managed ? { line: managed === 1 ? t("1 Bereich, den du verwaltest", "1 space you manage") : t(`${managed} Bereiche, die du verwaltest`, `${managed} spaces you manage`) } : {},
    workspace: { line: boot.workspace.name },
  };
}
