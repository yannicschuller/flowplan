// Offline use offered by the mobile app (lib/app-offline-offer.ts, #203): what
// the page reports, when it says no, and switching on from the app's event.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LOW_STORAGE,
  OFFLINE_ENABLE_EVENT,
  OFFLINE_STATUS_EVENT,
  appOfflineReporter,
  appOfflineStatus,
  installAppOfflineOffer,
  type AppOfflineDeps,
  type AppOfflineStatus,
} from "../lib/app-offline-offer";

const base = {
  userId: "u1",
  supported: true,
  secure: true,
  guest: false,
  demo: false,
  online: true,
  marker: null,
  estimate: { quota: 10 * 1024 * 1024 * 1024, usage: 0 },
};

test("available only where the web app's switch would work", () => {
  assert.deepEqual(appOfflineStatus(base), { version: 1, available: true, enabled: false, busy: false });
  assert.equal(appOfflineStatus({ ...base, supported: false }).reason, "unsupported");
  // Android over plain HTTP: no service worker.
  assert.equal(appOfflineStatus({ ...base, supported: false, secure: false }).reason, "insecure");
  assert.equal(appOfflineStatus({ ...base, guest: true }).reason, "guest");
  assert.equal(appOfflineStatus({ ...base, demo: true }).reason, "demo");
  assert.equal(appOfflineStatus({ ...base, online: false }).reason, "offline");
  const low = appOfflineStatus({ ...base, estimate: { quota: LOW_STORAGE, usage: 1 } });
  assert.equal(low.available, false);
  assert.equal(low.reason, "storage");
  // An unknown quota is no reason to refuse (as fitsQuota).
  assert.equal(appOfflineStatus({ ...base, estimate: null }).available, true);
});

test("on for this person: the marker's facts; another person's copy does not count", () => {
  const marker = { user: "u1", since: 1000, lastRefresh: 2000, pages: 12, bytes: 3456, app: { bytes: 18_000_000 } };
  assert.deepEqual(appOfflineStatus({ ...base, marker }), {
    version: 1,
    available: true,
    enabled: true,
    busy: false,
    since: 1000,
    lastRefresh: 2000,
    pages: 12,
    bytes: 3456,
    appBytes: 18_000_000,
  });
  assert.equal(appOfflineStatus({ ...base, marker: { ...marker, user: "u2" } }).enabled, false);
  // Little room left does not hide a copy that is already there.
  assert.equal(appOfflineStatus({ ...base, marker, estimate: { quota: 10, usage: 9 } }).available, true);
});

test("without the app's offlineStatus (a browser, an older app) nothing is installed", () => {
  assert.equal(appOfflineReporter(undefined), null);
  assert.equal(appOfflineReporter({}), null);
  const target = new EventTarget();
  let enabled = 0;
  const stop = installAppOfflineOffer({ userId: "u1", workspaceId: "w1", guest: false, demo: false }, {
    ...deps(target, { app: { platform: "ios" } as never }),
    enable: async () => {
      enabled++;
      return { status: "done" };
    },
  });
  target.dispatchEvent(new Event(OFFLINE_ENABLE_EVENT));
  stop();
  assert.equal(enabled, 0);
});

function deps(target: EventTarget, over: Partial<AppOfflineDeps> = {}): AppOfflineDeps {
  return {
    app: undefined,
    target,
    changedEvent: "flowplan:offline-changed",
    supported: () => true,
    secure: () => true,
    online: () => true,
    marker: async () => null,
    estimate: async () => null,
    enable: async () => ({ status: "done" }),
    ...over,
  };
}
const tick = () => new Promise((done) => setTimeout(done, 5));

test("the app's event switches it on once, with progress, and the status follows", async () => {
  const target = new EventTarget();
  const reports: AppOfflineStatus[] = [];
  let marker: { user: string; since: number; pages?: number } | null = null;
  const calls: [string, string][] = [];
  const notices: unknown[] = [];
  const stop = installAppOfflineOffer(
    { userId: "u1", workspaceId: "w1", guest: false, demo: false },
    deps(target, {
      app: { offlineStatus: (status: AppOfflineStatus) => reports.push(status) },
      marker: async () => marker,
      enable: async (user, workspace, onProgress) => {
        calls.push([user, workspace]);
        onProgress(1, 3);
        await tick();
        marker = { user, since: 1, pages: 4 };
        onProgress(3, 3);
        return { status: "done" };
      },
      onProgress: (progress) => notices.push(progress),
      onResult: (result, pages) => notices.push([result, pages]),
    }),
  );
  await tick();
  assert.equal(reports.length, 1, "reported at the start");
  assert.equal(reports[0].available, true);
  assert.equal(reports[0].enabled, false);
  target.dispatchEvent(new Event(OFFLINE_ENABLE_EVENT));
  // A second ask while it runs starts nothing.
  target.dispatchEvent(new Event(OFFLINE_ENABLE_EVENT));
  await tick();
  await tick();
  await tick();
  assert.deepEqual(calls, [["u1", "w1"]]);
  assert.ok(reports.some((r) => r.busy && r.progress?.[0] === 1 && r.progress[1] === 3), "progress reported");
  const last = reports[reports.length - 1];
  assert.equal(last.busy, false);
  assert.equal(last.enabled, true);
  assert.equal(last.result, "done");
  assert.deepEqual(notices[notices.length - 1], ["done", 4]);
  // On already: asking again only reports.
  target.dispatchEvent(new Event(OFFLINE_ENABLE_EVENT));
  await tick();
  assert.equal(calls.length, 1);
  const before = reports.length;
  target.dispatchEvent(new Event(OFFLINE_STATUS_EVENT));
  await tick();
  assert.equal(reports.length, before + 1, "asked for: reported again");
  stop();
  target.dispatchEvent(new Event(OFFLINE_STATUS_EVENT));
  await tick();
  assert.equal(reports.length, before + 1, "nothing after the disconnect");
});

test("what the web app refuses is not switched on from the app either", async () => {
  const target = new EventTarget();
  const reports: AppOfflineStatus[] = [];
  let enabled = 0;
  const stop = installAppOfflineOffer(
    { userId: "u1", workspaceId: "w1", guest: true, demo: false },
    deps(target, {
      app: { offlineStatus: (status: AppOfflineStatus) => reports.push(status) },
      enable: async () => {
        enabled++;
        return { status: "done" };
      },
    }),
  );
  target.dispatchEvent(new Event(OFFLINE_ENABLE_EVENT));
  await tick();
  stop();
  assert.equal(enabled, 0);
  assert.equal(reports[reports.length - 1].reason, "guest");
});

test("the workspace connects it, for the signed-in person and the open workspace", () => {
  const app = readFileSync(new URL("../components/workspace-app.tsx", import.meta.url), "utf8");
  assert.match(app, /useAppOfflineOffer\(boot\.user\.id, boot\.workspace\.id, !!boot\.workspace\.guest, !!boot\.user\.demo\)/);
  assert.match(app, /\{appOfflineNotice\}/);
  const hook = readFileSync(new URL("../components/app-offline-offer.tsx", import.meta.url), "utf8");
  // The same switch-on as Settings → Offline & devices.
  assert.match(hook, /enable: enableOffline/);
});
