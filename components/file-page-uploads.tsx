"use client";
// Files uploaded straight into a space (#569, lib/file-page-uploads.ts):
// the hidden file picker ("Datei hochladen …") and a small panel at the
// bottom of the window with every file of the queue – its name, the
// upload's progress ("37 % · 12 MB of 48 MB", as in documents, #561), a
// cancel button, and once its page exists a button that opens it. A
// refused file keeps its line with the reason until the panel is closed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, UploadSimple, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { endedSession, Modal } from "./ui";
import { Select } from "./select";
import { compressImage } from "@/lib/image-compress";
import { idempotencyHeaders } from "@/lib/idempotency-key";
import { sizeText } from "@/lib/size-text";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { Page, Space } from "@/lib/types";
import {
  filePageUploads,
  sendFilePage,
  type CreatedFilePage,
  type FilePagePlace,
  type FilePageUpload,
  type FilePageUploader,
} from "@/lib/file-page-uploads";

// The bar's share as a custom property: no style attribute (CSP).
function Bar({ share, label, text }: { share: number; label: string; text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => ref.current?.style.setProperty("--upload-share", String(share)), [share]);
  return (
    <span
      ref={ref}
      className="upload-placeholder-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      aria-valuetext={text}
    >
      <span className="upload-placeholder-fill" />
    </span>
  );
}

