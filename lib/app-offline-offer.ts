// Offline use offered by the iPhone, iPad and Android app (flowplan-app
// src/offline-offer.ts, #203): once per profile the app asks natively
// whether to keep this workspace on the device. For that the page tells the
// app where offline use stands here, and switches it on when the app asks –
// the same as the switch in Settings → Offline & devices
// (components/offline-settings.tsx), for the signed-in person and the open
// workspace.
//
//   page → app: window.FlowplanApp.offlineStatus(status) – at the start, when
//               the copy changes, while it is being stored and when asked.
//               Only apps that have offlineStatus hear anything; that the page
//               calls it at all tells the app this instance can do it (older
//               instances never call it, so the app never asks there).
//   app → page: the event "flowplan:offline-enable" (switch it on, with
//               progress), "flowplan:offline-status" (report again).
//
// Whatever the web app refuses, the status says, and the app does not ask:
// no offline support (iOS app without its store, Android over plain HTTP,
// browsers without a service worker), guests and the demo, too little room,
// no connection.
export const OFFLINE_ENABLE_EVENT = "flowplan:offline-enable";
export const OFFLINE_STATUS_EVENT = "flowplan:offline-status";
export const APP_OFFLINE_VERSION = 1;
// Less free room than this: not offered (the app alone is 15–20 MB).
export const LOW_STORAGE = 200 * 1024 * 1024;

export type AppOfflineReason = "unsupported" | "insecure" | "guest" | "demo" | "storage" | "offline";
export type AppOfflineResult = "done" | "incomplete" | "signed-out" | "failed";
export type AppOfflineStatus = {
  version: number;
  // Offline use can be switched on here now.
  available: boolean;
  reason?: AppOfflineReason;
  // On for this person on this device.
  enabled: boolean;
  // Being stored right now (switched on from the app or the settings).
  busy: boolean;
  progress?: [number, number];
  // How the last run started from the app ended.
  result?: AppOfflineResult;
  // From the copy's marker (components/offline.ts OfflineMarker).
  since?: number;
  lastRefresh?: number;
  pages?: number;
  bytes?: number;
  appBytes?: number;
};

type Marker = {
  user: string;
  since?: number;
  lastRefresh?: number;
  pages?: number;
  bytes?: number;
  app?: { bytes?: number };
};
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

export function appOfflineStatus(input: {
  userId: string;
  supported: boolean;
  secure: boolean;
  guest: boolean;
  demo: boolean;
  online: boolean;
  marker: Marker | null;
  estimate: { quota?: number; usage?: number } | null;
  busy?: boolean;
  progress?: [number, number] | null;
  result?: AppOfflineResult | null;
}): AppOfflineStatus {
  const marker = input.marker && input.marker.user === input.userId ? input.marker : null;
  const free = input.estimate?.quota ? input.estimate.quota - (input.estimate.usage || 0) : null;
  const reason: AppOfflineReason | undefined = !input.supported
    ? input.secure
      ? "unsupported"
      : "insecure"
    : input.guest
      ? "guest"
      : input.demo
        ? "demo"
        : !input.online
          ? "offline"
          : !marker && free !== null && free < LOW_STORAGE
            ? "storage"
            : undefined;
  const status: AppOfflineStatus = {
    version: APP_OFFLINE_VERSION,
    available: !reason,
    enabled: !!marker,
    busy: !!input.busy,
  };
  if (reason) status.reason = reason;
  if (input.busy && input.progress) status.progress = [input.progress[0], input.progress[1]];
  if (input.result) status.result = input.result;
  if (marker) {
    const values = { since: num(marker.since), lastRefresh: num(marker.lastRefresh), pages: num(marker.pages), bytes: num(marker.bytes), appBytes: num(marker.app?.bytes) };
    for (const [key, value] of Object.entries(values)) if (value !== undefined) (status as Record<string, unknown>)[key] = value;
  }
  return status;
}

type App = { offlineStatus?: unknown } | undefined;
// The app's report function, when the app has one.
export function appOfflineReporter(app: App): ((status: AppOfflineStatus) => void) | null {
  const report = app?.offlineStatus;
  if (typeof report !== "function") return null;
  return (status) => {
    try {
      report.call(app, status);
    } catch {}
  };
}

export type AppOfflineDeps = {
  app: App;
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  // The event components/offline.ts fires after the marker changed.
  changedEvent: string;
  supported: () => boolean;
  secure: () => boolean;
  online: () => boolean;
  marker: () => Promise<Marker | null>;
  estimate: () => Promise<{ quota?: number; usage?: number } | null>;
  enable: (
    userId: string,
    workspaceId: string,
    onProgress: (done: number, total: number) => void,
  ) => Promise<{ status: string }>;
  // The page's own notice while storing and after it (optional).
  onProgress?: (progress: [number, number] | null) => void;
  onResult?: (result: AppOfflineResult, pages: number | undefined) => void;
};

// Connects the page with the app; returns the disconnect. Nothing happens
// without an app that listens (a browser, an older app).
export function installAppOfflineOffer(
  person: { userId: string; workspaceId: string; guest: boolean; demo: boolean },
  deps: AppOfflineDeps,
): () => void {
  const report = appOfflineReporter(deps.app);
  if (!report) return () => {};
  let stopped = false,
    busy = false,
    progress: [number, number] | null = null,
    result: AppOfflineResult | null = null,
    sent = "";
  const status = async () =>
    appOfflineStatus({
      ...person,
      supported: deps.supported(),
      secure: deps.secure(),
      online: deps.online(),
      marker: deps.supported() ? await deps.marker().catch(() => null) : null,
      estimate: deps.supported() ? await deps.estimate().catch(() => null) : null,
      busy,
      progress,
      result,
    });
  // Every change once; asked for, always.
  const send = async (always = false) => {
    const next = await status();
    if (stopped) return;
    const text = JSON.stringify(next);
    if (!always && text === sent) return;
    sent = text;
    report(next);
  };
  const enable = async () => {
    const current = await status();
    if (stopped || busy || !current.available || current.enabled) return void send(true);
    busy = true;
    progress = [0, 1];
    result = null;
    deps.onProgress?.(progress);
    void send();
    try {
      const answer = await deps.enable(person.userId, person.workspaceId, (done, total) => {
        progress = [done, total];
        deps.onProgress?.(progress);
        void send();
      });
      result = answer.status === "signed-out" ? "signed-out" : answer.status === "incomplete" ? "incomplete" : answer.status === "done" ? "done" : "failed";
    } catch {
      result = "failed";
    } finally {
      busy = false;
      progress = null;
      deps.onProgress?.(null);
    }
    if (stopped) return;
    deps.onResult?.(result, (await deps.marker().catch(() => null))?.pages);
    void send(true);
  };
  const onEnable = () => void enable();
  const onStatus = () => void send(true);
  const onChanged = () => void send();
  deps.target.addEventListener(OFFLINE_ENABLE_EVENT, onEnable);
  deps.target.addEventListener(OFFLINE_STATUS_EVENT, onStatus);
  deps.target.addEventListener(deps.changedEvent, onChanged);
  deps.target.addEventListener("online", onChanged);
  deps.target.addEventListener("offline", onChanged);
  void send(true);
  return () => {
    stopped = true;
    deps.target.removeEventListener(OFFLINE_ENABLE_EVENT, onEnable);
    deps.target.removeEventListener(OFFLINE_STATUS_EVENT, onStatus);
    deps.target.removeEventListener(deps.changedEvent, onChanged);
    deps.target.removeEventListener("online", onChanged);
    deps.target.removeEventListener("offline", onChanged);
  };
}
