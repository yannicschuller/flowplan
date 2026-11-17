// A message from the server in the language of the page – for the browser.
// The English of all server messages (lib/i18n-errors.ts, with the
// security catalogue) is 160 KB: it is loaded on first use, and right after
// the app started while the browser is idle, not with every page. German
// pages need none of it (the server answers in German). Until it is there
// a message shows as the server sent it.
import type { Locale } from "./i18n";
import { PAGE_LOCALE } from "./locale-tag";

type Translate = (message: string, locale: Locale) => string;
let translate: Translate | null = null;
let loading: Promise<Translate> | null = null;

export function loadServerMessages(): Promise<Translate> {
  loading ??= import("./i18n-errors").then((m) => (translate = m.localizedMessage));
  loading.catch(() => (loading = null));
  return loading;
}
export function serverMessage(message: string): string;
export function serverMessage(message: string | undefined): string | undefined;
export function serverMessage(message: string | undefined) {
  if (!message || PAGE_LOCALE === "de") return message;
  if (translate) return translate(message, PAGE_LOCALE);
  void loadServerMessages();
  return message;
}
// Loaded ahead while idle: a refusal shortly after the start is in the
// page's language already.
if (typeof window !== "undefined" && PAGE_LOCALE !== "de") {
  const idle = (window as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(() => void loadServerMessages(), { timeout: 5000 });
  else setTimeout(() => void loadServerMessages(), 2000);
}
