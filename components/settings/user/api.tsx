"use client";
// Settings → API & KI-Assistenten: personal tokens and AI assistants (MCP).
// The workspace's webhooks are in Settings → Webhooks (./webhooks.tsx).
import { IntegrationSettings } from "../../integration-settings";
import { useUserSettings } from "../user-context";

export default function ApiSection() {
  const { onError } = useUserSettings();
  return <IntegrationSettings onError={onError} />;
}
