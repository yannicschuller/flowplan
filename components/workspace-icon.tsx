"use client";
import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ImageSquare, Smiley, Trash } from "@phosphor-icons/react";
import { Modal, PageIcon } from "./ui";
import {
  MAX_WORKSPACE_IMAGE,
  workspaceImage,
  workspaceLetterIcon,
} from "@/lib/workspace-icon";

const EmojiPicker = dynamic(() => import("./emoji-picker"), {
  ssr: false,
  loading: () => <p className="muted">Emojis werden geladen …</p>,
});

export function WorkspaceIcon({
  name,
  icon,
  small = false,
}: {
  name: string;
  icon?: string | null;
  small?: boolean;
}) {
  const className = `workspace-letter${small ? " small" : ""}`;
  if (workspaceImage(icon))
    return (
      <span className={`${className} has-image`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={icon!} alt="" />
      </span>
    );
  if (!workspaceLetterIcon(icon))
    return (
      <span className={`${className} has-symbol`}>
        <PageIcon name={icon!} size={small ? 15 : 19} />
      </span>
    );
  return <span className={className}>{name.slice(0, 1).toUpperCase()}</span>;
}

// Scales an image to a square of 128 px (cropped to the centre).
async function squareImage(file: File) {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("Das Bild konnte nicht gelesen werden.");
  });
  const size = 128,
    canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const side = Math.min(bitmap.width, bitmap.height);
  canvas
    .getContext("2d")!
    .drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    );
  bitmap.close();
  for (const quality of [0.9, 0.75, 0.6]) {
    const url = canvas.toDataURL("image/webp", quality);
    if (url.startsWith("data:image/webp") && url.length <= MAX_WORKSPACE_IMAGE)
      return url;
  }
  const png = canvas.toDataURL("image/png");
  if (png.length > MAX_WORKSPACE_IMAGE)
    throw new Error("Das Bild ist zu groß.");
  return png;
}

export function WorkspaceIconPicker({
  name,
  icon,
  disabled,
  save,
}: {
  name: string;
  icon?: string | null;
  disabled: boolean;
  save: (icon: string) => Promise<unknown>;
}) {
  const [emoji, setEmoji] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const apply = async (value: string) => {
    setBusy(true);
    setError("");
    try {
      await save(value);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="workspace-icon-picker">
      <span className="workspace-icon-preview">
        <WorkspaceIcon name={name} icon={icon} />
      </span>
      <div className="workspace-icon-actions">
        <span className="muted">Symbol des Arbeitsbereichs</span>
        <div>
          <button
            type="button"
            className="button compact"
            disabled={disabled || busy}
            onClick={() => setEmoji(true)}
          >
            <Smiley size={16} /> Emoji oder Symbol
          </button>
          <button
            type="button"
            className="button compact"
            disabled={disabled || busy}
            onClick={() => file.current?.click()}
          >
            <ImageSquare size={16} /> Bild hochladen
          </button>
          {!workspaceLetterIcon(icon) && (
            <button
              type="button"
              className="button compact"
              disabled={disabled || busy}
              onClick={() => void apply("")}
            >
              <Trash size={16} /> Entfernen
            </button>
          )}
        </div>
        <input
          ref={file}
          type="file"
          hidden
          aria-label="Bild für den Arbeitsbereich"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={async (e) => {
            const chosen = e.target.files?.[0];
            e.target.value = "";
            if (!chosen) return;
            try {
              await apply(await squareImage(chosen));
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <Modal
        open={emoji}
        onClose={() => setEmoji(false)}
        title="Symbol für den Arbeitsbereich"
      >
        <EmojiPicker
          selected={icon || undefined}
          onSelect={async (value) => {
            await apply(value);
            setEmoji(false);
          }}
        />
      </Modal>
    </div>
  );
}
