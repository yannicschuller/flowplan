"use client";
// Settings → Block-Erweiterungen: own block types from allowed addresses.
import { PluginSettings } from "../../plugin-settings";
import { useUserSettings } from "../user-context";

export default function ExtensionsSection() {
  const { boot, owner, onError } = useUserSettings();
  return <PluginSettings workspaceId={boot.workspace.id} owner={owner} pages={boot.pages.filter((p) => !p.deleted_at)} onError={onError} />;
}
