import type { DeviceOS } from "./device-os";

// The apps for iPhone, iPad and Android (flowplan-app) put `window.FlowplanApp`
// into their web view. The page tells the app when something changed, so its
// widgets, badge and Live Activity follow at once, and hands files to it,
// because the web views cannot download them. Everything is optional: in a
// browser, or with an older app, nothing happens.
type FlowplanApp = {
  platform: "ios" | "android";
  version: string;
  // Re-reads the summary (unread notifications, tasks, running timer).
  refresh?: () => void;
  // Shows the system share sheet ("Save to Files", AirDrop, other apps).
  saveFile?: (name: string, base64: string, type: string) => void;
  // A short vibration for confirmations.
  haptic?: (kind: "light" | "success" | "warning" | "error") => void;
  // The app's own settings (server, notifications, app lock).
  openSettings?: () => void;
  // Whether "back" (window.FlowplanNavigation, lib/app-back.ts) would do
  // something: the app offers its back gesture only then.
  backState?: (canGoBack: boolean) => void;
  // iPhone and iPad: the camera's document scanner. The app saves the scan
  // as a PDF with the text it recognised at the end of this page (or
  // record), through its own API (lib/mobile-capture.ts); the open editor
  // gets it like any change from elsewhere.
  scanDocument?: (target: { pageId: string; rowId?: string }) => void;
  // Opens an address of this instance in Safari / the browser (a
  // configuration profile installs only from there: components/caldav-profile.tsx).
  openInBrowser?: (url: string) => void;
  // Records a voice note in the app, transcribed on the device where it can
  // (lib/native-voice.ts).
  recordVoiceNote?: (request: { id: string; summarize: boolean; serverTranscription: boolean }) => void;
  // The global shortcuts for the hardware keyboard: the app makes key
  // commands of them (lib/app-shortcuts.ts).
  shortcuts?: (commands: unknown[]) => void;
  // iPad: a page of the instance in a window of its own (only offered where
  // the app can open windows).
  openWindow?: (url: string) => void;
  // iPhone and iPad: handwriting recognition on the device; answers with
  // the event "flowplan:ink-recognized" (contract: lib/ink/recognition.ts).
  recognizeInk?: (request: import("./ink/recognition").InkRecognitionRequest) => void;
};

export function nativeApp(): FlowplanApp | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { FlowplanApp?: FlowplanApp }).FlowplanApp;
}

// The desktop app (flowplan-desktop) puts `window.FlowplanDesktop` into the
// pages of its own instance. Electron has no Web Push, so the desktop app
// fetches new notifications itself (GET /api/notifications) and shows them as
// system notifications with the badge on its icon. Older versions of the app
// have no bridge; they still name themselves in the user agent.
type FlowplanDesktop = {
  platform: "desktop";
  version: string;
  notifications?: {
    enabled: () => Promise<boolean>;
    setEnabled: (on: boolean) => Promise<boolean>;
    // Asks again at once (the badge after reading notifications).
    refresh?: () => void;
  };
  // The app's spell checker (Electron's, in the languages chosen in the
  // app): the text menu offers its suggestions for a misspelled word – the
  // editor keeps its own right-click menu, so the app's native one with the
  // suggestions does not appear there (desktop 1.1 and newer).
  spelling?: {
    check: (word: string) => { misspelled: boolean; suggestions: string[] };
    addWord: (word: string) => Promise<boolean>;
  };
  // A page of this instance in a window of its own (desktop 1.1 and newer).
  openWindow?: (url: string) => void;
};
export function desktopApp(): FlowplanDesktop | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { FlowplanDesktop?: FlowplanDesktop }).FlowplanDesktop;
}
export const inDesktopApp = () => typeof navigator !== "undefined" && /FlowplanDesktop\//.test(navigator.userAgent);

// A page in a window of its own: the iPad app and the desktop app can.
export function openInWindow(): ((url: string) => void) | undefined {
  const app = nativeApp()?.openWindow;
  if (app) return app;
  const desktop = desktopApp()?.openWindow;
  return desktop ? (url) => desktop(url) : undefined;
}

// "Open in desktop app": the page as a flowplan://open link, which the
// desktop app (installed on macOS, Windows or Linux) opens in the profile of
// this instance – or asks before adding the instance. Offered in a browser
// on a computer only: not inside the desktop app itself, not in the mobile
// apps, not on phones and tablets.
export function desktopPageLink(origin: string, pageId: string, rowId?: string | null) {
  const params = new URLSearchParams({ instance: origin, page: pageId });
  if (rowId) params.set("row", rowId);
  return `flowplan://open?${params}`;
}
export function offerDesktopApp(os: DeviceOS, inDesktop: boolean, app: { platform?: string } | undefined) {
  return !inDesktop && !app && (os === "macos" || os === "windows" || os === "linux");
}

// Why this device cannot keep an offline copy: the iPhone and iPad app's
// web view (WKWebView) runs no service worker for an instance's address –
// iOS allows them in apps only for a fixed list of domains – so the
// browser's way does not work there; elsewhere the browser lacks it (no
// secure connection, no service worker).
export function offlineUnsupportedReason(
  app: { platform?: string } | undefined = nativeApp(),
  agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): "ios-app" | "browser" {
  if (app?.platform === "ios") return "ios-app";
  if (!app && /FlowplanMobile\//.test(agent) && /iPhone|iPad|iPod|Macintosh/.test(agent)) return "ios-app";
  return "browser";
}

// Whether the app here can scan documents (newer iOS apps).
export const nativeScanAvailable = () => typeof nativeApp()?.scanDocument === "function";
export function nativeScan(pageId: string, rowId?: string) {
  try {
    nativeApp()?.scanDocument?.({ pageId, ...(rowId ? { rowId } : {}) });
  } catch {}
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
// Several changes in a row lead to one refresh.
export function nativeRefresh() {
  const app = nativeApp(),
    desktop = desktopApp()?.notifications;
  if (!app?.refresh && !desktop?.refresh) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    try {
      app?.refresh?.();
    } catch {}
    try {
      desktop?.refresh?.();
    } catch {}
  }, 800);
}

// Hands a file to the app; false when there is no app to take it.
export async function nativeSaveFile(name: string, blob: Blob) {
  const app = nativeApp();
  if (!app?.saveFile) return false;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  app.saveFile(name, btoa(binary), blob.type || "application/octet-stream");
  return true;
}
