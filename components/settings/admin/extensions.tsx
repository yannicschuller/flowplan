"use client";
// Administration → Erweiterungen & Domains: where block extensions may come
// from (lib/plugins.ts) and whether owners may serve publications under
// their own domain (lib/custom-domains.ts).
import { useT } from "../../i18n";
import { SettingGroup, SettingRow } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, FixLink, InstanceSwitch, useDocs } from "./parts";

export default function ExtensionsSection() {
  const t = useT();
  const docs = useDocs();
  const { data } = useAdminData();
  if (!data) return <AdminLoading />;
  const s = data.settings;
  return (
    <>
      <AdminStatus
        items={[
          s.pluginsAnyOrigin
            ? {
                tone: "info",
                label: t("Erweiterungen von jeder HTTPS-Adresse", "Extensions from any HTTPS address"),
              }
            : {
                tone: "ok",
                label: t("Erweiterungen nur von freigegebenen Adressen", "Extensions from allowed addresses only"),
              },
          s.customDomains
            ? { tone: "ok", label: t("Eigene Domains an", "Custom domains on") }
            : {
                tone: "off",
                label: t("Eigene Domains aus", "Custom domains off"),
              },
        ]}
      />
      <SettingGroup
        id="plugins"
        title={t("Block-Erweiterungen", "Block extensions")}
        description={t(
          "Eigene Blocktypen, die Eigentümer für ihren Arbeitsbereich registrieren. Erweiterungen laufen immer abgeschottet in einem Rahmen.",
          "Own block types that owners register for their workspace. Extensions always run isolated in a frame.",
        )}
      >
        <InstanceSwitch
          field="pluginsAnyOrigin"
          label={t("Block-Erweiterungen von jeder HTTPS-Adresse", "Block extensions from any HTTPS address")}
          description={
            <>
              {t("Ausgeschaltet registrieren Eigentümer nur Erweiterungen von den Adressen in", "When off, owners only register extensions from the addresses in")} <code>PLUGIN_ALLOWED_ORIGINS</code>.
            </>
          }
        />
        <SettingRow
          label={t("Erweiterungen eines Arbeitsbereichs", "A workspace's extensions")}
          description={t("Eigentümer verwalten sie in den Einstellungen ihres Arbeitsbereichs.", "Owners manage them in their workspace's settings.")}
        >
          <FixLink href="#settings/extensions">{t("Block-Erweiterungen öffnen", "Open block extensions")}</FixLink>
        </SettingRow>
      </SettingGroup>
      <SettingGroup
        id="domains"
        title={t("Eigene Domains", "Custom domains")}
        description={t("Veröffentlichte Seiten unter einer eigenen Domain, etwa docs.example.org.", "Published pages under an own domain, e.g. docs.example.org.")}
      >
        <InstanceSwitch
          field="customDomains"
          label={t("Eigene Domains für Veröffentlichungen", "Custom domains for publications")}
          description={t(
            "Eigentümer bestätigen ihre Domain per DNS-TXT-Eintrag. Das Zertifikat besorgt der Reverse Proxy (etwa Caddy mit On-Demand-TLS).",
            "Owners confirm their domain with a DNS TXT record. The reverse proxy obtains the certificate (e.g. Caddy with on-demand TLS).",
          )}
        />
        <SettingRow label={t("Reverse Proxy einrichten", "Set up the reverse proxy")} description={t("Beispiele für Caddy, Traefik und Coolify.", "Examples for Caddy, Traefik and Coolify.")}>
          <FixLink href={docs("coolify-and-proxy")}>{t("Anleitung", "Guide")}</FixLink>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
