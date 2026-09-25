"use client";
import { LibraryIcon } from "./library-icons";
import * as Dialog from "@radix-ui/react-dialog";
import {
  X,
  FileText,
  Table,
  BookOpen,
  Rocket,
  HandWaving,
  Folder,
  Flag,
  Lightbulb,
  Notebook,
  Stack,
  CalendarBlank,
  Kanban,
  SquaresFour,
  List,
  ChartBarHorizontal,
  ChartBar,
  Article,
  ClipboardText,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
const icons = {
  file: FileText,
  table: Table,
  book: BookOpen,
  rocket: Rocket,
  hand: HandWaving,
  folder: Folder,
  flag: Flag,
  idea: Lightbulb,
  notes: Notebook,
  stack: Stack,
};
export function PageIcon({
  name,
  size = 18,
  ...props
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  if (name?.startsWith("icon:"))
    return <LibraryIcon value={name} size={size} className={props.className} />;
  // Uploaded page images; public pages pass their share URL instead.
  if (/^\/api\/(?:files|share\/[\w-]+\/files)\/[\w-]+$/.test(name || ""))
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={name}
        alt=""
        aria-hidden="true"
        className={`page-image-icon ${props.className || ""}`}
        style={{ width: size, height: size }}
      />
    );
  if (
    name &&
    name.length <= 64 &&
    /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(
      name,
    )
  )
    return (
      <span
        {...props}
        className={`page-emoji ${props.className || ""}`}
        style={{ fontSize: size, width: size, height: size }}
        aria-hidden="true"
      >
        {name}
      </span>
    );
  const Icon = icons[name as keyof typeof icons] || FileText;
  return <Icon size={size} {...props} />;
}
export const viewIcons = {
  table: Table,
  board: Kanban,
  calendar: CalendarBlank,
  gallery: SquaresFour,
  list: List,
  timeline: ChartBarHorizontal,
  form: ClipboardText,
  chart: ChartBar,
  feed: Article,
};
export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
  onCloseAutoFocus,
  className = "",
}: {
  className?: string;
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal ${wide ? "modal-wide" : ""} ${className}`}
          aria-describedby={undefined}
          aria-labelledby={undefined}
          aria-label={title}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <div className="modal-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Schließen">
              <X size={20} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Avatar({
  name,
  small = false,
}: {
  name: string;
  small?: boolean;
}) {
  return (
    <span
      title={name}
      className={`avatar ${small ? "small" : ""}`}
      style={{
        background: ["#e5edff", "#f1e8fb", "#e6f2ed", "#fcebcf"][
          name.charCodeAt(0) % 4
        ],
      }}
    >
      {name
        .split(" ")
        .map((n) => n[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()}
    </span>
  );
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T = Record<string, unknown>>(
  url: string,
  body?: unknown,
): Promise<T> {
  const r = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const data = await r.json();
  if (!r.ok)
    throw new ApiError(data.error || "Anfrage fehlgeschlagen", r.status);
  return data;
}
export function download(name: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
