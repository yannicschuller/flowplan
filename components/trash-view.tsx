"use client";
// The trash (#123): spaces, pages, records and files (#164) with "Wiederherstellen" and
// "Endgültig löschen", "Papierkorb leeren" for everything this person may
// delete, and how long things stay (Administration → Aufbewahrung, lib/trash.ts).
import { useCallback, useEffect, useState } from "react";
import { ArrowCounterClockwise, File as FileIcon, FileAudio, FileImage, FilePdf, FileVideo, Trash } from "@phosphor-icons/react";
import type { Bootstrap, Page, Space } from "@/lib/types";
import type { Locale } from "@/lib/i18n";
import { useT } from "./i18n";
import { api, Modal, PageIcon } from "./ui";
import { SpaceIcon } from "./space-appearance";
import { relativeTime } from "./home/format";

type Act = (b: Record<string, unknown>) => Promise<unknown>;
type RowEntry = { id: string; title: string; pageId: string; pageTitle: string; deletedAt: string };
type FileEntry = { id: string; name: string; mime: string; size: number; pageId: string; pageTitle: string; deletedAt: string };
type Summary = { pages: number; spaces: number; records: number; files?: number; days: number };

const DAY = 86_400_000;
const sqlTime = (value: string) =>
  new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : value.replace(" ", "T") + "Z").getTime();
// Whole days until the trash period ends (null: kept until emptied).
export function daysLeft(deletedAt: string, days: number, now: number) {
  if (!(days > 0)) return null;
  const at = sqlTime(deletedAt);
  if (!Number.isFinite(at)) return null;
  // Never more than the period (the clock may lag behind a fresh deletion).
  return Math.min(days, Math.max(0, Math.ceil((at + days * DAY - now) / DAY)));
}

function useLeft(days: number, clock: number | null) {
  const t = useT();
  return (deletedAt: string) => {
    if (clock === null) return null;
    const left = daysLeft(deletedAt, days, clock);
    if (left === null) return null;
    if (left === 0) return t("wird bald endgültig gelöscht", "will be deleted soon");
    if (left === 1) return t("noch 1 Tag", "1 day left");
    return t(`noch ${left} Tage`, `${left} days left`);
  };
}

