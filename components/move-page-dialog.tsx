"use client";
import { useT } from "./i18n";
import { useEffect, useMemo, useState } from "react";
import { Modal, api } from "./ui";
import { Select } from "./select";
import type { Page, Space } from "@/lib/types";

type Workspace = { id: string; name: string; role: string; guest?: number };
type Place = { spaces: Space[]; pages: Page[] };

// "Seite verschieben": into another page, another space or another workspace
// the person may write in.
export function MovePageDialog({
  open,
  onClose,
  page,
  workspaces,
  currentWorkspace,
  current,
  onMove,
}: {
  open: boolean;
  onClose: () => void;
  page: Page | undefined;
  workspaces: Workspace[];
  currentWorkspace: string;
  current: Place;
  onMove: (move: { spaceId: string; parentId: string | null; workspaceId: string }) => Promise<boolean>;
}) {
  const t = useT();
  const writable = workspaces.filter((w) => !w.guest && ["owner", "editor"].includes(w.role));
  const [workspaceId, setWorkspaceId] = useState(currentWorkspace),
    [spaceId, setSpaceId] = useState(page?.space_id || ""),
    [parentId, setParentId] = useState(""),
    [other, setOther] = useState<Place | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setWorkspaceId(currentWorkspace);
    setSpaceId(page?.space_id || "");
    setParentId(page?.parent_id || "");
  }, [open, currentWorkspace, page?.space_id, page?.parent_id]);
  const foreign = workspaceId !== currentWorkspace;
  useEffect(() => {
    if (!open || !foreign) return;
    let alive = true;
    setOther(null);
    void api<Place>(`/api/bootstrap?workspace=${workspaceId}`).then((b) => {
      if (!alive) return;
      setOther({ spaces: b.spaces, pages: b.pages });
      setSpaceId(b.spaces.find((s) => !s.deleted_at)?.id || "");
      setParentId("");
    });
    return () => {
      alive = false;
    };
  }, [open, foreign, workspaceId]);
  const place = foreign ? other : current;
  // The page cannot go below itself or one of its own sub pages.
  const excluded = useMemo(() => {
    const set = new Set<string>();
    if (!page) return set;
    set.add(page.id);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of current.pages)
        if (p.parent_id && set.has(p.parent_id) && !set.has(p.id)) {
          set.add(p.id);
          grew = true;
        }
    }
    return set;
  }, [page, current.pages]);
  const parents = (place?.pages || []).filter(
    (p) => p.space_id === spaceId && !p.deleted_at && !excluded.has(p.id) && !p.journal_date,
  );
  return (
    <Modal open={open} onClose={onClose} title={t("Seite verschieben", "Move page")}>
      <div className="move-page-dialog">
        {writable.length > 1 && (
          <label>
            {t("Arbeitsbereich", "Workspace")}
            <Select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              {writable.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.id === currentWorkspace ? " (aktuell)" : ""}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label>
          {t("Bereich", "Space")}
          <Select
            value={spaceId}
            disabled={!place}
            onChange={(e) => {
              setSpaceId(e.target.value);
              setParentId("");
            }}
          >
            {(place?.spaces || [])
              .filter((s) => !s.deleted_at)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </Select>
        </label>
        <label>
          {t("Übergeordnete Seite", "Parent page")}
          <Select value={parentId} disabled={!place} onChange={(e) => setParentId(e.target.value)}>
            <option value="">{t("Auf oberste Ebene", "To the top level")}</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title || t("Ohne Titel", "Untitled")}
              </option>
            ))}
          </Select>
        </label>
        {foreign && (
          <p className="callout move-page-note">
            {t("Die Seite und ihre Unterseiten wechseln den Arbeitsbereich. Rechte für Gruppen und Personen, die dort nicht Mitglied sind, entfallen; Datenbanken mit Relationen zu zurückbleibenden Datenbanken lassen sich erst nach dem Lösen der Relation verschieben.", "The page and its sub-pages change workspace. Permissions for groups and people who are not members there are dropped; databases with relations to databases staying behind can only be moved after removing the relation.")}
          </p>
        )}
        <button
          className="button primary"
          disabled={busy || !spaceId || !page}
          onClick={async () => {
            setBusy(true);
            const ok = await onMove({ spaceId, parentId: parentId || null, workspaceId });
            setBusy(false);
            if (ok) onClose();
          }}
        >
          {busy ? t("Wird verschoben …", "Moving …") : t("Verschieben", "Move")}
        </button>
      </div>
    </Modal>
  );
}
