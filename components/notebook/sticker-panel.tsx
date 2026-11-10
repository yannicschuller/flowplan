"use client";
// The sticker panel of a notebook: Flowplan's own stickers (lib/ink/stickers.ts,
// pictures in public/stickers), stamps with today's date or the time (ink:
// text in a frame), and the person's own collection in this workspace –
// pictures and lasso selections saved as stickers (lib/notebook-library.ts).
import { useCallback, useEffect, useState } from "react";
import { Calendar, Clock, PencilSimple, Trash } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { api, Modal } from "../ui";
import type { InkEditor } from "../ink/use-ink-editor";
import { copyItems } from "@/lib/ink/geometry";
import { STICKERS, stampItems } from "@/lib/ink/stickers";
import { inkSvg } from "@/lib/ink/svg";
import { insertOwnSticker, listStickers, saveSelectionAsSticker, type StickerEntry } from "./notebook-media";
import type { NotebookInsert } from "./notebook-insert";

const PX = 0.75;
// The size a built-in sticker gets on a sheet (points).
const stickerSize = (id: string) => (id.startsWith("note-") ? 150 : id === "tape" ? 130 : 64);

export function useStickerNames() {
  const t = useT();
  return useCallback(
    (id: string) =>
      ({
        arrow: t("Pfeil", "Arrow"),
        "arrow-curved": t("Bogenpfeil", "Curved arrow"),
        check: t("Häkchen", "Check mark"),
        cross: t("Kreuz", "Cross"),
        star: t("Stern", "Star"),
        heart: t("Herz", "Heart"),
        warning: t("Achtung", "Warning"),
        info: t("Info", "Info"),
        question: t("Frage", "Question"),
        idea: t("Idee", "Idea"),
        pin: t("Reißzwecke", "Pin"),
        flag: t("Fähnchen", "Flag"),
        smiley: t("Smiley", "Smiley"),
        "note-yellow": t("Haftnotiz gelb", "Sticky note yellow"),
        "note-pink": t("Haftnotiz rosa", "Sticky note pink"),
        "note-blue": t("Haftnotiz blau", "Sticky note blue"),
        "note-green": t("Haftnotiz grün", "Sticky note green"),
        tape: t("Klebeband", "Tape"),
      })[id] || id,
    [t],
  );
}

