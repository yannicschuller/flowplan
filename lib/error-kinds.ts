// One vocabulary for failed requests: every error the reader sees goes
// through classifyError() and describeError(), so a toast and an inline
// dialog alert say the same thing and raw strings ("Internal", "Failed to
// fetch") never reach the screen.

export type ErrorKind =
  | "offline"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "locked"
  | "too-large"
  | "rate-limited"
  | "server"
  | "unknown";

export type ClassifiedError = {
  kind: ErrorKind;
  // The server's own words (an HttpError 4xx, already in the reader's
  // language) when they say more than the kind's copy.
  detail?: string;
};

export type Translate = (de: string, en: string) => string;

// Browsers' wording for a request that never reached the server.
export const NETWORK_ERRORS =
  /^(Failed to fetch|NetworkError when attempting to fetch resource\.|Load failed|The network connection was lost\.|Network request failed|net::ERR_[A-Z_]+)$/;
// Placeholders some endpoints and proxies send that tell the reader nothing.
const EMPTY_WORDS =
  /^(internal( server error)?|error|unknown error|bad request|forbidden|unauthori[sz]ed|not found|conflict|locked|too many requests|payload too large|request entity too large|service unavailable|bad gateway|gateway time-?out|anfrage fehlgeschlagen|request failed|fehler|undefined|null|\[object object\])\.?$/i;
const LOCKED_WORDS = /gesperrt|locked/i;

export function kindForStatus(status: number, message = ""): ErrorKind {
  if (status === 0) return "offline";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 423 || (status === 409 && LOCKED_WORDS.test(message))) return "locked";
  if (status === 409 || status === 412) return "conflict";
  if (status === 413) return "too-large";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  return "unknown";
}

// Whether the server's text adds something to the kind's own copy.
export function informative(message: string | undefined | null): message is string {
  const text = (message || "").trim();
  return !!text && text.length <= 400 && !EMPTY_WORDS.test(text) && !NETWORK_ERRORS.test(text) && !/^<!doctype|^<html/i.test(text);
}

// Recently thrown request errors by their message: components that hand
// only `error.message` to an onError prop still get the right kind.
type Remembered = { status: number; transient: boolean; at: number };
const recent = new Map<string, Remembered>();
export function rememberError(message: string, status: number, transient = false) {
  recent.delete(message);
  recent.set(message, { status, transient, at: Date.now() });
  if (recent.size > 30) recent.delete(recent.keys().next().value!);
}
function recall(message: string) {
  const hit = recent.get(message);
  return hit && Date.now() - hit.at < 120_000 ? hit : null;
}

type Statusful = { message?: unknown; status?: unknown; transient?: unknown; detail?: unknown };

export function classifyError(error: unknown): ClassifiedError {
  if (error && typeof error === "object" && "kind" in error && typeof (error as ClassifiedError).kind === "string")
    return error as ClassifiedError;
  // fetch() rejects with a TypeError when the network is gone.
  if (error instanceof TypeError) return { kind: "offline" };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { kind: "offline" };
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && typeof (error as Statusful).message === "string"
        ? ((error as Statusful).message as string)
        : "";
  if (error && typeof error === "object" && typeof (error as Statusful).status === "number") {
    const e = error as Statusful;
    const status = e.status as number;
    // No answer from Flowplan itself (gateway page, restart).
    if (e.transient === true) return { kind: status === 0 ? "offline" : "server" };
    const kind = kindForStatus(status, message);
    const detail = typeof e.detail === "string" ? e.detail : message;
    return kind === "server" || kind === "unauthorized" || !informative(detail) ? { kind } : { kind, detail };
  }
  if (NETWORK_ERRORS.test(message.trim())) return { kind: "offline" };
  const known = recall(message);
  if (known) return classifyError({ message, status: known.status, transient: known.transient });
  if (/^internal( server error)?\.?$/i.test(message.trim())) return { kind: "server" };
  if (/^(Abort|Timeout)Error$/.test((error as Error)?.name || "")) return { kind: "offline" };
  return informative(message) ? { kind: "unknown", detail: message } : { kind: "unknown" };
}

export type ErrorText = { title: string; detail?: string };

// The reader's words for a kind; `detail` from classifyError() stays as the
// second line (or becomes the only line for an otherwise unknown failure).
export function describeError({ kind, detail }: ClassifiedError, t: Translate): ErrorText {
  const title = {
    offline: t("Keine Verbindung – bitte prüfe dein Netz und versuche es erneut.", "No connection – check your network and try again."),
    unauthorized: t("Du wurdest abgemeldet – melde dich erneut an, um deine Änderungen zu behalten.", "You were signed out – sign in again to keep your changes."),
    forbidden: t("Dafür fehlt dir die Berechtigung.", "You don't have permission to do that."),
    conflict: t("Das wurde gerade an anderer Stelle geändert. Lade neu und versuche es noch einmal.", "This was just changed elsewhere. Reload and try again."),
    locked: t("Diese Seite ist gesperrt und kann gerade nicht bearbeitet werden.", "This page is locked and cannot be edited right now."),
    "too-large": t("Das ist zu groß zum Speichern.", "This is too large to save."),
    "rate-limited": t("Zu viele Anfragen – bitte warte einen Moment und versuche es dann erneut.", "Too many requests – wait a moment, then try again."),
    server: t("Auf dem Server ist etwas schiefgelaufen. Bitte erneut versuchen.", "Something went wrong on the server. Try again."),
    unknown: t("Das hat nicht geklappt. Bitte erneut versuchen.", "That did not work. Try again."),
  }[kind];
  // Nothing new in it ("This page is locked." under the locked copy).
  const said = (s: string) => s.toLowerCase().replace(/[.!]+$/, "").trim();
  if (!informative(detail) || said(title).includes(said(detail))) return { title };
  // An unknown failure with the server's own explanation: that explanation
  // is the message.
  if (kind === "unknown") return { title: detail };
  return { title, detail };
}
