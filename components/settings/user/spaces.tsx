"use client";
// Settings → Arbeitsbereich → Bereiche: the spaces one may manage.
import { useState } from "react";
import { Lock } from "@phosphor-icons/react";
import type { Space } from "@/lib/types";
import { useT } from "../../i18n";
import { SpaceIcon } from "../../space-appearance";
import { SpaceManager } from "../../space-manager";
import { useUserSettings } from "../user-context";

export default function SpacesSection() {
  const t = useT();
  const { boot, onRefresh, reload } = useUserSettings();
  const [editingSpace, setEditingSpace] = useState<Space | null>(null);
  return (
    <>
      <section className="settings-section">
        <h2>{t("Bereiche verwalten", "Manage spaces")}</h2>
        <p>
          {t("Bereichseigentümer verwalten ihre eigenen Bereiche. Arbeitsbereichseigentümer können alle Bereiche verwalten; private Seiten bleiben an ihre Leserechte gebunden.", "Space owners manage their own spaces. Workspace owners can manage all spaces; private pages stay bound to their read permissions.")}
        </p>
        {(boot.managedSpaces || []).map((space) => (
          <div className="utility-row" key={space.id}>
            <SpaceIcon icon={space.icon} color={space.icon_color} />
            {space.visibility === "private" && <Lock aria-label={t("Privater Bereich", "Private space")} />}
            <strong>{space.name}</strong>
            <button className="button compact" onClick={() => setEditingSpace(space)}>
              {t("Verwalten", "Manage")}
            </button>
          </div>
        ))}
        {!boot.managedSpaces?.length && <p className="muted">{t("Keine Bereiche mit Verwaltungsrechten vorhanden.", "No spaces you can manage.")}</p>}
      </section>
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