export default function TrashView({
  boot,
  act,
  clock,
  locale,
  onOpenRecord,
  onPurgeSpace,
}: {
  boot: Bootstrap;
  act: Act;
  clock: number | null;
  locale: Locale;
  onOpenRecord: (pageId: string, rowId: string) => void;
  onPurgeSpace: (space: Space) => void;
}) {
  const t = useT();
  const days = boot.trashDays ?? 30;
  const left = useLeft(days, clock);
  const trashed = boot.pages.filter((p) => p.deleted_at);
  const [rowsVersion, setRowsVersion] = useState(0),
    [rowCount, setRowCount] = useState(0),
    [fileCount, setFileCount] = useState(0);
  const [purging, setPurging] = useState<Page | null>(null),
    [emptying, setEmptying] = useState<Summary | null>(null),
    [busy, setBusy] = useState(false);
  // Trashed sub-pages that go with a page.
  const subpages = (page: Page) => {
    const below = new Set<string>([page.id]);
    let grown = true;
    while (grown) {
      grown = false;
      for (const p of trashed)
        if (p.parent_id && below.has(p.parent_id) && !below.has(p.id)) {
          below.add(p.id);
          grown = true;
        }
    }
    return below.size - 1;
  };
  const empty = !trashed.length && !boot.trashedSpaces?.length && !rowCount && !fileCount;
  async function openEmpty() {
    try {
      setEmptying(await api<Summary>(`/api/trash/summary?workspace=${boot.workspace.id}`));
    } catch {
      setEmptying({ pages: trashed.length, spaces: boot.trashedSpaces?.length || 0, records: rowCount, files: fileCount, days });
    }
  }
  async function confirmEmpty() {
    setBusy(true);
    try {
      if (await act({ action: "trash.empty", workspaceId: boot.workspace.id })) {
        setEmptying(null);
        setRowsVersion((v) => v + 1);
      }
    } finally {
      setBusy(false);
    }
  }
  async function confirmPurge() {
    if (!purging) return;
    setBusy(true);
    try {
      if (await act({ action: "page.purge", pageId: purging.id })) setPurging(null);
    } finally {
      setBusy(false);
    }
  }
  const parts = (s: Summary) =>
    [
      s.pages && (s.pages === 1 ? t("1 Seite", "1 page") : t(`${s.pages} Seiten`, `${s.pages} pages`)),
      s.spaces && (s.spaces === 1 ? t("1 Bereich", "1 space") : t(`${s.spaces} Bereiche`, `${s.spaces} spaces`)),
      s.records && (s.records === 1 ? t("1 Eintrag", "1 record") : t(`${s.records} Einträge`, `${s.records} records`)),
      s.files && (s.files === 1 ? t("1 Datei", "1 file") : t(`${s.files} Dateien`, `${s.files} files`)),
    ].filter(Boolean) as string[];
  const purgeCount = purging ? subpages(purging) : 0;
  return (
    <div className="utility-content trash-view">
      <div className="utility-title">
        <Trash size={30} />
        <h1>{t("Papierkorb", "Trash")}</h1>
        <p>{t("Gelöschte Seiten, Bereiche, Einträge und Dateien kannst du wiederherstellen.", "You can restore deleted pages, spaces, records and files.")}</p>
      </div>
      <div className="trash-toolbar">
        <p className="muted trash-retention">
          {days > 0
            ? days === 1
              ? t("Wird nach 1 Tag endgültig gelöscht.", "Deleted permanently after 1 day.")
              : t(`Wird nach ${days} Tagen endgültig gelöscht.`, `Deleted permanently after ${days} days.`)
            : t("Bleibt im Papierkorb, bis du ihn leerst.", "Stays in the trash until you empty it.")}
        </p>
        {!empty && (
          <button className="button danger compact" onClick={() => void openEmpty()}>
            <Trash />
            {t("Papierkorb leeren", "Empty trash")}
          </button>
        )}
      </div>
      {(boot.trashedSpaces || []).map((space) => (
        <div className="utility-row trash-row trash-space" key={space.id}>
          <span className="trash-icon">
            <SpaceIcon icon={space.icon} color={space.icon_color} />
          </span>
          <strong>
            {space.name}
            <small>
              {t("Bereich mit Seiten", "Space with pages")}
              {space.deleted_at && left(space.deleted_at) && ` · ${left(space.deleted_at)}`}
            </small>
          </strong>
          <div className="lifecycle-buttons">
            <button
              className="button compact"
              onClick={() => act({ action: "space.restore", spaceId: space.id, version: space.version })}
            >
              {t("Bereich wiederherstellen", "Restore space")}
            </button>
            <button className="button danger compact" onClick={() => onPurgeSpace(space)}>
              {t("Endgültig löschen", "Delete permanently")}
            </button>
          </div>
        </div>
      ))}
      {trashed.map((p) => (
        <div className="utility-row trash-row" key={p.id} data-page-id={p.id}>
          <span className="trash-icon">
            <PageIcon name={p.icon} />
          </span>
          <strong className="trash-title">
            {p.title || t("Ohne Titel", "Untitled")}
            <small>
              {relativeTime(p.deleted_at!, clock, locale)}
              {left(p.deleted_at!) && ` · ${left(p.deleted_at!)}`}
            </small>
          </strong>
          <div className="lifecycle-buttons">
            <button className="button compact" onClick={() => act({ action: "page.restore", pageId: p.id })}>
              <ArrowCounterClockwise />
              {t("Wiederherstellen", "Restore")}
            </button>
            <button
              className="button danger compact"
              aria-label={t(`„${p.title}“ endgültig löschen`, `Delete “${p.title}” permanently`)}
              onClick={() => setPurging(p)}
            >
              {t("Endgültig löschen", "Delete permanently")}
            </button>
          </div>
        </div>
      ))}
      <RowTrash
        key={rowsVersion}
        workspaceId={boot.workspace.id}
        act={act}
        left={left}
        onCount={setRowCount}
        onOpen={onOpenRecord}
      />
      <FileTrash key={`files-${rowsVersion}`} workspaceId={boot.workspace.id} act={act} left={left} onCount={setFileCount} />
      {empty && (
        <div className="empty-state">
          <Trash size={38} />
          <h3>{t("Alles aufgeräumt", "All tidy")}</h3>
          <p>{t("Dein Papierkorb ist leer.", "Your trash is empty.")}</p>
        </div>
      )}
      <Modal
        open={!!purging}
        onClose={() => !busy && setPurging(null)}
        title={t("Endgültig löschen", "Delete permanently")}
      >
        <p>
          {purgeCount === 0
            ? t(`„${purging?.title}“ endgültig löschen?`, `Delete “${purging?.title}” permanently?`)
            : purgeCount === 1
              ? t(`„${purging?.title}“ und 1 Unterseite endgültig löschen?`, `Delete “${purging?.title}” and 1 sub-page permanently?`)
              : t(`„${purging?.title}“ und ${purgeCount} Unterseiten endgültig löschen?`, `Delete “${purging?.title}” and ${purgeCount} sub-pages permanently?`)}{" "}
          {t(
            "Inhalte, Versionen, Kommentare, Einträge und Dateien werden gelöscht. Das kann nicht rückgängig gemacht werden.",
            "Content, versions, comments, records and files are deleted. This cannot be undone.",
          )}
        </p>
        <div className="modal-actions">
          <button className="button" disabled={busy} onClick={() => setPurging(null)}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button danger" disabled={busy} onClick={() => void confirmPurge()}>
            {t("Endgültig löschen", "Delete permanently")}
          </button>
        </div>
      </Modal>
      <Modal
        open={!!emptying}
        onClose={() => !busy && setEmptying(null)}
        title={t("Papierkorb leeren", "Empty trash")}
      >
        {emptying && parts(emptying).length ? (
          <p>
            {t("Endgültig löschen:", "Delete permanently:")} {parts(emptying).join(", ")}.{" "}
            {t(
              "Nur was du löschen darfst; Seiten anderer, die du nur lesen kannst, bleiben. Das kann nicht rückgängig gemacht werden.",
              "Only what you may delete; pages of others you can only read stay. This cannot be undone.",
            )}
          </p>
        ) : (
          <p>{t("Im Papierkorb ist nichts, was du löschen darfst.", "There is nothing in the trash you may delete.")}</p>
        )}
        <div className="modal-actions">
          <button className="button" disabled={busy} onClick={() => setEmptying(null)}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button
            className="button danger"
            disabled={busy || !emptying || !parts(emptying).length}
            onClick={() => void confirmEmpty()}
          >
            {t("Papierkorb leeren", "Empty trash")}
          </button>
        </div>
      </Modal>
    </div>
  );
}

