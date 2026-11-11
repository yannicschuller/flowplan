import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_PROFILES_LINK, appProfilesAction, desktopPageLink, desktopPasskeysInWindow, offerDesktopApp, offlineUnsupportedReason } from "../lib/native-app";

const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.4.0";
const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) FlowplanMobile/1.4.0";
const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 FlowplanMobile/1.4.0";
const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("the iPhone and iPad app is named as the reason, not the browser", () => {
  assert.equal(offlineUnsupportedReason({ platform: "ios" }, iphone), "ios-app");
  // Before the bridge is there, the user agent tells (iPadOS names itself a Mac).
  assert.equal(offlineUnsupportedReason(undefined, iphone), "ios-app");
  assert.equal(offlineUnsupportedReason(undefined, ipad), "ios-app");
  // Android's web view runs the service worker; Safari is a browser.
  assert.equal(offlineUnsupportedReason({ platform: "android" }, android), "browser");
  assert.equal(offlineUnsupportedReason(undefined, android), "browser");
  assert.equal(offlineUnsupportedReason(undefined, safari), "browser");
});

test("open in the desktop app: a flowplan://open link, offered in browsers on computers only", () => {
  const page = "3f2b8c1e-7d4a-4b6e-9a1c-2e5f6a7b8c9d";
  // flowplan-desktop's deep-links.js reads exactly this form.
  assert.equal(desktopPageLink("https://flowplan.example.com", page), `flowplan://open?instance=https%3A%2F%2Fflowplan.example.com&page=${page}`);
  assert.equal(desktopPageLink("http://localhost:3000", page, page), `flowplan://open?instance=http%3A%2F%2Flocalhost%3A3000&page=${page}&row=${page}`);
  for (const os of ["macos", "windows", "linux"] as const) assert.equal(offerDesktopApp(os, false, undefined), true, os);
  assert.equal(offerDesktopApp("macos", true, undefined), false, "not inside the desktop app");
  assert.equal(offerDesktopApp("macos", false, { platform: "ios" }), false, "not in the iPad app (iPadOS names itself a Mac)");
  for (const os of ["ios", "ipados", "android", "chromeos", "unknown"] as const) assert.equal(offerDesktopApp(os, false, undefined), false, os);
});

test("sign-in pages: \"Other server? Switch profile\" only inside the mobile app (#69)", () => {
  const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Electron/38.0 Safari/537.36 FlowplanDesktop/1.1.0";
  const openProfiles = () => {};
  // Newer apps: their bridge opens the profiles (and brings the person back).
  assert.equal(appProfilesAction({ platform: "ios", openProfiles }, iphone), "bridge");
  assert.equal(appProfilesAction({ platform: "android", openProfiles }, android), "bridge");
  // Older apps: the link every version since 1.0.1 hands to its profiles.
  assert.equal(appProfilesAction({ platform: "ios" }, iphone), "link");
  assert.equal(appProfilesAction({ platform: "android" }, android), "link");
  assert.equal(appProfilesAction(undefined, ipad), "link", "before the bridge, the user agent tells");
  assert.equal(APP_PROFILES_LINK, "flowplan://change-server");
  // A broken bridge entry is no bridge.
  assert.equal(appProfilesAction({ platform: "ios", openProfiles: "yes" }, iphone), "link");
  // Browsers and the desktop app: nothing.
  assert.equal(appProfilesAction(undefined, safari), null);
  assert.equal(appProfilesAction(undefined, desktop), null);
  assert.equal(appProfilesAction(undefined, ""), null);
});

test("the profiles link sits on the pages before signing in, not in the signed-in app", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  for (const page of ["components/reset-password.tsx", "components/two-factor.tsx"]) assert.match(read(page), /<AppProfilesLink \/>/, page);
  // The sign-in page: "Anderer Server" in its quiet line under the buttons,
  // and the full line in its other steps (registration, reset link).
  assert.match(read("components/login.tsx"), /<AppProfilesLink inline \/>/);
  assert.match(read("components/login.tsx"), /<AppProfilesLink \/>/);
  // Signed in, the app's settings hold the profiles (Settings → Notifications → Open app settings).
  assert.doesNotMatch(read("components/workspace-app.tsx"), /AppProfilesLink/);
});

test("passkeys in the desktop app's window only where the app says so – Windows Hello (#165)", async () => {
  const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Electron/44.9.3 Safari/537.36 FlowplanDesktop/1.3.2";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Electron/44.9.3 Safari/537.36 FlowplanDesktop/1.3.2";
  assert.equal(desktopPasskeysInWindow({ passkeys: "window" }, windows), true);
  // macOS and Linux: the browser; older apps have no answer: the browser.
  assert.equal(desktopPasskeysInWindow({ passkeys: "browser" }, mac), false);
  assert.equal(desktopPasskeysInWindow({}, windows), false);
  assert.equal(desktopPasskeysInWindow(undefined, windows), false);
  // Only the desktop app's bridge counts; a browser has none.
  assert.equal(desktopPasskeysInWindow({ passkeys: "window" }, safari), false);
  assert.equal(desktopPasskeysInWindow({ passkeys: "window" }, iphone), false);
  // The sign-in page: the hand-off link only where passkeys go to the
  // browser, the page's own button in the Windows app, and after a failure
  // there "Im Browser anmelden" – the hand-off after all.
  const { readFileSync } = await import("node:fs");
  const login = readFileSync(new URL("../components/login.tsx", import.meta.url), "utf8");
  assert.match(login, /setPasskeyInApp\(desktopPasskeysInWindow\(\) && browserSupportsWebAuthn\(\)\)/);
  assert.match(login, /passkeyHandOff = desktopApp && !passkeyInApp/);
  assert.match(login, /\{passkeyHandOff && \(\s*<a/);
  assert.match(login, /const passkeyButton = localLogin && passkeys && \(!desktopApp \|\| passkeyInApp\);/);
  assert.match(login, /\{passkeyButton && \(\s*<button className=\{wayClass\("passkey"\)\} onClick=\{passkey\}/);
  assert.match(login, /passkeyInApp && passkeyFallback && \([\s\S]{0,200}href="\/api\/auth\/desktop"\s*onClick=\{handOff\("passkey"\)\}/);
  // SSO keeps going to the browser in every app.
  assert.match(login, /href=\{desktopApp \? "\/api\/auth\/desktop\?via=sso"/);
});
