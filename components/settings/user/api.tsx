"use client";
// Settings → API & Webhooks: personal tokens, AI assistants (MCP) and – for
// owners – the workspace's webhooks.
import { IntegrationSettings } from "../../integration-settings";
import { useUserSettings } from "../user-context";

export default function ApiSection() {
  const { boot, owner, onError } = useUserSettings();
  return <IntegrationSettings workspaceId={boot.workspace.id} owner={owner} pages={boot.pages.filter((p) => !p.deleted_at)} onError={onError} />;
}
