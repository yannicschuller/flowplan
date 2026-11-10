"use client";
// The dialogs of the page overview: a title (rename a sheet, mark it as a
// chapter), copy or move sheets into another notebook, a link on a sheet
// (to another sheet or any page), and the deleted sheets.
import { useEffect, useMemo, useState } from "react";
import { ArrowCounterClockwise, FileText, FolderSimple, Notebook } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { api, Modal } from "../ui";
import { Select } from "../select";
import { cleanTitle, type NotebookLink, type NotebookLinkTarget } from "@/lib/notebook-organize-model";
import type { NotebookSheet } from "@/lib/notebook";
import type { InkDoc } from "@/lib/ink/model";
import { peerPath, usePeers, type NotebookPeer } from "./notebook-peers";

export function TitleDialog({
  open,
  title,
  label,
  initial,
  hint,
  submit,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  hint?: string;
  submit: string;
  onClose: () => void;
  onSave: (value: string) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  return (
    <Modal open={open} onClose={onClose} title={title} className="notebook-title-dialog">
      <form
        className="notebook-paper-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(cleanTitle(value));
        }}
      >
        <label className="notebook-field">
          {label}
          <input autoFocus value={value} maxLength={200} onChange={(e) => setValue(e.target.value)} />
        </label>
        {hint && <p className="notebook-insert-hint">{hint}</p>}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="submit" className="button primary">
            {submit}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// A searchable list of pages (the notebook's workspace).
function PeerList({
  peers,
  filter,
  value,
  onPick,
  label,
}: {
  peers: NotebookPeer[];
  filter: (p: NotebookPeer) => boolean;
  value: string;
  onPick: (id: string) => void;
  label: string;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return peers.filter(filter).filter((p) => !q || peerPath(peers, p).toLowerCase().includes(q)).slice(0, 200);
  }, [peers, filter, query]);
  return (
    <div className="notebook-peers">
      <input type="search" value={query} placeholder={t("Suchen …", "Search …")} aria-label={t("Seiten durchsuchen", "Search pages")} onChange={(e) => setQuery(e.target.value)} />
      <ul role="listbox" aria-label={label}>
        {list.map((p) => (
          <li key={p.id}>
            <button type="button" role="option" aria-selected={p.id === value} className={p.id === value ? "chosen" : ""} onClick={() => onPick(p.id)}>
              {p.kind === "notebook" ? <Notebook size={16} /> : p.kind === "document" ? <FileText size={16} /> : <FolderSimple size={16} />}
              <span>{peerPath(peers, p)}</span>
            </button>
          </li>
        ))}
        {!list.length && <li className="notebook-peers-empty">{t("Nichts gefunden.", "Nothing found.")}</li>}
      </ul>
    </div>
  );
}

