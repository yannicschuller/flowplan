"use client";
// Settings → Webhooks: the workspace's webhooks (owners only). The list is
// #settings/webhooks, one webhook's page #settings/webhooks/<id> and a new
// one #settings/webhooks/new – the third part of the address, which the
// shell otherwise uses as an anchor.
import { WebhooksLogo } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { EmptyState } from "../../settings-ui";
import { WebhookSettings } from "../../webhook-settings";
import { useSettingsRoute } from "../shell";
import { useUserSettings } from "../user-context";

export default function WebhooksSection() {
  const t = useT();
  const { boot, owner, onError } = useUserSettings();
  const route = useSettingsRoute("settings");
  if (!owner || boot.user.demo)
    return (
      <EmptyState icon={<WebhooksLogo size={20} />} title={t("Nur für Eigentümer des Arbeitsbereichs", "Only for owners of the workspace")}>
        {boot.user.demo
          ? t("In der Demo nicht verfügbar.", "Not available in the demo.")
          : t("Webhooks gelten für den ganzen Arbeitsbereich; sie legen Eigentümerinnen und Eigentümer an.", "Webhooks apply to the whole workspace; owners create them.")}
      </EmptyState>
    );
  return <WebhookSettings workspaceId={boot.workspace.id} pages={boot.pages.filter((p) => !p.deleted_at)} onError={onError} view={route.section === "webhooks" ? route.anchor : null} />;
}
