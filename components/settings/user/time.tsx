"use client";
// Settings → Zeiten: time tracked in all databases.
import { TimeReport } from "../../time-report";
import { useUserSettings } from "../user-context";

export default function TimeSection() {
  const { boot } = useUserSettings();
  return <TimeReport workspaceId={boot.workspace.id} title={boot.workspace.name} />;
}
