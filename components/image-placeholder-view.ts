"use client";
// Images in documents with their blurred placeholder (components/image-placeholder.ts):
// the editable view (resize handles) gets it around its image; read-only
// documents get a frame around the image as the schema renders it.
import type { NodeViewRenderer } from "@tiptap/core";
import { attachPlaceholder } from "./image-placeholder";
import { fileIdOf, onPreview, previewOf } from "@/lib/offline-pending";

// A picture added offline that waits to be uploaded (#370): the image shows
// its copy on this device; the document keeps /api/files/<id>, the address
// it has once uploaded. Returns the cleanup.
function showPending(img: HTMLImageElement): () => void {
  const fileId = fileIdOf(img.getAttribute("src"));
  if (!fileId) return () => {};
  const show = (url: string) => {
    if (img.src !== url) img.src = url;
  };
  const known = previewOf(fileId);
  if (known) show(known);
  return onPreview(fileId, show);
}

export function imagePlaceholderView(render: NodeViewRenderer | null): NodeViewRenderer {
  return (props) => {
    if (render) {
      const view = render(props);
      const dom = view.dom as HTMLElement;
      const img = dom.querySelector?.("img");
      if (!img) return view;
      const frame = dom.querySelector<HTMLElement>("[data-resize-wrapper]") || dom;
      let src = img.getAttribute("src");
      let detach = attachPlaceholder(img, frame);
      let pending = showPending(img);
      // Tiptap hides the view until the image has loaded; the placeholder
      // is meant to be seen (it has the image's size). Touches still wait.
      dom.style.visibility = "";
      const update = view.update?.bind(view);
      if (update)
        view.update = (node, decorations, inner) => {
          const ok = update(node, decorations, inner);
          // An annotated image gets a new file.
          if (ok && node.attrs.src !== src) {
            detach();
            pending();
            src = node.attrs.src;
            detach = attachPlaceholder(img, frame);
            pending = showPending(img);
          } else if (ok) {
            // Redrawn with the document's address: the local copy again.
            const local = previewOf(fileIdOf(src) || "");
            if (local && img.src !== local) img.src = local;
          }
          return ok;
        };
      const destroy = view.destroy?.bind(view);
      view.destroy = () => {
        detach();
        pending();
        destroy?.();
      };
      const ignore = view.ignoreMutation?.bind(view);
      // The placeholder's styles are not edits of the document.
      view.ignoreMutation = (mutation) =>
        (mutation.type === "attributes" &&
          (mutation.target === img || mutation.target === frame) &&
          (mutation.attributeName === "style" || mutation.attributeName === "class" || mutation.attributeName === "data-missing" || mutation.attributeName === "src")) ||
        (ignore ? ignore(mutation) : false);
      return view;
    }
    const frame = document.createElement("span");
    frame.className = "fp-image-frame";
    const img = document.createElement("img");
    for (const [name, value] of Object.entries(props.HTMLAttributes))
      if (value !== null && value !== undefined && value !== false) img.setAttribute(name, String(value));
    frame.append(img);
    const detach = attachPlaceholder(img, frame);
    const pending = showPending(img);
    return {
      dom: frame,
      // Changes of the image redraw it (read-only: they come from others).
      update: () => false,
      ignoreMutation: () => true,
      destroy: () => {
        detach();
        pending();
      },
    };
  };
}