export function useFilePageUploads({ onCreated, onOpen }: { onCreated: (page: CreatedFilePage) => void; onOpen: (pageId: string) => void }) {
  const t = useT();
  const [items, setItems] = useState<FilePageUpload[]>([]);
  const created = useRef(onCreated);
  created.current = onCreated;
  const texts = useRef(t);
  texts.current = t;
  const uploader = useMemo<FilePageUploader>(
    () =>
      filePageUploads({
        send: sendFilePage(idempotencyHeaders, (status) => endedSession("/api/upload", status)),
        prepare: compressImage,
        onChange: setItems,
        onCreated: (page) => created.current(page),
        onIdle: (done) => {
          const made = done.filter((i) => i.state === "done").length;
          const tr = texts.current;
          setNote(made === 1 ? tr("1 Seite aus einer Datei angelegt", "1 page created from a file") : made ? tr(`${made} Seiten aus Dateien angelegt`, `${made} pages created from files`) : "");
        },
      }),
    [],
  );
  // A polite line for screen readers once the queue is through.
  const [note, setNote] = useState("");
  // Done without a refusal: the panel goes after a moment.
  const idle = items.length > 0 && !items.some((i) => i.state === "waiting" || i.state === "uploading");
  const refused = items.some((i) => i.state === "failed");
  useEffect(() => {
    if (!idle || refused) return;
    const timer = setTimeout(() => uploader.clear(), 6000);
    return () => clearTimeout(timer);
  }, [idle, refused, uploader]);
  // Leaving the app while files go up: the browser asks first.
  const busy = items.some((i) => i.state === "waiting" || i.state === "uploading");
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const input = useRef<HTMLInputElement>(null);
  const target = useRef<FilePagePlace | null>(null);
  const upload = useCallback(
    (files: File[], place: FilePagePlace) => {
      if (files.length) uploader.add(files, place);
    },
    [uploader],
  );
  // Opens the system's file picker (several files); call it from a click.
  const pick = useCallback((place: FilePagePlace) => {
    target.current = place;
    if (input.current) input.current.value = "";
    input.current?.click();
  }, []);

  const of = (loaded: number, total: number) => t(`${sizeText(loaded)} von ${sizeText(total)}`, `${sizeText(loaded)} of ${sizeText(total)}`);
  const percent = (share: number) => new Intl.NumberFormat(LOCALE_TAG, { style: "percent", maximumFractionDigits: 0 }).format(share);
  const done = items.filter((i) => i.state === "done").length;
  const active = items.filter((i) => i.state === "waiting" || i.state === "uploading").length;
  const panel = (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="file-page-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (target.current && files.length) upload(files, target.current);
          e.target.value = "";
        }}
      />
      <p className="sr-only" role="status" aria-live="polite">
        {note}
      </p>
      {items.length > 0 && (
        <section className="file-page-uploads" aria-label={t("Dateien als Seiten hochladen", "Uploading files as pages")}>
          <header className="file-page-uploads-head">
            <strong>
              {active
                ? t(`Hochladen … ${done} von ${items.length}`, `Uploading … ${done} of ${items.length}`)
                : done === 1
                  ? t("1 Seite angelegt", "1 page created")
                  : t(`${done} Seiten angelegt`, `${done} pages created`)}
            </strong>
            {active > 1 && (
              <button type="button" className="text-button" onClick={() => uploader.cancelAll()}>
                {t("Alle abbrechen", "Cancel all")}
              </button>
            )}
            {!active && (
              <button type="button" className="icon-button" aria-label={t("Schließen", "Close")} title={t("Schließen", "Close")} onClick={() => uploader.clear()}>
                <X size={14} />
              </button>
            )}
          </header>
          <ul>
            {items.map((item) => {
              const share = item.size > 0 ? Math.min(1, item.loaded / item.size) : 0;
              const going = item.state === "waiting" || item.state === "uploading";
              return (
                <li key={item.key} className="file-page-upload" data-state={item.state}>
                  <span className="upload-placeholder-name" title={item.name}>
                    {item.name}
                  </span>
                  {going && (
                    <Bar
                      share={share}
                      label={t(`Hochladen von „${item.name}“`, `Uploading “${item.name}”`)}
                      text={`${percent(share)} – ${of(item.loaded, item.size)}`}
                    />
                  )}
                  <span className="upload-placeholder-status">
                    {item.state === "waiting"
                      ? t("Wartet", "Waiting")
                      : item.state === "uploading"
                        ? `${percent(share)} · ${of(item.loaded, item.size)}`
                        : item.state === "done"
                          ? t("Seite angelegt", "Page created")
                          : item.state === "cancelled"
                            ? t("Abgebrochen", "Cancelled")
                            : ""}
                  </span>
                  {item.state === "failed" && (
                    <span className="file-page-upload-error" role="alert">
                      {item.error || t("Hochladen fehlgeschlagen.", "Upload failed.")}
                    </span>
                  )}
                  {going && (
                    <button
                      type="button"
                      className="upload-placeholder-cancel"
                      aria-label={t(`Hochladen von „${item.name}“ abbrechen`, `Cancel uploading “${item.name}”`)}
                      title={t(`Hochladen von „${item.name}“ abbrechen`, `Cancel uploading “${item.name}”`)}
                      onClick={() => uploader.cancel(item.key)}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  )}
                  {item.state === "done" && item.page && (
                    <button
                      type="button"
                      className="upload-placeholder-cancel"
                      aria-label={t(`„${item.page.title}“ öffnen`, `Open “${item.page.title}”`)}
                      title={t(`„${item.page.title}“ öffnen`, `Open “${item.page.title}”`)}
                      onClick={() => onOpen(item.page!.id)}
                    >
                      <ArrowSquareOut size={14} aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
  return { upload, pick, panel, busy };
}

// The media view's "Hochladen …" (#569): where the pages go – a space and,
// if wanted, a page of it – then the file picker.
export function FilePageUploadDialog({
  open,
  onClose,
  spaces,
  pages,
  spaceId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  spaces: Pick<Space, "id" | "name">[];
  pages: Pick<Page, "id" | "title" | "space_id" | "parent_id" | "position" | "journal_date">[];
  spaceId: string;
  onPick: (spaceId: string, parentId: string | null) => void;
}) {
  const t = useT();
  const [space, setSpace] = useState(spaceId);
  const [parent, setParent] = useState("");
  const [shown, setShown] = useState(false);
  // Opened anew: the space one is in, the top level.
  if (open !== shown) {
    setShown(open);
    if (open) {
      setSpace(spaces.some((s) => s.id === spaceId) ? spaceId : spaces[0]?.id || "");
      setParent("");
    }
  }
  // The pages of the space in the order of the tree, indented by level.
  const options = useMemo(() => {
    const inSpace = pages.filter((p) => p.space_id === space && !p.journal_date);
    const ids = new Set(inSpace.map((p) => p.id));
    const children = new Map<string | null, typeof inSpace>();
    for (const p of inSpace) {
      const key = p.parent_id && ids.has(p.parent_id) ? p.parent_id : null;
      children.set(key, [...(children.get(key) || []), p]);
    }
    const out: { id: string; title: string; level: number }[] = [];
    const walk = (key: string | null, level: number) => {
      for (const p of [...(children.get(key) || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
        if (out.length >= 500) return;
        out.push({ id: p.id, title: p.title, level: Math.min(level, 6) });
        walk(p.id, level + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [pages, space]);
  return (
    <Modal open={open} sheet onClose={onClose} title={t("Dateien als Seiten hochladen", "Upload files as pages")}>
      <form
        className="move-page-dialog file-page-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (space) onPick(space, parent || null);
        }}
      >
        <p className="muted">
          {t("Jede Datei wird eine eigene Seite mit ihrer Vorschau – darunter kannst du weiterschreiben.", "Each file becomes a page of its own with its preview – you can keep writing below it.")}
        </p>
        <label>
          {t("Bereich", "Space")}
          <Select
            value={space}
            onChange={(e) => {
              setSpace(e.target.value);
              setParent("");
            }}
          >
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          {t("Unter der Seite (optional)", "Below the page (optional)")}
          <Select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">{t("Oberste Ebene des Bereichs", "Top level of the space")}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {" ".repeat(o.level)}
                {o.title || t("Ohne Titel", "Untitled")}
              </option>
            ))}
          </Select>
        </label>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={!space}>
            <UploadSimple size={15} aria-hidden="true" />
            {t("Dateien wählen …", "Choose files…")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
