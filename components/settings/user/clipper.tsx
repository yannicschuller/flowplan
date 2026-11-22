"use client";
// Settings → Web-Clipper: bookmarklet, browser extension, quick capture and
// importing browser bookmarks.
import { useT } from "../../i18n";
import { ClipperSettings } from "../../clipper-settings";
import { useUserSettings } from "../user-context";

export default function ClipperSection() {
  const t = useT();
  const { boot, mutate } = useUserSettings();
  return (
    <ClipperSettings
      workspaceId={boot.workspace.id}
      spaces={boot.spaces.filter((space) => !space.deleted_at)}
      canWrite={boot.workspace.role !== "viewer" && !boot.workspace.guest}
      onImport={async (spaceId, html) => {
        const result = (await mutate({ action: "bookmarks.import", workspaceId: boot.workspace.id, spaceId, html })) as { added: number; skipped: number };
        return result.skipped
          ? t(`${result.added} Lesezeichen importiert, ${result.skipped} übersprungen.`, `${result.added} bookmarks imported, ${result.skipped} skipped.`)
          : t(`${result.added} Lesezeichen importiert.`, `${result.added} bookmarks imported.`);
      }}
    />
  );
}
