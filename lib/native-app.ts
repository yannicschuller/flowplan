import { useSyncExternalStore } from "react";
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
  // The app's profiles: switch to or add another instance, or change the
  // address of one never signed in (#69; app 1.1 and newer).
  openProfiles?: () => void;
  // The app's own sheet of its profiles (name, address, the active one
  // checked; add and manage): "Instanz wechseln …" in the workspace menu and
  // a long press on the own account row. Takes nothing and answers nothing –
  // the page never learns the person's other instances.
  openProfileSwitcher?: () => void;
  // Whether "back" (window.FlowplanNavigation, lib/app-back.ts) would do
  // something: the app offers its back gesture only then.
  backState?: (canGoBack: boolean) => void;
  // iPhone and iPad (apps newer than 1.0.12, #285): what the swipe from the
  // left edge does – "drawer" turns the app's back swipe off (the page opens
  // the sidebar from the very edge), "back" keeps it (lib/edge-swipe.ts).
  // Apps without it keep their back swipe.
  edgeSwipe?: (mode: "drawer" | "back", options?: { android?: boolean }) => void;
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
  // Sign-in with passkeys ("passkey" is null) or SSO through the system's
  // sheet, answered with the event "flowplan:sign-in" (lib/app-sign-in.ts;
  // apps newer than 1.0.5, #109).
  signIn?: (via: "sso" | null) => void;
  // Adding a passkey in the system's sign-in sheet (apps newer than 1.0.17):
  // the one-time link of /api/auth/passkey-app-link, answered with the
  // event "flowplan:passkey" ({ status: "added" | "cancelled" | "failed" };
  // lib/app-passkey.ts).
  addPasskey?: (url: string) => void;
  // This device's key for this instance (apps newer than 1.0.5): the
  // password form sends it, so the sign-in lasts as long as the app's
  // (lib/app-devices.ts).
  deviceKey?: AppDeviceKey;
  // Where offline use stands on this device (apps newer than 1.0.11): the
  // app offers to switch it on once and shows it in its settings; it asks
  // with the events "flowplan:offline-enable" / "flowplan:offline-status"
  // (lib/app-offline-offer.ts).
  offlineStatus?: (status: import("./app-offline-offer").AppOfflineStatus) => void;
  // Printing (#424; apps newer than 1.1.2): their web views ignore
  // window.print(), so the page hands its lean print copy – styles and
  // pictures inside, at most lib/print-way.ts APP_PRINT_MAX_CHARS – to the
  // app, which opens the system's print dialog (a printer or "Save as PDF").
  print?: (request: import("./print-way").AppPrintRequest) => void;
};
// Made by the app per instance on first launch, kept in the system's key
// store: a public id and its secret.
export type AppDeviceKey = { id: string; secret: string };

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
  // Back and forward (#125, lib/history-nav.ts): the page reports whether
  // there is a step (the menu items' state) and runs the app's commands –
  // the menu items, the trackpad's swipe, the mouse's side buttons.
  history?: import("./history-nav").DesktopHistory;
  // This computer's key for this instance (desktop newer than 1.3.0),
  // like FlowplanApp.deviceKey.
  deviceKey?: AppDeviceKey;
  // Where passkeys sign in (#165, desktop newer than 1.3.1): "window" – the
  // page's own WebAuthn, Windows Hello over the app (Windows) – or
  // "browser", the hand-off to the system browser (macOS, Linux).
  passkeys?: "window" | "browser";
  // The operating system (desktop newer than 1.3.12): "darwin", "win32" or
  // "linux". Older apps: the user agent tells (desktopOnMac).
  os?: string;
  // "Im Marketplace veröffentlichen …" (desktop newer than 1.3.7): the page
  // arms its next window.open to the marketplace (the configured origin),
  // which then opens in a window of the app with window.opener for the
  // hand-over (lib/marketplace-handover.ts) – older apps send every other
  // site to the system browser, without an opener.
  marketplaceWindow?: boolean;
  armMarketplaceWindow?: (origin: string) => boolean;
  // "Passkey hinzufügen" through the default browser (desktop newer than
  // 1.3.11, macOS): opens the one-time link of /api/auth/passkey-app-link
  // there (only on the window's own instance); true when it opened. The
  // window learns the result from passkey-app-status (lib/app-passkey.ts).
  addPasskeyInBrowser?: (url: string) => Promise<boolean>;
};
export function desktopApp(): FlowplanDesktop | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { FlowplanDesktop?: FlowplanDesktop }).FlowplanDesktop;
}
// Passkeys right here in the desktop app's window (#165): only where the app
// says so – on Windows, where Chromium hands WebAuthn to Windows Hello.
// Older apps and the app on macOS and Linux hand passkeys to the browser
// (lib/desktop-sign-in.ts).
export function desktopPasskeysInWindow(
  app: { passkeys?: unknown } | undefined = desktopApp(),
  agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  return /FlowplanDesktop\//.test(agent) && app?.passkeys === "window";
}
// The desktop app on a Mac: the bridge says so (os, desktop newer than
// 1.3.12), older apps by their user agent (Electron's "Macintosh").
export function desktopOnMac(
  app: { os?: unknown } | undefined = desktopApp(),
  agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  if (!/FlowplanDesktop\//.test(agent)) return false;
  if (typeof app?.os === "string" && app.os) return app.os === "darwin";
  return /\bMacintosh\b|\bMac OS X\b/.test(agent);
}
// How the sign-in page offers passkeys in the desktop app: "browser" – the
// hand-off only (macOS without Touch ID, Linux, older apps); "window" – the
// page's own WebAuthn, Windows Hello over the app (#165); "keychain" – a Mac
// whose window has Touch ID (#356): that authenticator only sees passkeys
// made in the app, never the iCloud Keychain, so "Mit Passkey anmelden" is
// the hand-off (the browser has the Keychain) and the app's Touch ID the
// second way. null: not the desktop app.
export type DesktopPasskeySignIn = "browser" | "window" | "keychain";
export function desktopPasskeySignIn(
  app: { passkeys?: unknown; os?: unknown } | undefined = desktopApp(),
  agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): DesktopPasskeySignIn | null {
  if (!/FlowplanDesktop\//.test(agent)) return null;
  if (!desktopPasskeysInWindow(app, agent)) return "browser";
  return desktopOnMac(app, agent) ? "keychain" : "window";
}
// The desktop app where its window cannot create or use passkeys (macOS and
// Linux, and older apps): Electron offers no authenticator there, so
// navigator.credentials never answers. Adding one goes through the browser.
export function desktopPasskeysInBrowser(
  app: { passkeys?: unknown } | undefined = desktopApp(),
  agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  return /FlowplanDesktop\//.test(agent) && !desktopPasskeysInWindow(app, agent);
}
// The desktop app can open "Passkey hinzufügen" in the default browser
// (addPasskeyInBrowser): on a Mac the passkey then lands in the iCloud
// Keychain instead of only this app's Touch ID. Older apps keep their way.
export function desktopPasskeyLink(
  app: { addPasskeyInBrowser?: unknown } | undefined = desktopApp(),
  agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  return /FlowplanDesktop\//.test(agent) && typeof app?.addPasskeyInBrowser === "function";
}
// The iPhone, iPad and Android app: its web view offers passkeys only for
// domains built into the app, never for a self-hosted instance, so adding
// one fails there ("Passkey wurde nicht angelegt"). Signing in already goes
// through the system browser (lib/desktop-sign-in.ts); adding one does too.
// "open": the app can open the page in the browser (openInBrowser),
// "note": an older app – say where to do it; null: not in the app. Apps with
// addPasskey make it in the sign-in sheet instead (lib/app-passkey.ts).
export function appPasskeysInBrowser(
  app: { platform?: string; openInBrowser?: unknown } | undefined = nativeApp(),
  agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): "open" | "note" | null {
  const inApp = !!app || /\bFlowplanMobile\//.test(agent);
  if (!inApp) return null;
  return typeof app?.openInBrowser === "function" ? "open" : "note";
}
// The device key of the app the page runs in, if it has one (checked; the
// server checks again). Without one – a browser, or an older app – a
// password sign-in lasts like a browser's.
export function appDeviceKey(
  app: { deviceKey?: unknown } | undefined = nativeApp() ?? desktopApp(),
): AppDeviceKey | null {
  const key = app?.deviceKey as Partial<AppDeviceKey> | undefined;
  if (!key || typeof key !== "object") return null;
  const { id, secret } = key;
  return typeof id === "string" && typeof secret === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(id) && /^[A-Za-z0-9_-]{32,128}$/.test(secret)
    ? { id, secret }
    : null;
}
export const inDesktopApp = () => typeof navigator !== "undefined" && /FlowplanDesktop\//.test(navigator.userAgent);

// Inside one of the Flowplan apps – iPhone, iPad, Android (FlowplanApp) or
// the desktop app (FlowplanDesktop) – rather than a browser: by the bridge
// or, for older apps without one, the user agent. Texts that speak of "the
// browser" say "the device" there. Pure, for the tests.
export function flowplanAppHost(
  host: { FlowplanApp?: unknown; FlowplanDesktop?: unknown } | undefined = typeof window === "undefined" ? undefined : (window as never),
  agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  return !!host?.FlowplanApp || !!host?.FlowplanDesktop || /\bFlowplan(Mobile|Desktop)\//.test(agent);
}
// The same for rendering: false on the server and in the first render,
// so hydration matches; the app's answer right after.
const noChange = () => () => {};
export function useInFlowplanApp(): boolean {
  return useSyncExternalStore(noChange, () => flowplanAppHost(), () => false);
}

// How "Im Marketplace veröffentlichen …" reaches the marketplace's submit
// page. "handover": window.open with an opener and the package by
// postMessage – in a browser, and in a desktop app that opens the
// marketplace in a window of its own (marketplaceWindow). "desktop-file":
// older desktop apps open other sites in the system browser, without an
// opener; "app-file": the iPhone, iPad and Android app's web view does the
// same. Both get the package as a file and the marketplace's submit page
// to upload it.
export type MarketplacePublishWay = "handover" | "desktop-file" | "app-file";
export function marketplacePublishWay(
  desktop: { marketplaceWindow?: unknown; armMarketplaceWindow?: unknown } | undefined = desktopApp(),
  app: { platform?: string } | undefined = nativeApp(),
  agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): MarketplacePublishWay {
  if (app?.platform === "ios" || app?.platform === "android" || /\bFlowplanMobile\//.test(agent)) return "app-file";
  if (desktop || /FlowplanDesktop\//.test(agent))
    return desktop?.marketplaceWindow === true && typeof desktop.armMarketplaceWindow === "function" ? "handover" : "desktop-file";
  return "handover";
}
// Arms the desktop app's marketplace window right before window.open (a
// no-op elsewhere); false when the app did not arm it.
export function armDesktopMarketplace(origin: string, desktop: Pick<FlowplanDesktop, "marketplaceWindow" | "armMarketplaceWindow"> | undefined = desktopApp()) {
  try {
    return desktop?.marketplaceWindow === true && desktop.armMarketplaceWindow?.(origin) === true;
  } catch {
    return false;
  }
}

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

// "Other server? Switch profile" at the bottom of the sign-in pages (#69):
// inside the iPhone, iPad and Android app the way to its profiles – another
// instance, or another address for this one before signing in. "bridge":
// the app's openProfiles (app 1.1+, which brings the person back to this
// page on Cancel); "link": older apps, whose web view hands the link
// flowplan://change-server to the app (every version since 1.0.1 opens its
// profiles with it, the same as the icon's quick action). Nothing in a
// browser or the desktop app, which keeps its instances itself.
export const APP_PROFILES_LINK = "flowplan://change-server";
export function appProfilesAction(
  app: { platform?: string; openProfiles?: unknown } | undefined = nativeApp(),
  agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): "bridge" | "link" | null {
  if (app && typeof app.openProfiles === "function") return "bridge";
  if (app?.platform === "ios" || app?.platform === "android" || /\bFlowplanMobile\//.test(agent)) return "link";
  return null;
}
export function openAppProfiles() {
  try {
    nativeApp()?.openProfiles?.();
  } catch {}
}

// "Instanz wechseln …" in the workspace menu and the long press on the own
// account row: inside the iPhone, iPad and Android app only. "switcher": the
// app's own sheet of its profiles (openProfileSwitcher); "profiles": older
// apps with openProfiles only get their profile screen; null: nothing (a
// browser, the desktop app with its own menu and ⇧⌘P, apps before
// openProfiles). Pure, for the tests.
export type ProfileSwitcherWay = "switcher" | "profiles";
export function profileSwitcherWay(
  app: { openProfileSwitcher?: unknown; openProfiles?: unknown } | undefined = nativeApp(),
): ProfileSwitcherWay | null {
  if (typeof app?.openProfileSwitcher === "function") return "switcher";
  if (typeof app?.openProfiles === "function") return "profiles";
  return null;
}
// The same for rendering: null on the server and in the first render.
export function useProfileSwitcherWay(): ProfileSwitcherWay | null {
  return useSyncExternalStore(noChange, () => profileSwitcherWay(), () => null);
}
export function openProfileSwitcher(app: Pick<FlowplanApp, "openProfileSwitcher" | "openProfiles"> | undefined = nativeApp()) {
  const way = profileSwitcherWay(app);
  try {
    if (way === "switcher") app?.openProfileSwitcher?.();
    else if (way === "profiles") app?.openProfiles?.();
  } catch {}
  return way;
}

// A long press (half a second, the finger still) on the own account row
// opens the switcher; the click and context menu that end it do nothing
// else. The row's buttons keep their own press. Returns a function that
// stops waiting.
export const PROFILE_HOLD_MS = 500;
const CAPTURE = { capture: true } as const;
export function holdForProfileSwitcher(
  event: { pointerId: number; clientX: number; clientY: number; button: number; target: EventTarget | null },
  open: () => unknown = openProfileSwitcher,
): () => void {
  const target = typeof Element === "undefined" ? null : event.target instanceof Element ? event.target : null;
  if (event.button !== 0 || target?.closest("button, a, [role=menuitem]")) return () => {};
  const { pointerId, clientX: x0, clientY: y0 } = event;
  let fired = false;
  // Once the hold opened the switcher, the click and context menu that end
  // the press are its own (released a moment after the finger lifts).
  const swallow = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  const release = () => {
    window.removeEventListener("click", swallow, CAPTURE);
    window.removeEventListener("contextmenu", swallow, CAPTURE);
  };
  const move = (ev: PointerEvent) => {
    if (!fired && ev.pointerId === pointerId && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) stop();
  };
  const end = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) stop();
  };
  const stop = () => {
    clearTimeout(timer);
    window.removeEventListener("pointermove", move, CAPTURE);
    window.removeEventListener("pointerup", end, CAPTURE);
    window.removeEventListener("pointercancel", end, CAPTURE);
    window.removeEventListener("blur", stop);
    if (fired) setTimeout(release, 400);
  };
  const timer = setTimeout(() => {
    fired = true;
    window.addEventListener("click", swallow, CAPTURE);
    window.addEventListener("contextmenu", swallow, CAPTURE);
    // However the press ends, nothing stays swallowed for long.
    setTimeout(release, 5000);
    open();
  }, PROFILE_HOLD_MS);
  window.addEventListener("pointermove", move, CAPTURE);
  window.addEventListener("pointerup", end, CAPTURE);
  window.addEventListener("pointercancel", end, CAPTURE);
  window.addEventListener("blur", stop);
  return stop;
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
