"use client";
// The tools of an image in a document (#240), as in Notion: pointing at an
// image (on touch screens: tapping it, which selects it) shows a small bar
// in its top right corner – comment, caption, replace, download, full
// screen and "…" with alignment, marking up, copying the image or a link to
// it, and deleting. It replaces the "Add caption" button under the image
// (#241) and the image buttons of the formatting toolbar, so they stay
// reachable with the toolbar hidden (#235). The resize handles stay.
import { useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import {
  ArrowsOut,
  ChatCircle,
  CopySimple,
  DotsThree,
  DownloadSimple,
  ImageSquare,
  LinkSimple,
  PencilSimpleLine,
  TextAa,
  TextAlignCenter,
  TextAlignLeft,
  TextAlignRight,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { BlockMenu, type BlockMenuClose, type BlockMenuItem } from "./block-menu";
import { editCaption } from "./block-captions-view";
import { imageAlign } from "@/lib/document-schema";

type Shown = { pos: number; src: string; alt: string };

// The image node a DOM element belongs to, with its position.
function imageAtDom(editor: Editor, element: Element): Shown | null {
  const container = element.closest("[data-resize-container]") || element.closest("img");
  if (!container || !editor.view.dom.contains(container)) return null;
  let pos: number;
  try {
    pos = editor.view.posAtDOM(container, 0);
  } catch {
    return null;
  }
  for (const at of [pos, pos - 1]) {
    const node = at >= 0 ? editor.state.doc.nodeAt(at) : null;
    if (node?.type.name === "image") return { pos: at, src: String(node.attrs.src || ""), alt: String(node.attrs.alt || "") };
  }
  return null;
}
function imageElement(editor: Editor, pos: number): HTMLElement | null {
  const dom = editor.view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  return dom.matches("img") ? dom : dom.querySelector("img");
}
// A file name for the download: the alt text when it is one, else the address's.
function fileName(image: Shown) {
  if (/\.[a-z0-9]{2,5}$/i.test(image.alt)) return image.alt;
  try {
    return decodeURIComponent(new URL(image.src, location.href).pathname.split("/").pop() || "") || "image";
  } catch {
    return "image";
  }
}

export function ImageTools({
  editor,
  editable,
  onReplace,
  onAnnotate,
  onCopyImage,
  onCopyLink,
}: {
  editor: Editor;
  editable: boolean;
  onReplace: (pos: number, file: File) => void;
  onAnnotate: (pos: number) => void;
  onCopyImage: (pos: number) => void;
  onCopyLink: (pos: number) => void;
}) {
  const t = useT();
  const layer = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<Shown | null>(null);
  const [menu, setMenu] = useState<{ pos: number; anchor: DOMRect; button: HTMLElement } | null>(null);
  const [viewer, setViewer] = useState<Shown | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch" || editor.isDestroyed) return;
      const target = event.target as Element | null;
      if (!target || layer.current?.contains(target)) return;
      const image = target.closest?.("[data-resize-container], img") ? imageAtDom(editor, target) : null;
      setHovered((prev) => (image ? (prev?.pos === image.pos && prev.src === image.src ? prev : image) : null));
    };
    // A tap: the image tapped keeps its tools (the selection on it can
    // change when the keyboard comes up); a tap elsewhere ends them.
    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || editor.isDestroyed) return;
      const target = event.target as Element | null;
      if (!target || layer.current?.contains(target) || target.closest?.(".block-menu-sheet, .image-viewer")) return;
      const image = target.closest?.("[data-resize-container], img") ? imageAtDom(editor, target) : null;
      setHovered(image);
    };
    document.addEventListener("pointerdown", onDown, true);
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(redraw);
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("scroll", later, true);
    window.addEventListener("resize", later);
    editor.on("transaction", later);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", later, true);
      window.removeEventListener("resize", later);
      editor.off("transaction", later);
    };
  }, [editor]);

  // The image pointed at, else the selected one (a tap on a phone, the
  // keyboard), else the one whose menu is open.
  const selection = editor.state.selection;
  const selected: Shown | null =
    selection instanceof NodeSelection && selection.node.type.name === "image"
      ? { pos: selection.from, src: String(selection.node.attrs.src || ""), alt: String(selection.node.attrs.alt || "") }
      : null;
  const menuImage = menu ? editor.state.doc.nodeAt(menu.pos) : null;
  const shown: Shown | null =
    (menu && menuImage?.type.name === "image" ? { pos: menu.pos, src: String(menuImage.attrs.src || ""), alt: String(menuImage.attrs.alt || "") } : null) ||
    (hovered && editor.state.doc.nodeAt(hovered.pos)?.type.name === "image" ? hovered : null) ||
    selected;
  const origin = layer.current?.getBoundingClientRect();
  const element = shown ? imageElement(editor, shown.pos) : null;
  const box = element && origin ? element.getBoundingClientRect() : null;

  const keep = (event: React.MouseEvent | React.PointerEvent) => event.preventDefault();
  const select = (pos: number) => editor.chain().focus().setNodeSelection(pos).run();
  const node = shown ? editor.state.doc.nodeAt(shown.pos) : null;
  const align = imageAlign(node?.attrs.align);
  const setAlign = (pos: number, value: "center" | "right" | null) => {
    const current = editor.state.doc.nodeAt(pos);
    if (current?.type.name !== "image") return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, align: value }));
  };
  const download = (image: Shown) => {
    const link = document.createElement("a");
    link.href = image.src;
    link.download = fileName(image);
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  };
  const menuItems = (pos: number): BlockMenuItem[] => [
    { heading: t("Ausrichtung", "Alignment") },
    { icon: <TextAlignLeft />, label: t("Links", "Left"), checked: !align, run: () => setAlign(pos, null) },
    { icon: <TextAlignCenter />, label: t("Mitte", "Centre"), checked: align === "center", run: () => setAlign(pos, "center") },
    { icon: <TextAlignRight />, label: t("Rechts", "Right"), checked: align === "right", run: () => setAlign(pos, "right") },
    "separator",
    { icon: <PencilSimpleLine />, label: t("Bild markieren", "Mark up image"), run: () => onAnnotate(pos) },
    { icon: <CopySimple />, label: t("Bild kopieren", "Copy image"), run: () => onCopyImage(pos) },
    { icon: <LinkSimple />, label: t("Link zum Block kopieren", "Copy link to block"), run: () => onCopyLink(pos) },
    "separator",
    {
      icon: <Trash />,
      label: t("Löschen", "Delete"),
      danger: true,
      run: () => {
        const current = editor.state.doc.nodeAt(pos);
        if (current?.type.name === "image") editor.chain().focus().deleteRange({ from: pos, to: pos + current.nodeSize }).run();
      },
    },
  ];

  const button = (label: string, icon: React.ReactNode, action: (e: React.MouseEvent<HTMLButtonElement>) => void, extra: Record<string, unknown> = {}) => (
    <button type="button" aria-label={label} title={label} onMouseDown={keep} onClick={action} {...extra}>
      {icon}
    </button>
  );
  return (
    <div ref={layer} className="image-tools-layer">
      {shown && box && origin && box.width > 60 && (
        <div
          className="image-tools"
          role="toolbar"
          aria-label={t("Bild", "Image")}
          style={{ right: origin.right - box.right + 8, top: box.top - origin.top + 8 }}
        >
          {editable &&
            button(t("Kommentieren", "Comment"), <ChatCircle size={16} />, () => {
              select(shown.pos);
              editor.view.dom.dispatchEvent(new CustomEvent("comment-create"));
            })}
          {editable && button(t("Beschriftung", "Caption"), <TextAa size={16} />, () => editCaption(editor.view, shown.pos))}
          {editable &&
            button(t("Bild ersetzen", "Replace image"), <ImageSquare size={16} />, () => {
              // A file picker of its own, outside the editor (its own
              // upload field stays the only one there).
              const pos = shown.pos;
              const input = document.createElement("input");
              input.type = "file";
              input.accept = "image/*";
              input.addEventListener("change", () => {
                const chosen = input.files?.[0];
                if (chosen) onReplace(pos, chosen);
              });
              input.click();
            })}
          {button(t("Herunterladen", "Download"), <DownloadSimple size={16} />, () => download(shown))}
          {button(t("Vollbild", "Full screen"), <ArrowsOut size={16} />, () => setViewer(shown))}
          {editable &&
            button(
              t("Weitere Bildaktionen", "More image actions"),
              <DotsThree size={16} weight="bold" />,
              (e) => {
                const target = e.currentTarget;
                setMenu((open) => (open ? null : { pos: shown.pos, anchor: target.getBoundingClientRect(), button: target }));
              },
              { "aria-haspopup": "menu", "aria-expanded": !!menu },
            )}
        </div>
      )}
      {menu && (
        <BlockMenu
          anchor={menu.anchor}
          owner={menu.button}
          placement="below"
          label={t("Bild", "Image")}
          views={{ main: { title: t("Bild", "Image"), items: menuItems(menu.pos) } }}
          onClose={(reason?: BlockMenuClose) => {
            setMenu(null);
            if (reason !== "away") editor.view.focus();
          }}
        />
      )}
      {viewer && <ImageViewer image={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

// The image alone over the page; Escape, the close button or a click
// beside it closes it.
function ImageViewer({ image, onClose }: { image: Shown; onClose: () => void }) {
  const t = useT();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      before?.focus?.({ preventScroll: true });
    };
  }, [onClose]);
  return createPortal(
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={image.alt || t("Bild", "Image")} onClick={(e) => e.target === e.currentTarget && onClose()}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.src} alt={image.alt} />
      <button ref={close} type="button" className="image-viewer-close" aria-label={t("Schließen", "Close")} title={t("Schließen", "Close")} onClick={onClose}>
        <X size={20} />
      </button>
    </div>,
    document.body,
  );
}
