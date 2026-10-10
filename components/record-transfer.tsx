"use client";
import { useEffect, useState } from "react";
import { ArrowSquareOut, Copy, ArrowsLeftRight, CopySimple, Trash } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal, PageIcon, api } from "./ui";
import { ContextMenu, type ContextMenuItem } from "./context-menu";

type Target = { id: string; title: string; icon: string };

// Right-click on a record (or several selected ones): open, duplicate,
// copy or move into another database, delete.
export function RecordMenu({
  x,
  y,
  count,
  editable,
  onOpen,
  onDuplicate,
  onTransfer,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  count: number;
  editable: boolean;
  onOpen?: () => void;
  onDuplicate: () => void;
  onTransfer: (mode: "copy" | "move") => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const many = count > 1;
  const items: ContextMenuItem[] = [];
  if (onOpen && !many) items.push({ icon: <ArrowSquareOut />, label: t("Öffnen", "Open"), run: onOpen });
  if (editable) items.push({ icon: <CopySimple />, label: many ? t(`${count} duplizieren`, `Duplicate ${count}`) : t("Duplizieren", "Duplicate"), run: onDuplicate });
  items.push({ icon: <Copy />, label: many ? t(`${count} kopieren nach …`, `Copy ${count} to …`) : t("Kopieren nach …", "Copy to …"), run: () => onTransfer("copy") });
  if (editable)
    items.push(
      { icon: <ArrowsLeftRight />, label: many ? t(`${count} verschieben nach …`, `Move ${count} to …`) : t("Verschieben nach …", "Move to …"), run: () => onTransfer("move") },
      "separator",
      { icon: <Trash />, label: many ? t(`${count} löschen`, `Delete ${count}`) : t("Löschen", "Delete"), run: onDelete, danger: true },
    );
  return <ContextMenu x={x} y={y} label={t("Eintrag", "Record")} items={items} onClose={onClose} />;
}

// Choosing the database to copy or move records into.
export function TransferDialog({
  pageId,
  rowIds,
  initialMode,
  canMove,
  act,
  onDone,
  onClose,
}: {
  pageId: string;
  rowIds: string[];
  initialMode: "copy" | "move";
  canMove: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
  onDone: (message: string, targetId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [target, setTarget] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState(canMove ? initialMode : "copy");
  const [addMissing, setAddMissing] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Target[]>(`/api/transfer-targets?page=${pageId}`)
      .then((list) => {
        setTargets(list);
        if (list.length === 1) setTarget(list[0].id);
      })
      .catch(() => setTargets([]));
  }, [pageId]);
  const shown = (targets || []).filter((x) => x.title.toLowerCase().includes(query.trim().toLowerCase()));
  const n = rowIds.length;
  return (
    <Modal open onClose={onClose} title={n > 1 ? t(`${n} Einträge ${mode === "move" ? "verschieben" : "kopieren"}`, `${mode === "move" ? "Move" : "Copy"} ${n} records`) : mode === "move" ? t("Eintrag verschieben", "Move record") : t("Eintrag kopieren", "Copy record")}>
      <form
        className="transfer-dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!target) return;
          setBusy(true);
          try {
            const result = (await act({ action: "rows.transfer", rowIds, targetPageId: target, mode, addMissing })) as { count: number; created: string[] } | null;
            if (!result) return;
            const name = targets?.find((x) => x.id === target)?.title || "";
            const what = result.count === 1 ? t("1 Eintrag", "1 record") : t(`${result.count} Einträge`, `${result.count} records`);
            onDone(
              mode === "move" ? t(`${what} nach „${name}“ verschoben.`, `${what} moved to “${name}”.`) : t(`${what} nach „${name}“ kopiert.`, `${what} copied to “${name}”.`),
              target,
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {canMove && (
          <div className="segmented" role="radiogroup" aria-label={t("Art", "Kind")}>
            <label data-active={mode === "copy"}>
              <input type="radio" name="transfer-mode" checked={mode === "copy"} onChange={() => setMode("copy")} />
              {t("Kopieren", "Copy")}
            </label>
            <label data-active={mode === "move"}>
              <input type="radio" name="transfer-mode" checked={mode === "move"} onChange={() => setMode("move")} />
              {t("Verschieben", "Move")}
            </label>
          </div>
        )}
        <p className="muted small">
          {mode === "move"
            ? t("Der Eintrag zieht mit Inhalt, Kommentaren, Versionen und Dateien um und bekommt in der Ziel-Datenbank eine neue Nummer.", "The record moves with its content, comments, versions and files and gets a new number in the target database.")
            : t("Die Kopie bekommt Inhalt und Dateien; das Original bleibt, wo es ist.", "The copy gets the content and files; the original stays where it is.")}
        </p>
        {targets && targets.length > 6 && (
          <input type="search" aria-label={t("Datenbank suchen", "Search database")} placeholder={t("Datenbank suchen …", "Search database …")} value={query} onChange={(e) => setQuery(e.target.value)} />
        )}
        <div className="transfer-targets" role="radiogroup" aria-label={t("Ziel-Datenbank", "Target database")}>
          {!targets ? (
            <p className="muted">{t("Wird geladen …", "Loading …")}</p>
          ) : !targets.length ? (
            <p className="muted">{t("Es gibt keine andere Datenbank, in die du schreiben darfst.", "There is no other database you may write to.")}</p>
          ) : (
            shown.map((x) => (
              <label key={x.id} className="transfer-target" data-active={target === x.id}>
                <input type="radio" name="transfer-target" checked={target === x.id} onChange={() => setTarget(x.id)} />
                <PageIcon name={x.icon} size={16} />
                <span>{x.title || t("Ohne Titel", "Untitled")}</span>
              </label>
            ))
          )}
        </div>
        <label className="checkbox-label">
          <input type="checkbox" checked={addMissing} onChange={(e) => setAddMissing(e.target.checked)} />
          {t("Fehlende Eigenschaften im Ziel anlegen", "Create missing properties in the target")}
        </label>
        <p className="muted small">
          {t("Eigenschaften werden nach Namen zugeordnet; fehlende Auswahl-Optionen kommen dazu.", "Properties are matched by name; missing select options are added.")}
        </p>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={busy || !target}>
            {busy ? t("Wird übertragen …", "Transferring …") : mode === "move" ? t("Verschieben", "Move") : t("Kopieren", "Copy")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