export function StickerPanel({
  open,
  onClose,
  pageId,
  editor,
  insert,
  current,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  pageId: string;
  editor: InkEditor;
  insert: NotebookInsert;
  current: () => string;
  onError: (message: string) => void;
}) {
  const t = useT();
  const name = useStickerNames();
  const [tab, setTab] = useState<"builtin" | "own">("builtin");
  const [own, setOwn] = useState<StickerEntry[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const load = useCallback(async () => {
    try {
      setOwn(await listStickers(pageId));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError, pageId]);
  useEffect(() => {
    if (open && tab === "own") void load();
  }, [load, open, tab]);
  const selected = editor.selectedItems();

  const builtin = (id: string) => {
    onClose();
    const tint = STICKERS.find((s) => s.id === id)?.tint;
    // One-colour stickers take the pen's colour when it is not the default black.
    const color = tint && editor.style.color !== "#1f1f1f" ? editor.style.color : undefined;
    const side = stickerSize(id);
    insert.place(current(), { sticker: id, ...(color ? { color } : {}) }, { width: side, height: side });
  };
  const stamp = (kind: "date" | "time") => {
    onClose();
    const sheet = current();
    const at = insert.visibleCentre(sheet) || { x: 72, y: 72 };
    const now = new Date();
    const text = kind === "date" ? now.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" }) : now.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
    const items = stampItems(text, { x: at.x - text.length * 4.5, y: at.y - 8 }, editor.style.color === "#1f1f1f" ? "#e03131" : editor.style.color);
    editor.change(sheet, (list) => [...list, ...items]);
    editor.setTool("lasso");
    editor.setSelection({ page: sheet, ids: items.map((i) => i.id) });
  };
  const ownSticker = async (sticker: StickerEntry) => {
    onClose();
    const sheet = current();
    try {
      const answer = await insertOwnSticker(sticker.id, pageId);
      if (answer.kind === "image") {
        const scale = Math.min(1, 160 / Math.max(answer.width * PX, answer.height * PX));
        insert.place(sheet, { file: answer.fileId }, { width: answer.width * PX * scale, height: answer.height * PX * scale });
      } else {
        const at = insert.visibleCentre(sheet) || { x: 72, y: 72 };
        const copies = copyItems(answer.items, at.x - answer.width / 2, at.y - answer.height / 2);
        editor.change(sheet, (list) => [...list, ...copies]);
        editor.setTool("lasso");
        editor.setSelection({ page: sheet, ids: copies.map((c) => c.id) });
      }
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const saveSelection = async () => {
    try {
      await saveSelectionAsSticker(selected, pageId, t("Auswahl", "Selection"));
      setTab("own");
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const rename = async () => {
    if (!renaming) return;
    const entry = renaming;
    setRenaming(null);
    if (!entry.name.trim()) return;
    try {
      await api("/api/command", { action: "notebook.sticker.rename", stickerId: entry.id, name: entry.name.trim() });
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const remove = async (sticker: StickerEntry) => {
    try {
      await api("/api/command", { action: "notebook.sticker.delete", stickerId: sticker.id });
      setOwn((list) => list?.filter((s) => s.id !== sticker.id) ?? null);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t("Sticker", "Stickers")} className="notebook-sticker-dialog" sheet>
      <div className="notebook-sticker-tabs" role="tablist" aria-label={t("Sticker", "Stickers")}>
        <button type="button" role="tab" aria-selected={tab === "builtin"} className={tab === "builtin" ? "active" : ""} onClick={() => setTab("builtin")}>
          {t("Flowplan", "Flowplan")}
        </button>
        <button type="button" role="tab" aria-selected={tab === "own"} className={tab === "own" ? "active" : ""} onClick={() => setTab("own")}>
          {t("Meine Sticker", "My stickers")}
        </button>
      </div>
      {tab === "builtin" ? (
        <>
          <div className="notebook-library-grid is-stickers" role="list">
            {STICKERS.map((sticker) => (
              <button key={sticker.id} type="button" role="listitem" className="notebook-library-tile" title={name(sticker.id)} aria-label={name(sticker.id)} onClick={() => builtin(sticker.id)}>
                <img src={`/stickers/${sticker.id}.svg`} alt="" width={56} height={56} />
              </button>
            ))}
          </div>
          <div className="notebook-sticker-stamps">
            <button type="button" className="button" onClick={() => stamp("date")}>
              <Calendar size={16} /> {t("Datumsstempel", "Date stamp")}
            </button>
            <button type="button" className="button" onClick={() => stamp("time")}>
              <Clock size={16} /> {t("Zeitstempel", "Time stamp")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="notebook-library-hint">
            {t(
              "Nur du siehst deine Sticker, in jedem Notizbuch dieses Arbeitsbereichs. Speichere ein Bild über seinen Rahmen oder eine Lasso-Auswahl hier als Sticker.",
              "Only you see your stickers, in every notebook of this workspace. Save a picture from its frame, or a lasso selection here, as a sticker.",
            )}
          </p>
          <button type="button" className="button" disabled={!selected.length} onClick={() => void saveSelection()}>
            {t("Auswahl als Sticker speichern", "Save selection as sticker")}
          </button>
          {own && !own.length && <p className="notebook-library-empty">{t("Noch keine eigenen Sticker.", "No stickers of your own yet.")}</p>}
          <div className="notebook-library-grid is-stickers">
            {own?.map((sticker) => (
              <div key={sticker.id} className="notebook-library-item">
                <button type="button" className="notebook-library-tile" title={sticker.name} aria-label={sticker.name} onClick={() => void ownSticker(sticker)}>
                  {sticker.url ? (
                    <img src={sticker.url} alt="" />
                  ) : (
                    <span
                      className="notebook-library-ink"
                      dangerouslySetInnerHTML={{ __html: inkSvg(sticker.items || [], { width: Math.max(1, sticker.width), height: Math.max(1, sticker.height) }) }}
                    />
                  )}
                </button>
                {renaming?.id === sticker.id ? (
                  <input
                    autoFocus
                    className="input notebook-library-name"
                    aria-label={t("Name des Stickers", "Sticker name")}
                    value={renaming.name}
                    maxLength={120}
                    onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void rename();
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                    onBlur={() => void rename()}
                  />
                ) : (
                  <span className="notebook-library-name">{sticker.name}</span>
                )}
                <span className="notebook-library-actions">
                  <button type="button" className="icon-button" aria-label={t(`${sticker.name} umbenennen`, `Rename ${sticker.name}`)} onClick={() => setRenaming({ id: sticker.id, name: sticker.name })}>
                    <PencilSimple size={14} />
                  </button>
                  <button type="button" className="icon-button" aria-label={t(`${sticker.name} löschen`, `Delete ${sticker.name}`)} onClick={() => void remove(sticker)}>
                    <Trash size={14} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
