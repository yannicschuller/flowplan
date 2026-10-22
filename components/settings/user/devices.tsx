"use client";
// Settings → Offline & Geräte: the offline copy on this device and how
// offline changes are merged.
import { OfflineSettings } from "../../offline-settings";
import { useUserSettings } from "../user-context";

export default function DevicesSection() {
  const { boot } = useUserSettings();
  return <OfflineSettings userId={boot.user.id} workspaceId={boot.workspace.id} />;
}
