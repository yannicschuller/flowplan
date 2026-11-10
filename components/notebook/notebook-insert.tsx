"use client";
// Putting pictures and stickers on notebook sheets: the "Insert" menu of
// the notebook bar (picture from a file, a photo with the camera, a picture
// already attached to the page, stickers), pasting a picture (⌘V) and
// dropping files onto a sheet. A new picture lands in the middle of what
// is visible of the current sheet (dropped: where it was dropped), in its
// frame, ready to move, resize, turn or crop (components/ink/ink-image.tsx).
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Image as ImageIcon, Images, Plus, Sticker } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal } from "../ui";
import { useMenuPlacement } from "../ink/menu-placement";
import type { InkEditor } from "../ink/use-ink-editor";
import { clientToPage, type PageSize } from "@/lib/ink/coords";
import { placeImage } from "@/lib/ink/image";
import { inkId, type InkImage } from "@/lib/ink/model";
import { isPicture, notebookPictures, PICTURE_TYPES, preparePicture, uploadToPage, type NotebookPicture } from "./notebook-media";
import { StickerPanel } from "./sticker-panel";

type XY = { x: number; y: number };
// Points per pixel of a picture (96 per inch).
const PX = 0.75;

export function useNotebookInsert({
  pageId,
  editor,
  sizeOf,
  current,
  canEdit,
  onError,
  onBusy,
  onPdf,
}: {
  pageId: string;
  editor: InkEditor;
  sizeOf: (sheetId: string) => PageSize | undefined;
  current: () => string;
  canEdit: boolean;
  onError: (message: string) => void;
  onBusy: (text: string) => void;
  // A PDF dropped or pasted: imported as sheets.
  onPdf?: (file: File) => void;
}) {
  const t = useT();
  // The middle of what is visible of a sheet, in its page units.
  const visibleCentre = useCallback((sheetId: string): XY | null => {
    const layer = document.querySelector<HTMLElement>(`.notebook-sheet[data-sheet="${CSS.escape(sheetId)}"] .ink-layer`);
    const size = sizeOf(sheetId);
    if (!layer || !size) return null;
    const rect = layer.getBoundingClientRect();
    const top = Math.max(rect.top, 0),
      bottom = Math.min(rect.bottom, window.innerHeight);
    const left = Math.max(rect.left, 0),
      right = Math.min(rect.right, window.innerWidth);
    if (bottom <= top || right <= left) return null;
    return clientToPage((left + right) / 2, (top + bottom) / 2, rect, size);
  }, [sizeOf]);

  const place = useCallback(
    (sheetId: string, item: Omit<InkImage, "x" | "y" | "w" | "h" | "id" | "type">, natural: { width: number; height: number }, at?: XY | null, max = 0.6) => {
      const size = sizeOf(sheetId);
      if (!size) return;
      const box = placeImage(natural, size, { at: at ?? visibleCentre(sheetId), max });
      const image: InkImage = { id: inkId(), type: "image", ...box, ...item };
      editor.change(sheetId, (list) => [...list, image]);
      editor.pick({ page: sheetId, id: image.id });
    },
    [editor, sizeOf, visibleCentre],
  );

  // Files from the picker, the camera, the clipboard or a drop.
  const insertFiles = useCallback(
    async (files: File[], sheetId = current(), at?: XY | null) => {
      if (!canEdit || !sheetId) return;
      const pdf = files.find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
      if (pdf && onPdf) onPdf(pdf);
      const pictures = files.filter(isPicture);
      if (!pictures.length && !pdf) onError(t("Bitte ein Bild wählen (PNG, JPEG, WebP, GIF, HEIC).", "Please choose a picture (PNG, JPEG, WebP, GIF, HEIC)."));
      let offset = 0;
      for (const file of pictures.slice(0, 20)) {
        onBusy(t("Bild wird hochgeladen …", "Uploading picture …"));
        try {
          const ready = await preparePicture(file);
          const uploaded = await uploadToPage(pageId, ready.file);
          if (!uploaded.mime.startsWith("image/")) throw new Error(t("Dieses Bild kann Flowplan nicht anzeigen.", "Flowplan cannot show this picture."));
          const width = ready.width || uploaded.placeholder?.w || 400,
            height = ready.height || uploaded.placeholder?.h || 300;
          const spot = at ? { x: at.x + offset, y: at.y + offset } : null;
          place(sheetId, { file: uploaded.id }, { width: width * PX, height: height * PX }, spot);
          offset += 18;
        } catch (e) {
          onError((e as Error).message || t("Das Bild konnte nicht hochgeladen werden.", "The picture could not be uploaded."));
        } finally {
          onBusy("");
        }
      }
    },
    [canEdit, current, onBusy, onError, onPdf, pageId, place, t],
  );

  // ⌘V with a picture on the clipboard (copied ink goes first, see useInkShortcuts).
  const filesRef = useRef(insertFiles);
  filesRef.current = insertFiles;
  useEffect(() => {
    if (!canEdit) return;
    const paste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, [contenteditable=true], [role=dialog]")) return;
      if (!document.querySelector(".notebook-view")) return;
      const files = [...(event.clipboardData?.files || [])].filter((f) => isPicture(f) || f.type === "application/pdf");
      if (!files.length) return;
      event.preventDefault();
      void filesRef.current(files);
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [canEdit]);

  // Dropping files onto a sheet: where they land.
  const dropProps = canEdit
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        },
        onDrop: (e: React.DragEvent) => {
          const files = [...e.dataTransfer.files];
          if (!files.length) return;
          e.preventDefault();
          const sheet = (e.target as Element).closest<HTMLElement>(".notebook-sheet");
          const sheetId = sheet?.dataset.sheet || current();
          const layer = sheet?.querySelector<HTMLElement>(".ink-layer");
          const size = sizeOf(sheetId);
          const at = layer && size ? clientToPage(e.clientX, e.clientY, layer.getBoundingClientRect(), size) : null;
          void insertFiles(files, sheetId, at);
        },
      }
    : {};

  const insertPicture = useCallback(
    (picture: NotebookPicture, natural?: { width: number; height: number }) => {
      const sheetId = current();
      const w = picture.width || natural?.width || 400,
        h = picture.height || natural?.height || 300;
      place(sheetId, { file: picture.id }, { width: w * PX, height: h * PX });
    },
    [current, place],
  );
  return { insertFiles, insertPicture, place, dropProps, visibleCentre };
}
export type NotebookInsert = ReturnType<typeof useNotebookInsert>;

