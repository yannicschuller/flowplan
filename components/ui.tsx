"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { tr } from "@/lib/locale-tag";
import { nativeApp, nativeRefresh, nativeSaveFile } from "@/lib/native-app";
import { useT } from "./i18n";
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
  Gauge,
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
  dashboard: Gauge,
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
  sprint: Flag,
};
export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
  onCloseAutoFocus,
  onOpenAutoFocus,
  className = "",
  actions,
}: {
  className?: string;
  actions?: ReactNode;
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
  // Where focus goes on opening (default: the first focusable element).
  onOpenAutoFocus?: (event: Event) => void;
}) {
  const t = useT();
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal ${wide ? "modal-wide" : ""} ${className}`}
          aria-describedby={undefined}
          aria-labelledby={undefined}
          aria-label={title}
          aria-modal="true"
          onCloseAutoFocus={onCloseAutoFocus}
          onOpenAutoFocus={onOpenAutoFocus}
        >
          <div className="modal-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={t("Schließen", "Close")}>
              <X size={20} />
            </Dialog.Close>
            {/* After the close button in the DOM, so opening focuses that
                one as before; CSS puts the actions in front of it. */}
            {actions && <div className="modal-heading-actions">{actions}</div>}
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
  label,
  compact = false,
}: {
  kind?: "document" | "database";
  label?: string;
  compact?: boolean;
}) {
  const t = useT();
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
        {label ?? t("Seite wird geöffnet …", "Opening page …")}
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
    // No answer from Flowplan itself (e.g. the proxy's error page while the
    // server restarts): worth trying again shortly.
    readonly transient = false,
  ) {
    super(message);
  }
}
export const unavailableMessage =
  "Der Server ist gerade nicht erreichbar. Bitte gleich noch einmal versuchen.";
// A request that did not reach Flowplan or got no answer from it.
export const isTransient = (e: unknown) =>
  e instanceof TypeError || (e instanceof ApiError && e.transient);
// The session ended (signed out elsewhere, expired): in the app, reload once –
// "/" then shows the sign-in page and returns to the same page afterwards.
// A listener that cancels the "flowplan:signed-out" event shows a banner
// instead, so unsaved changes stay on this device until the reader signs in.
let signingIn = false;
export const SIGNED_OUT_EVENT = "flowplan:signed-out";
export const signedOutMessage = () =>
  tr("Du wurdest abgemeldet – melde dich erneut an, um deine Änderungen zu behalten.", "You were signed out – sign in again to keep your changes.");
export function endedSession(url: string, status: number) {
  if (status !== 401 || typeof window === "undefined" || location.pathname !== "/") return false;
  const path = url.startsWith("http") ? new URL(url).pathname : url;
  if (!path.startsWith("/api/") || path.startsWith("/api/auth/")) return false;
  if (!window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT, { cancelable: true }))) return false;
  if (!signingIn) {
    signingIn = true;
    location.reload();
  }
  return true;
}
// Browsers' wording for a request that never reached the server.
const NETWORK_ERRORS = /^(Failed to fetch|NetworkError when attempting to fetch resource\.|Load failed|The network connection was lost\.)$/;
export const connectionMessage = () => tr("Keine Verbindung – bitte erneut versuchen.", "No connection – try again.");
// What a toast shows for a failed request: network and server failures get
// plain words; the server's own messages (HttpError 4xx) stay as they are.
export function friendlyError(message: string) {
  return NETWORK_ERRORS.test(message) ? connectionMessage() : message;
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
  let data;
  try {
    data = await r.json();
  } catch {
    // An HTML page instead of JSON: a proxy or gateway answered.
    throw new ApiError(serverMessage(unavailableMessage), r.ok ? 502 : r.status, true);
  }
  // No "please sign in" message: the sign-in page is on its way.
  if (endedSession(url, r.status)) return new Promise<T>(() => {});
  const transient = [502, 503, 504].includes(r.status);
  if (!r.ok)
    throw new ApiError(
      r.status === 401 && !url.includes("/api/auth/")
        ? signedOutMessage()
        : r.status >= 500 && !transient
          ? tr("Auf dem Server ist etwas schiefgelaufen. Bitte erneut versuchen.", "Something went wrong on the server. Try again.")
          : serverMessage(data?.error || "Anfrage fehlgeschlagen"),
      r.status,
      transient,
    );
  // The mobile app updates its widgets and badge after a change.
  if (body) nativeRefresh();
  return data;
}
export function download(name: string, content: string, type = "text/plain") {
  downloadBlob(name, new Blob([content], { type }));
}
// In the mobile app the file goes to the share sheet: its web view cannot
// download.
export function downloadBlob(name: string, blob: Blob) {
  if (nativeApp()?.saveFile) {
    void nativeSaveFile(name, blob);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
