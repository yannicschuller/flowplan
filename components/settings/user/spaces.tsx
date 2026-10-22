"use client";
// Settings → Arbeitsbereich → Bereiche: the spaces one may manage; each
// opens the space dialog (name, visibility, appearance, AI, Git export,
// duplicate, delete).
import { useState } from "react";
import { FolderSimple } from "@phosphor-icons/react";
import type { Space } from "@/lib/types";
import { useT } from "../../i18n";
import { SpaceIcon } from "../../space-appearance";
import { SpaceManager } from "../../space-manager";
import { EmptyState, SettingGroup, StatusBadge } from "../../settings-ui";
import { useUserSettings } from "../user-context";

export default function SpacesSection() {
  const t = useT();
  const { boot, onRefresh, reload } = useUserSettings();
  const [editingSpace, setEditingSpace] = useState<Space | null>(null);
  const spaces = boot.managedSpaces || [];
  return (
    <>
      <SettingGroup
        id="spaces"
        title={t(`Bereiche verwalten · ${spaces.length}`, `Manage spaces · ${spaces.length}`)}
        description={t("Bereichseigentümer verwalten ihre eigenen Bereiche. Arbeitsbereichseigentümer können alle Bereiche verwalten; private Seiten bleiben an ihre Leserechte gebunden.", "Space owners manage their own spaces. Workspace owners can manage all spaces; private pages stay bound to their read permissions.")}
      >
        {spaces.length ? (
          <ul className="ws-list" aria-label={t("Bereiche", "Spaces")}>
            {spaces.map((space) => {
              return (
                <li className="ws-item ws-item-inline ws-space-item" key={space.id}>
                  <span className="ws-item-icon" aria-hidden>
                    <SpaceIcon icon={space.icon} color={space.icon_color} />
                  </span>
                  <div className="ws-item-text">
                    <strong className="ws-break">{space.name}</strong>
                    <span className="ws-badges">
                      {space.visibility === "private" ? <StatusBadge tone="warn">{t("Privat", "Private")}</StatusBadge> : <StatusBadge tone="off">{t("Gesamtes Team", "Whole team")}</StatusBadge>}
                    </span>
                  </div>
                  <div className="ws-item-controls">
                    <button className="button" aria-label={t(`${space.name} verwalten`, `Manage ${space.name}`)} onClick={() => setEditingSpace(space)}>
                      {t("Verwalten", "Manage")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="setting-row wide">
            <EmptyState icon={<FolderSimple size={20} />} title={t("Keine Bereiche mit Verwaltungsrechten", "No spaces you can manage")}>
              {t("Bereiche, die du anlegst oder die dir übertragen werden, erscheinen hier.", "Spaces you create or that are handed to you show here.")}
            </EmptyState>
          </div>
        )}
      </SettingGroup>
      {editingSpace && (
        <SpaceManager
          space={editingSpace}
          onClose={() => setEditingSpace(null)}
          onDone={async () => {
            await onRefresh();
            await reload();
          }}
        />
      )}
    </>
  );
}