// The "Insert" button of the notebook bar and what it opens.
export function NotebookInsertMenu({ pageId, editor, insert, current, onError }: { pageId: string; editor: InkEditor; insert: NotebookInsert; current: () => string; onError: (message: string) => void }) {
  const t = useT();
  const placeMenu = useMenuPlacement();
  const [open, setOpen] = useState(false);
  const [pictures, setPictures] = useState<NotebookPicture[] | null>(null);
  const [stickers, setStickers] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  const choose = (input: React.RefObject<HTMLInputElement | null>) => {
    setOpen(false);
    input.current?.click();
  };
  const openPictures = async () => {
    setOpen(false);
    try {
      setPictures(await notebookPictures(pageId));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const onFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (files.length) void insert.insertFiles(files);
  };
  return (
    <div className="notebook-menu-anchor" ref={anchor}>
      <button
        type="button"
        className="icon-button"
        aria-label={t("Bild oder Sticker einfügen", "Insert picture or sticker")}
        title={t("Bild oder Sticker einfügen", "Insert picture or sticker")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ImageIcon size={18} />
      </button>
      {open && (
        <div ref={placeMenu} className="ink-menu notebook-menu" role="menu" aria-label={t("Einfügen", "Insert")}>
          <button type="button" role="menuitem" onClick={() => choose(fileInput)}>
            <Plus size={16} /> {t("Bild aus Datei …", "Picture from file …")}
          </button>
          <button type="button" role="menuitem" onClick={() => choose(cameraInput)}>
            <Camera size={16} /> {t("Foto aufnehmen …", "Take photo …")}
          </button>
          <button type="button" role="menuitem" onClick={() => void openPictures()}>
            <Images size={16} /> {t("Bild dieser Seite …", "Picture of this page …")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setStickers(true);
            }}
          >
            <Sticker size={16} /> {t("Sticker …", "Stickers …")}
          </button>
        </div>
      )}
      <input ref={fileInput} type="file" accept={`${PICTURE_TYPES},application/pdf`} multiple hidden onChange={onFiles} />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={onFiles} />
      <Modal open={!!pictures} onClose={() => setPictures(null)} title={t("Bild dieser Seite", "Picture of this page")} className="notebook-pictures-dialog" sheet>
        {pictures && !pictures.length && <p className="notebook-library-empty">{t("Diese Seite hat noch keine Bilder.", "This page has no pictures yet.")}</p>}
        <div className="notebook-library-grid">
          {pictures?.map((picture) => (
            <button
              key={picture.id}
              type="button"
              className="notebook-library-tile"
              title={picture.name}
              onClick={(e) => {
                const img = e.currentTarget.querySelector("img");
                setPictures(null);
                insert.insertPicture(picture, img?.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : undefined);
              }}
            >
              <img src={picture.url} alt="" loading="lazy" />
              <span>{picture.name}</span>
            </button>
          ))}
        </div>
      </Modal>
      <StickerPanel open={stickers} onClose={() => setStickers(false)} pageId={pageId} editor={editor} insert={insert} current={current} onError={onError} />
    </div>
  );
}
