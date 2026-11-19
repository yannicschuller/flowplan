"use client";
// Administration → Instanz → "Startinhalt für neue Konten" (#381,
// lib/starter-content.ts): the space whose pages every new personal
// workspace gets, and whether the built-in welcome page stays.
import { Warning } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { SettingGroup } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { InstanceSelect, InstanceSwitch } from "./parts";

export function StarterContent() {
  const t = useT();
  const { data } = useAdminData();
  if (!data) return null;
  const starter = data.starter ?? null;
  const choices = data.starterSpaces ?? [];
  const options = choices.map((s) => ({ value: s.id, label: `${s.workspace} – ${s.name}` }));
  // Chosen by another administrator (or gone): still shown as chosen.
  if (starter && !choices.some((s) => s.id === starter.id))
    options.unshift({
      value: starter.id,
      label: starter.name ? `${starter.workspace} – ${starter.name}` : t("Gelöschter Bereich", "Deleted space"),
    });
  const problem = starter?.problem
    ? {
        "space gone": t("Den gewählten Bereich gibt es nicht mehr.", "The chosen space no longer exists."),
        "space end-to-end encrypted": t("Der gewählte Bereich ist Ende-zu-Ende-verschlüsselt.", "The chosen space is end-to-end encrypted."),
        "space not readable by the administrator who chose it": t(
          "Die Person, die den Bereich gewählt hat, kann ihn nicht mehr lesen.",
          "The person who chose the space can no longer read it.",
        ),
        "admin gone": t("Die Person, die den Bereich gewählt hat, gibt es nicht mehr.", "The person who chose the space no longer exists."),
      }[starter.problem]
    : null;
  return (
    <SettingGroup
      id="starter"
      title={t("Startinhalt für neue Konten", "Starter content for new accounts")}
      description={t(
        "Jedes neue Konto bekommt in seinem persönlichen Arbeitsbereich eine Kopie der Seiten dieses Bereichs – mit Unterseiten, Datenbanken samt Einträgen und Ansichten, Whiteboards und Dateien, aber ohne Kommentare, Versionen, Freigaben und Berechtigungen. Das gilt auch für Konten aus SSO, LDAP und SCIM; bestehende Konten bleiben, wie sie sind.",
        "Every new account gets a copy of this space’s pages in its personal workspace – with sub-pages, databases with their records and views, whiteboards and files, but without comments, versions, shares and permissions. This includes accounts from SSO, LDAP and SCIM; existing accounts stay as they are.",
      )}
    >
      {problem && (
        <div className="callout admin-update" role="status">
          <Warning size={20} aria-hidden="true" />
          <span>
            <strong>{problem}</strong>{" "}
            {t("Neue Konten bekommen bis dahin die eingebaute Willkommensseite und Beispiele.", "Until then, new accounts get the built-in welcome page and examples.")}
          </span>
        </div>
      )}
      <InstanceSelect
        field="starterSpace"
        label={t("Bereich", "Space")}
        description={t(
          "Einer der Bereiche, die du lesen kannst. Die Seiten werden so kopiert, wie du sie siehst; was neu dazukommt, bekommen erst die Konten danach.",
          "One of the spaces you can read. The pages are copied as you see them; what you add later only reaches accounts created after that.",
        )}
        standard={t("Keiner – eingebaute Willkommensseite und Beispiele", "None – built-in welcome page and examples")}
        options={options}
      />
      <InstanceSwitch
        field="starterKeepWelcome"
        label={t("Eingebaute Willkommensseite behalten", "Keep the built-in welcome page")}
        description={t(
          "An: „Willkommen bei Flowplan“ steht vor den Seiten des Bereichs. Aus: nur die Seiten des Bereichs. Die eingebauten Beispiele (Roadmap, Handbuch) ersetzt der Bereich immer.",
          "On: “Welcome to Flowplan” comes before the space’s pages. Off: only the space’s pages. The built-in examples (roadmap, handbook) are always replaced by the space.",
        )}
        disabled={!data.settings.starterSpace}
      />
    </SettingGroup>
  );
}
