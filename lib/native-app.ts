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
};

export function nativeApp(): FlowplanApp | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { FlowplanApp?: FlowplanApp }).FlowplanApp;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
// Several changes in a row lead to one refresh.
export function nativeRefresh() {
  const app = nativeApp();
  if (!app?.refresh) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    try {
      app.refresh?.();
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
