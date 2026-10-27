"use client";
// Settings → Arbeitsbereich → Bereiche: the spaces one may manage, in the
// sidebar's order; each opens the space dialog (name, visibility,
// appearance, AI, Git export, duplicate, delete). Workspace owners move the
// spaces they see in the sidebar up and down (issue #48, lib/space-order.ts).
import { useState } from "react";
import { ArrowDown, ArrowUp, FolderSimple } from "@phosphor-icons/react";
import { moveSpaceBy } from "@/lib/space-moves";
import type { Space } from "@/lib/types";
import { useT } from "../../i18n";
import { SpaceIcon } from "../../space-appearance";
import { SpaceManager } from "../../space-manager";
import { EmptyState, SettingGroup, StatusBadge } from "../../settings-ui";
import { useUserSettings } from "../user-context";

export default function SpacesSection() {
  const t = useT();
  const { boot, onRefresh, reload, mutate, onError, owner } = useUserSettings();
  const [editingSpace, setEditingSpace] = useState<Space | null>(null),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState("");
  const spaces = boot.managedSpaces || [];
  // Only spaces shown in the sidebar move; private spaces of others keep
  // their place and are never sent.
  const order = boot.spaces.filter((s) => !s.deleted_at).map((s) => s.id),
    reorderable = owner && !boot.workspace.guest && order.length > 1;
  async function move(space: Space, delta: -1 | 1) {
    const next = moveSpaceBy(order, space.id, delta);
    if (!next || busy) return;
    setBusy(true);
    try {
      await mutate({ action: "space.reorder", workspaceId: boot.workspace.id, order: next });
      const at = next.indexOf(space.id) + 1;
      setNote(t(`„${space.name}“ steht jetzt an Position ${at} von ${next.length}.`, `“${space.name}” is now at position ${at} of ${next.length}.`));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <SettingGroup
        id="spaces"
        title={t(`Bereiche verwalten · ${spaces.length}`, `Manage spaces · ${spaces.length}`)}
        description={
          reorderable
            ? t("Bereichseigentümer verwalten ihre eigenen Bereiche. Arbeitsbereichseigentümer können alle Bereiche verwalten und ihre Reihenfolge in der Seitenleiste für alle festlegen; private Seiten bleiben an ihre Leserechte gebunden.", "Space owners manage their own spaces. Workspace owners can manage all spaces and set their order in the sidebar for everyone; private pages stay bound to their read permissions.")
            : t("Bereichseigentümer verwalten ihre eigenen Bereiche. Arbeitsbereichseigentümer können alle Bereiche verwalten; private Seiten bleiben an ihre Leserechte gebunden.", "Space owners manage their own spaces. Workspace owners can manage all spaces; private pages stay bound to their read permissions.")
        }
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
                    {reorderable && order.includes(space.id) && (
                      <span className="ws-order-buttons">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={t(`${space.name} nach oben`, `Move ${space.name} up`)}
                          title={t("Nach oben", "Move up")}
                          disabled={busy || order.indexOf(space.id) === 0}
                          onClick={() => void move(space, -1)}
                        >
                          <ArrowUp size={16} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={t(`${space.name} nach unten`, `Move ${space.name} down`)}
                          title={t("Nach unten", "Move down")}
                          disabled={busy || order.indexOf(space.id) === order.length - 1}
                          onClick={() => void move(space, 1)}
                        >
                          <ArrowDown size={16} />
                        </button>
                      </span>
                    )}
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
        <p className="sr-only" role="status" aria-live="polite">
          {note}
        </p>
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
