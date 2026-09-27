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
  PresentationChart,
  CalendarBlank,
  Kanban,
  SquaresFour,
  List,
  ChartBarHorizontal,
  ChartBar,
  Article,
  ClipboardText,
} from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
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
  whiteboard: PresentationChart,
  journal: Notebook,
  day: CalendarBlank,
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
// Placeholder while a page opens: the outline of a document or a table
// with a soft shimmer (still for reduced motion).
export function PageSkeleton({
  kind = "document",
  label = "Seite wird geöffnet …",
  compact = false,
}: {
  kind?: "document" | "database";
  label?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`page-skeleton${compact ? " compact" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="page-skeleton-label">
        <span className="page-skeleton-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {label}
      </span>
      <div aria-hidden="true" className="page-skeleton-body">
        {!compact && (
          <>
            <span className="sk sk-icon" />
            <span className="sk sk-title" />
          </>
        )}
        {kind === "database" ? (
          <div className="sk-table">
            <span className="sk sk-tabs" />
            {Array.from({ length: 6 }, (_, i) => (
              <div className="sk-row" key={i}>
                <span className="sk" />
                <span className="sk" />
                <span className="sk" />
              </div>
            ))}
          </div>
        ) : (
          [92, 100, 84, 96, 60, 0, 88, 72].map((w, i) =>
            w ? (
              <span
                key={i}
                className="sk sk-line"
                style={{ width: `${w}%` }}
              />
            ) : (
              <span key={i} className="sk-gap" />
            ),
          )
        )}
      </div>
    </div>
  );
}
// Profile pictures of the people in the current workspace (from the identity
// provider), keyed by user id. The app fills it from the member list.
const pictures = { byId: new Map<string, string>(), byName: new Map<string, string>() };
export function setAvatarDirectory(
  people: { id: string; name: string; avatar?: string | null }[],
) {
  const byId = new Map<string, string>(),
    byName = new Map<string, string>(),
    names = new Map<string, number>();
  for (const p of people) names.set(p.name, (names.get(p.name) || 0) + 1);
  for (const p of people)
    if (p.avatar) {
      const src = `/api/avatars/${p.id}?v=${p.avatar}`;
      byId.set(p.id, src);
      // Places that only know a name use it when the name is unique.
      if (names.get(p.name) === 1) byName.set(p.name, src);
    }
  pictures.byId = byId;
  pictures.byName = byName;
}
export function Avatar({
  name,
  userId,
  small = false,
}: {
  name: string;
  userId?: string | null;
  small?: boolean;
}) {
  const src =
    (userId && pictures.byId.get(userId)) || pictures.byName.get(name);
  const [broken, setBroken] = useState<string | null>(null);
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      title={name}
      className={`avatar ${small ? "small" : ""} ${src && broken !== src ? "has-picture" : ""}`}
      style={{
        background: ["#e5edff", "#f1e8fb", "#e6f2ed", "#fcebcf"][
          name.charCodeAt(0) % 4
        ],
      }}
    >
      {src && broken !== src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" loading="lazy" onError={() => setBroken(src)} />
      ) : (
        initials
      )}
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
  headers: Record<string, string> = {},
): Promise<T> {
  const r = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        }
      : { cache: "no-store", headers },
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