export function TransferDialog({
  open,
  pageId,
  count,
  canMove,
  onClose,
  onTransfer,
}: {
  open: boolean;
  pageId: string;
  count: number;
  canMove: boolean;
  onClose: () => void;
  onTransfer: (target: string, mode: "copy" | "move", place: "start" | "end") => void;
}) {
  const t = useT();
  const { peers, error } = usePeers(pageId, open);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<"copy" | "move">("move");
  const [place, setPlace] = useState<"start" | "end">("end");
  useEffect(() => {
    if (open) setMode(canMove ? "move" : "copy");
  }, [open, canMove]);
  const writable = useMemo(() => (peers || []).filter((p) => p.writable), [peers]);
  return (
    <Modal open={open} onClose={onClose} title={t(count === 1 ? "Blatt in anderes Notizbuch" : `${count} Blätter in anderes Notizbuch`, count === 1 ? "Sheet to another notebook" : `${count} sheets to another notebook`)} className="notebook-transfer-dialog">
      <div className="notebook-paper-form">
        <fieldset>
          <legend>{t("Aktion", "Action")}</legend>
          <label>
            <input type="radio" name="notebook-transfer" checked={mode === "move"} disabled={!canMove} onChange={() => setMode("move")} />
            {t("Verschieben", "Move")}
          </label>
          <label>
            <input type="radio" name="notebook-transfer" checked={mode === "copy"} onChange={() => setMode("copy")} />
            {t("Kopieren", "Copy")}
          </label>
        </fieldset>
        <div>
          <p className="notebook-field-label">{t("Ziel", "Destination")}</p>
          {error ? (
            <p className="notebook-insert-hint">{error}</p>
          ) : !peers ? (
            <p className="notebook-insert-hint">{t("Notizbücher werden geladen …", "Loading notebooks …")}</p>
          ) : writable.length ? (
            <PeerList peers={peers} filter={(p) => p.writable} value={target} onPick={setTarget} label={t("Notizbücher", "Notebooks")} />
          ) : (
            <p className="notebook-insert-hint">{t("Kein anderes Notizbuch, in das du schreiben darfst.", "No other notebook you may write in.")}</p>
          )}
        </div>
        <label className="notebook-insert-place">
          {t("Einfügen", "Insert")}
          <Select value={place} onChange={(e) => setPlace(e.target.value as "start" | "end")}>
            <option value="end">{t("Am Ende", "At the end")}</option>
            <option value="start">{t("Vor dem ersten Blatt", "Before the first sheet")}</option>
          </Select>
        </label>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="button" className="button primary" disabled={!target} onClick={() => onTransfer(target, mode, place)}>
            {mode === "move" ? t("Verschieben", "Move") : t("Kopieren", "Copy")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function LinkDialog({
  open,
  pageId,
  sheets,
  sheetId,
  link,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  pageId: string;
  sheets: NotebookSheet[];
  // The sheet the link is on.
  sheetId: string;
  // The link to change, or null for a new one.
  link: NotebookLink | null;
  onClose: () => void;
  onSave: (value: { label: string; target: NotebookLinkTarget; area: boolean }) => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<"sheet" | "page">("sheet");
  const [sheet, setSheet] = useState("");
  const [page, setPage] = useState("");
  const [label, setLabel] = useState("");
  const [area, setArea] = useState(false);
  const { peers, error } = usePeers(pageId, open && kind === "page");
  useEffect(() => {
    if (!open) return;
    const others = sheets.filter((s) => s.id !== sheetId);
    setKind(link && "page" in link.target ? "page" : "sheet");
    setSheet(link && "sheet" in link.target ? link.target.sheet : others[0]?.id || "");
    setPage(link && "page" in link.target ? link.target.page : "");
    setLabel(link?.label || "");
    setArea(!!link && !link.label);
  }, [open, link, sheets, sheetId]);
  const target: NotebookLinkTarget | null = kind === "sheet" ? (sheet ? { sheet } : null) : page ? { page } : null;
  return (
    <Modal open={open} onClose={onClose} title={link ? t("Link bearbeiten", "Edit link") : t("Link einfügen", "Insert link")} className="notebook-link-dialog">
      <div className="notebook-paper-form">
        <fieldset>
          <legend>{t("Ziel", "Destination")}</legend>
          <label>
            <input type="radio" name="notebook-link-kind" checked={kind === "sheet"} onChange={() => setKind("sheet")} />
            {t("Blatt in diesem Notizbuch", "Sheet in this notebook")}
          </label>
          <label>
            <input type="radio" name="notebook-link-kind" checked={kind === "page"} onChange={() => setKind("page")} />
            {t("Seite in Flowplan", "Page in Flowplan")}
          </label>
        </fieldset>
        {kind === "sheet" ? (
          <label className="notebook-insert-place">
            {t("Blatt", "Sheet")}
            <Select value={sheet} onChange={(e) => setSheet(e.target.value)}>
              {sheets.map((s, i) =>
                s.id === sheetId ? null : (
                  <option key={s.id} value={s.id}>
                    {t(`Blatt ${i + 1}`, `Sheet ${i + 1}`)}
                    {s.title ? ` – ${s.title}` : ""}
                  </option>
                ),
              )}
            </Select>
          </label>
        ) : error ? (
          <p className="notebook-insert-hint">{error}</p>
        ) : peers ? (
          <PeerList peers={peers} filter={(p) => p.id !== pageId} value={page} onPick={setPage} label={t("Seiten", "Pages")} />
        ) : (
          <p className="notebook-insert-hint">{t("Seiten werden geladen …", "Loading pages …")}</p>
        )}
        <fieldset>
          <legend>{t("Aussehen", "Appearance")}</legend>
          <label>
            <input type="radio" name="notebook-link-look" checked={!area} onChange={() => setArea(false)} />
            {t("Text", "Text")}
          </label>
          <label>
            <input type="radio" name="notebook-link-look" checked={area} onChange={() => setArea(true)} />
            {t("Bereich (über der Handschrift)", "Area (over the handwriting)")}
          </label>
        </fieldset>
        {!area && (
          <label className="notebook-field">
            {t("Text des Links", "Link text")}
            <input value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} placeholder={t("z. B. Zu Kapitel 2", "e.g. To chapter 2")} />
          </label>
        )}
        <p className="notebook-insert-hint">
          {t("Ziehen verschiebt den Link, die Ecke unten rechts ändert die Größe.", "Drag to move the link, the corner at the bottom right resizes it.")}
        </p>
        <div className="modal-actions">
          {onDelete && (
            <button type="button" className="button danger" onClick={onDelete}>
              {t("Link entfernen", "Remove link")}
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!target || (!area && !cleanTitle(label))}
            onClick={() => target && onSave({ label: area ? "" : cleanTitle(label), target, area })}
          >
            {t("Speichern", "Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export type TrashedSheet = { id: string; sheet: string; position: number; deletedAt: number; deletedBy: string | null; title: string; ink: InkDoc | null };
export function TrashDialog({ open, pageId, onClose, onRestore }: { open: boolean; pageId: string; onClose: () => void; onRestore: (ids: string[]) => Promise<boolean> }) {
  const t = useT();
  const [list, setList] = useState<TrashedSheet[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setList(null);
    setError("");
    api<{ trash: TrashedSheet[] }>(`/api/pages/${pageId}/notebook?part=trash`)
      .then((r) => setList(r.trash))
      .catch((e) => setError((e as Error).message));
  }, [open, pageId]);
  const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <Modal open={open} onClose={onClose} title={t("Gelöschte Blätter", "Deleted sheets")} className="notebook-trash-dialog">
      <div className="notebook-paper-form">
        <p className="notebook-insert-hint">{t("Gelöschte Blätter bleiben 30 Tage hier und kommen an ihre alte Stelle zurück.", "Deleted sheets stay here for 30 days and go back to their former place.")}</p>
        {error ? (
          <p className="notebook-insert-hint">{error}</p>
        ) : !list ? (
          <p className="notebook-insert-hint">{t("Wird geladen …", "Loading …")}</p>
        ) : list.length ? (
          <ul className="notebook-trash-list">
            {list.map((item) => (
              <li key={item.id}>
                <span>
                  <strong>{item.title || t(`Blatt ${item.position + 1}`, `Sheet ${item.position + 1}`)}</strong>
                  <span className="notebook-insert-hint">
                    {item.deletedBy ? t(`${when(item.deletedAt)} von ${item.deletedBy}`, `${when(item.deletedAt)} by ${item.deletedBy}`) : when(item.deletedAt)}
                  </span>
                </span>
                <button
                  type="button"
                  className="button"
                  onClick={async () => {
                    if (await onRestore([item.id])) setList((l) => (l || []).filter((x) => x.id !== item.id));
                  }}
                >
                  <ArrowCounterClockwise size={15} /> {t("Wiederherstellen", "Restore")}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t("Keine gelöschten Blätter.", "No deleted sheets.")}</p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Schließen", "Close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
