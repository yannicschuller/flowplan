// Field-level permissions as data, safe for the browser. The rules and
// their enforcement are described in lib/field-access.ts.
export const accessRuleNames = ["all", "editors", "owners"] as const;
export type AccessRule = (typeof accessRuleNames)[number] | { groups: string[] };
export type FieldAccess = { read?: AccessRule; write?: AccessRule };

const open = (rule?: AccessRule) => !rule || rule === "all";
export const readRestricted = (access?: FieldAccess) => !open(access?.read);
export const writeRestricted = (access?: FieldAccess) =>
  !open(access?.write) && access?.write !== "editors";
export const restrictedAccess = (access?: FieldAccess) =>
  readRestricted(access) || writeRestricted(access);

type T = (de: string, en: string) => string;
// "Sichtbar für alle", "Nur für Besitzer bearbeitbar" …
export function describeRule(
  rule: AccessRule | undefined,
  kind: "read" | "write",
  groups: { id: string; name: string }[],
  t: T,
) {
  const who =
    !rule || rule === "all"
      ? kind === "read"
        ? t("alle", "everyone")
        : t("Bearbeiter", "editors")
      : rule === "editors"
        ? t("Bearbeiter", "editors")
        : rule === "owners"
          ? t("Besitzer", "owners")
          : rule.groups.map((id) => groups.find((g) => g.id === id)?.name || t("Gruppe", "group")).join(", ");
  return kind === "read"
    ? t(`Sichtbar für ${who}`, `Visible to ${who}`)
    : t(`Nur für ${who} bearbeitbar`, `Editable only by ${who}`);
}