function RowTrash({
  workspaceId,
  act,
  left,
  onCount,
  onOpen,
}: {
  workspaceId: string;
  act: Act;
  left: (deletedAt: string) => string | null;
  onCount: (count: number) => void;
  onOpen: (pageId: string, rowId: string) => void;
}) {
  const t = useT();
  const [entries, setEntries] = useState<RowEntry[]>([]);
  const load = useCallback(() => {
    api<RowEntry[]>(`/api/trash/rows?workspace=${workspaceId}`)
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [workspaceId]);
  useEffect(load, [load]);
  useEffect(() => onCount(entries.length), [entries.length, onCount]);
  if (!entries.length) return null;
  return (
    <section className="row-trash" aria-label={t("Gelöschte Einträge", "Deleted records")}>
      <h2>{t("Gelöschte Einträge", "Deleted records")}</h2>
      {entries.map((e) => (
        <div className="utility-row trash-row" key={e.id}>
          <span className="trash-icon">
            <PageIcon name="file" />
          </span>
          <strong className="trash-title">
            {e.title}
            <small>
              {t("aus", "from")} {e.pageTitle}
              {left(e.deletedAt) && ` · ${left(e.deletedAt)}`}
            </small>
          </strong>
          <div className="lifecycle-buttons">
            <button
              className="button compact"
              onClick={async () => {
                if (await act({ action: "row.trash.restore", trashId: e.id })) {
                  load();
                  onOpen(e.pageId, e.id);
                }
              }}
            >
              <ArrowCounterClockwise />
              {t("Wiederherstellen", "Restore")}
            </button>
            <button
              className="button danger compact"
              onClick={async () => {
                if (await act({ action: "row.trash.purge", trashId: e.id })) load();
              }}
            >
              {t("Endgültig löschen", "Delete permanently")}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

const fileIcon = (mime: string) =>
  mime.startsWith("image/")
    ? FileImage
    : mime.startsWith("video/")
      ? FileVideo
      : mime.startsWith("audio/")
        ? FileAudio
        : mime === "application/pdf"
          ? FilePdf
          : FileIcon;

// Files deleted in the media library (#164, lib/file-trash.ts): not served
// while here, so no preview – name, type, page and how long they stay.
function FileTrash({
  workspaceId,
  act,
  left,
  onCount,
}: {
  workspaceId: string;
  act: Act;
  left: (deletedAt: string) => string | null;
  onCount: (count: number) => void;
}) {
  const t = useT();
  const [entries, setEntries] = useState<FileEntry[]>([]),
    [purging, setPurging] = useState<FileEntry | null>(null),
    [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<FileEntry[]>(`/api/trash/files?workspace=${workspaceId}`)
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [workspaceId]);
  useEffect(load, [load]);
  useEffect(() => onCount(entries.length), [entries.length, onCount]);
  async function confirmPurge() {
    if (!purging) return;
    setBusy(true);
    try {
      if (await act({ action: "file.purge", fileId: purging.id })) {
        setPurging(null);
        load();
      }
    } finally {
      setBusy(false);
    }
  }
  if (!entries.length) return null;
  return (
    <section className="row-trash file-trash" aria-label={t("Gelöschte Dateien", "Deleted files")}>
      <h2>{t("Gelöschte Dateien", "Deleted files")}</h2>
      {entries.map((e) => {
        const Icon = fileIcon(e.mime);
        return (
          <div className="utility-row trash-row" key={e.id} data-file-id={e.id}>
            <span className="trash-icon">
              <Icon size={18} />
            </span>
            <strong className="trash-title">
              {e.name}
              <small>
                {t("aus", "from")} {e.pageTitle}
                {left(e.deletedAt) && ` · ${left(e.deletedAt)}`}
              </small>
            </strong>
            <div className="lifecycle-buttons">
              <button
                className="button compact"
                onClick={async () => {
                  if (await act({ action: "file.restore", fileId: e.id })) load();
                }}
              >
                <ArrowCounterClockwise />
                {t("Wiederherstellen", "Restore")}
              </button>
              <button
                className="button danger compact"
                aria-label={t(`„${e.name}“ endgültig löschen`, `Delete “${e.name}” permanently`)}
                onClick={() => setPurging(e)}
              >
                {t("Endgültig löschen", "Delete permanently")}
              </button>
            </div>
          </div>
        );
      })}
      <Modal open={!!purging} onClose={() => !busy && setPurging(null)} title={t("Endgültig löschen", "Delete permanently")}>
        <p>
          {t(`„${purging?.name}“ endgültig löschen?`, `Delete “${purging?.name}” permanently?`)}{" "}
          {t(
            "Die Datei wird auch aus dem Speicher gelöscht. Seiten und ältere Versionen, die sie noch zeigen, zeigen dann einen Platzhalter. Das kann nicht rückgängig gemacht werden.",
            "The file is also removed from storage. Pages and older versions that still show it then show a placeholder. This cannot be undone.",
          )}
        </p>
        <div className="modal-actions">
          <button className="button" disabled={busy} onClick={() => setPurging(null)}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button danger" disabled={busy} onClick={() => void confirmPurge()}>
            {t("Endgültig löschen", "Delete permanently")}
          </button>
        </div>
      </Modal>
    </section>
  );
}
