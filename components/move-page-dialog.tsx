"use client";
import { useT } from "./i18n";
import { useEffect, useMemo, useState } from "react";
import { Modal, api } from "./ui";
import { Select } from "./select";
import { MetaResolution, moveIntro } from "./meta-scope";
import { planFrom, type ForeignMeta, type MetaChoice, type MetaPlan } from "@/lib/meta-scope";
import type { Field, Page, Space } from "@/lib/types";
import { cellText } from "@/lib/cell-text";

type Workspace = { id: string; name: string; role: string; guest?: number };
type Place = { spaces: Space[]; pages: Page[] };

// "Seite verschieben": into another page, another space or another workspace
// the person may write in. When the page (or what is below it) uses tags or
// properties of its space the destination lacks, a second step lists them
// with a choice each – map, copy (the default) or remove (#136). A database
// as the parent offers its records (#231): the page then sits below one.
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
  onMove: (move: { spaceId: string; parentId: string | null; parentRowId?: string | null; workspaceId: string; meta?: MetaPlan }) => Promise<boolean>;
}) {
  const t = useT();
  const writable = workspaces.filter((w) => !w.guest && ["owner", "editor"].includes(w.role));
  const [workspaceId, setWorkspaceId] = useState(currentWorkspace),
    [spaceId, setSpaceId] = useState(page?.space_id || ""),
    [parentId, setParentId] = useState(""),
    // A record of the parent database, and the records to choose from.
    [rowId, setRowId] = useState(""),
    [records, setRecords] = useState<{ id: string; title: string }[] | null>(null),
    [other, setOther] = useState<Place | null>(null),
    [busy, setBusy] = useState(false),
    // The second step: what the destination lacks, and the choices.
    [resolve, setResolve] = useState<ForeignMeta[] | null>(null),
    [choices, setChoices] = useState<Record<string, MetaChoice>>({});
  useEffect(() => {
    if (!open) return;
    setResolve(null);
    setChoices({});
    setWorkspaceId(currentWorkspace);
    setSpaceId(page?.space_id || "");
    setParentId(page?.parent_id || "");
    setRowId(page?.parent_row_id || "");
  }, [open, currentWorkspace, page?.space_id, page?.parent_id, page?.parent_row_id]);
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
  const targetName = place?.spaces.find((s) => s.id === spaceId)?.name ?? "";
  const parentDatabase = parents.find((p) => p.id === parentId && p.kind === "database");
  useEffect(() => {
    setRecords(null);
    if (!open || !parentDatabase) return;
    let alive = true;
    // The records the person may edit (only those take sub-pages).
    void api<{ rows: { id: string; cells: Record<string, unknown>; role?: string }[]; database: { fields: Field[] } }>(`/api/pages/${parentDatabase.id}`)
      .then((d) => {
        if (!alive) return;
        const title = d.database.fields[0]?.id || "title";
        setRecords(
          d.rows
            .filter((r) => r.role !== "viewer")
            .map((r) => ({ id: r.id, title: cellText(r.cells[title]) }))
            .sort((a, b) => a.title.localeCompare(b.title)),
        );
      })
      .catch(() => alive && setRecords([]));
    return () => {
      alive = false;
    };
  }, [open, parentDatabase]);
  const move = async (meta?: MetaPlan) => {
    setBusy(true);
    const ok = await onMove({ spaceId, parentId: parentId || null, parentRowId: parentDatabase && rowId ? rowId : null, workspaceId, ...(meta ? { meta } : {}) });
    setBusy(false);
    if (ok) onClose();
  };
  if (resolve)
    return (
      <Modal open={open} sheet onClose={onClose} title={t("Tags und Eigenschaften mitnehmen", "Bring tags and properties along")}>
        <div className="move-page-dialog">
          <p className="muted">{moveIntro(t, targetName)}</p>
          <MetaResolution items={resolve} target={targetName} choices={choices} onChoose={(key, choice) => setChoices((all) => ({ ...all, [key]: choice }))} />
          <div className="modal-actions">
            <button type="button" className="button" disabled={busy} onClick={() => setResolve(null)}>
              {t("Zurück", "Back")}
            </button>
            <button type="button" className="button primary" disabled={busy} onClick={() => void move(planFrom(resolve, choices))}>
              {busy ? t("Wird verschoben …", "Moving …") : t("Verschieben", "Move")}
            </button>
          </div>
        </div>
      </Modal>
    );
  return (
    <Modal open={open} sheet onClose={onClose} title={t("Seite verschieben", "Move page")}>
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
          <Select
            value={parentId}
            disabled={!place}
            onChange={(e) => {
              setParentId(e.target.value);
              setRowId("");
            }}
          >
            <option value="">{t("Auf oberste Ebene", "To the top level")}</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title || t("Ohne Titel", "Untitled")}
              </option>
            ))}
          </Select>
        </label>
        {parentDatabase && (
          <label>
            {t("Unter Eintrag", "Below record")}
            <Select value={rowId} disabled={!records} onChange={(e) => setRowId(e.target.value)}>
              <option value="">{records ? t("Keiner – direkt in der Datenbank", "None – directly in the database") : t("Wird geladen …", "Loading …")}</option>
              {(records || []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title || t("Ohne Titel", "Untitled")}
                </option>
              ))}
            </Select>
          </label>
        )}
        {foreign && (
          <p className="callout move-page-note">
            {t("Die Seite und ihre Unterseiten wechseln den Arbeitsbereich. Rechte für Gruppen und Personen, die dort nicht Mitglied sind, entfallen; Datenbanken mit Relationen zu zurückbleibenden Datenbanken lassen sich erst nach dem Lösen der Relation verschieben.", "The page and its sub-pages change workspace. Permissions for groups and people who are not members there are dropped; databases with relations to databases staying behind can only be moved after removing the relation.")}
          </p>
        )}
        <button
          className="button primary"
          disabled={busy || !spaceId || !page}
          onClick={async () => {
            if (!page) return;
            // Into another space: first what the destination lacks (#136).
            if (spaceId !== page.space_id) {
              setBusy(true);
              const check = await api<{ foreign: ForeignMeta[] }>("/api/command", {
                action: "page.moveCheck",
                workspaceId: currentWorkspace,
                pageId: page.id,
                spaceId,
                ...(parentId ? { parentId } : {}),
              }).catch(() => ({ foreign: [] }));
              setBusy(false);
              if (check.foreign.length) {
                setChoices({});
                setResolve(check.foreign);
                return;
              }
            }
            await move();
          }}
        >
          {busy ? t("Wird verschoben …", "Moving …") : t("Verschieben", "Move")}
        </button>
      </div>
    </Modal>
  );
}
