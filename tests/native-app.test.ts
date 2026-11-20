import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_PROFILES_LINK,
  appPasskeysInBrowser,
  appProfilesAction,
  armDesktopMarketplace,
  desktopOnMac,
  desktopPageLink,
  desktopPasskeySignIn,
  desktopPasskeysInBrowser,
  desktopPasskeysInWindow,
  desktopPasskeyLink,
  flowplanAppHost,
  holdForProfileSwitcher,
  marketplacePublishWay,
  offerDesktopApp,
  offlineUnsupportedReason,
  openProfileSwitcher,
  PROFILE_HOLD_MS,
  profileSwitcherWay,
} from "../lib/native-app";
import { readFileSync } from "node:fs";

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
  // Adding a passkey in the settings: in the browser wherever the window has
  // no authenticator (the app on macOS and Linux, older apps), never in a
  // browser or the Windows app.
  assert.equal(desktopPasskeysInBrowser({ passkeys: "browser" }, mac), true);
  assert.equal(desktopPasskeysInBrowser({}, windows), true);
  assert.equal(desktopPasskeysInBrowser({ passkeys: "window" }, windows), false);
  assert.equal(desktopPasskeysInBrowser(undefined, safari), false);
  // The sign-in page: the hand-off link only where passkeys go to the
  // browser, the page's own button in the Windows app, and after a failure
  // there "Im Browser anmelden" – the hand-off after all.
  const { readFileSync } = await import("node:fs");
  const login = readFileSync(new URL("../components/login.tsx", import.meta.url), "utf8");
  assert.match(login, /setPasskeyInApp\(desktopPasskeys !== null && desktopPasskeys !== "browser" && browserSupportsWebAuthn\(\)\)/);
  assert.match(login, /passkeyHandOff = desktopApp && \(!passkeyInApp \|\| passkeyKeychain\)/);
  assert.match(login, /\{passkeyHandOff && \(\s*<a/);
  assert.match(login, /const passkeyButton = localLogin && passkeys && \(!desktopApp \|\| passkeyInApp\);/);
  assert.match(login, /\{passkeyButton && !passkeyTouchId && \(\s*<button className=\{wayClass\("passkey"\)\} onClick=\{passkey\}/);
  assert.match(login, /passkeyInApp && passkeyFallback === "failed" && !passkeyKeychain && \([\s\S]{0,200}\{browserPasskeyLink\}/);
  assert.match(login, /const browserPasskeyLink = \(\s*<a\s*href="\/api\/auth\/desktop"\s*onClick=\{handOff\("passkey"\)\}/);
  // SSO keeps going to the browser in every app.
  assert.match(login, /href=\{desktopApp \? "\/api\/auth\/desktop\?via=sso"/);
});

test("the Mac app signs in with the Keychain through the browser first, its own Touch ID second", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Electron/45.0.0 Safari/537.36 FlowplanDesktop/1.3.12";
  const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Electron/45.0.0 Safari/537.36 FlowplanDesktop/1.3.12";
  const linux = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Electron/45.0.0 Safari/537.36 FlowplanDesktop/1.3.12";
  // The bridge's os wins; older apps without it: the user agent.
  assert.equal(desktopOnMac({ os: "darwin" }, mac), true);
  assert.equal(desktopOnMac({}, mac), true);
  assert.equal(desktopOnMac(undefined, mac), true);
  assert.equal(desktopOnMac({ os: "win32" }, mac), false, "the bridge decides");
  assert.equal(desktopOnMac({ os: "darwin" }, windows), true, "the bridge decides");
  assert.equal(desktopOnMac({}, windows), false);
  assert.equal(desktopOnMac({}, linux), false);
  // Not the desktop app: Safari on a Mac, the iPad app (which names itself a Mac).
  assert.equal(desktopOnMac({ os: "darwin" }, mac.replace(/ Electron\S+| FlowplanDesktop\S+/g, "")), false);
  assert.equal(desktopOnMac(undefined, ipad), false);
  // The sign-in: Touch ID in the Mac app's window is the second way.
  assert.equal(desktopPasskeySignIn({ passkeys: "window", os: "darwin" }, mac), "keychain");
  assert.equal(desktopPasskeySignIn({ passkeys: "window" }, mac), "keychain", "1.3.12 and older: the user agent");
  assert.equal(desktopPasskeySignIn({ passkeys: "browser", os: "darwin" }, mac), "browser");
  assert.equal(desktopPasskeySignIn({ passkeys: "window", os: "win32" }, windows), "window", "Windows unchanged");
  assert.equal(desktopPasskeySignIn({ passkeys: "window" }, windows), "window");
  assert.equal(desktopPasskeySignIn({ passkeys: "window", os: "linux" }, linux), "window", "FLOWPLAN_PASSKEYS=window on Linux");
  assert.equal(desktopPasskeySignIn({ passkeys: "browser" }, linux), "browser");
  assert.equal(desktopPasskeySignIn({}, windows), "browser", "older apps");
  assert.equal(desktopPasskeySignIn({ passkeys: "window" }, safari), null);
  assert.equal(desktopPasskeySignIn(undefined, iphone), null);
  // The page: the hand-off with its note on the Mac, Touch ID as a quiet
  // line below it, and an unknown passkey links to the browser in the error.
  const login = readFileSync(new URL("../components/login.tsx", import.meta.url), "utf8");
  assert.match(login, /setPasskeyKeychain\(desktopPasskeys === "keychain" && browserSupportsWebAuthn\(\)\)/);
  assert.match(login, /\{passkeyHandOff && desktopMac && \(\s*<p id=\{keychainNote\}/);
  assert.match(login, /const passkeyTouchId = passkeyButton && passkeyKeychain;/);
  assert.match(login, /\{passkeyTouchId && \([\s\S]{0,300}onClick=\{passkey\}[\s\S]{0,200}"Mit Touch ID dieser App"/);
  assert.match(login, /setPasskeyFallback\(\(e as \{ status\?: number \}\)\.status === 401 \? "unknown" : "failed"\)/);
  assert.match(login, /passkeyFallback === "unknown" && \([\s\S]{0,300}"Passkey aus dem Schlüsselbund\?"[\s\S]{0,200}\{browserPasskeyLink\}/);
  // The server's answer for an unknown passkey is the 401 this looks for.
  const auth = readFileSync(new URL("../lib/local-auth.ts", import.meta.url), "utf8");
  assert.match(auth, /new HttpError\(401, t\("Dieser Passkey ist hier nicht bekannt\."/);
});

test("publishing to the marketplace: the hand-over only where the window can have an opener", () => {
  const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36 FlowplanDesktop/1.3.8";
  const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36";
  const arm = () => true;
  assert.equal(marketplacePublishWay(undefined, undefined, chrome), "handover", "a browser");
  assert.equal(marketplacePublishWay(undefined, undefined, safari), "handover");
  // The desktop app opens the marketplace in a window of its own only when it says so (1.3.8+).
  assert.equal(marketplacePublishWay({ marketplaceWindow: true, armMarketplaceWindow: arm }, undefined, desktop), "handover");
  assert.equal(marketplacePublishWay({}, undefined, desktop), "desktop-file", "1.3.7 and older: the system browser, no opener");
  assert.equal(marketplacePublishWay(undefined, undefined, desktop), "desktop-file", "an app without the bridge");
  assert.equal(marketplacePublishWay({ marketplaceWindow: true }, undefined, desktop), "desktop-file", "no way to arm it");
  assert.equal(marketplacePublishWay({ marketplaceWindow: "yes", armMarketplaceWindow: arm }, undefined, desktop), "desktop-file");
  // The mobile apps' web view hands target=_blank to the browser.
  assert.equal(marketplacePublishWay(undefined, { platform: "ios" }, iphone), "app-file");
  assert.equal(marketplacePublishWay(undefined, { platform: "android" }, android), "app-file");
  assert.equal(marketplacePublishWay(undefined, undefined, ipad), "app-file", "before the bridge: the user agent");
  // Arming: only the desktop app's own call, never throwing.
  const seen: string[] = [];
  assert.equal(armDesktopMarketplace("https://marketplace.flowplan.org", { marketplaceWindow: true, armMarketplaceWindow: (o) => (seen.push(o), true) }), true);
  assert.deepEqual(seen, ["https://marketplace.flowplan.org"]);
  assert.equal(armDesktopMarketplace("https://m.example", undefined), false);
  assert.equal(armDesktopMarketplace("https://m.example", { armMarketplaceWindow: () => true }), false, "without the capability");
  assert.equal(armDesktopMarketplace("https://m.example", { marketplaceWindow: true, armMarketplaceWindow: () => { throw new Error("gone"); } }), false);
});

test("the publish dialog arms the desktop window right before window.open and falls back to the file", () => {
  const source = readFileSync("components/marketplace.tsx", "utf8");
  const open = source.slice(source.indexOf("function openMarketplace()"), source.indexOf("const busy ="));
  assert.ok(open.indexOf("armDesktopMarketplace(config.origin);") < open.indexOf("window.open(submitAddress("), "armed first");
  assert.match(open, /if \(way !== "handover"\) \{/, "older desktop apps and the mobile apps: the file");
  assert.match(open, /if \(!win\) \{\s*void handToFile\("blocked"/, "no window: the file");
  assert.match(open, /window\.setTimeout\(\(\) => \{\s*if \(!ready\) void handToFile\("silent", pkg, false\);\s*\}, READY_MS\);/, "no \"ready\": the file");
});

test("inside a Flowplan app (#314): by the bridge or the user agent, not in browsers", () => {
  const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) FlowplanDesktop/1.4.0 Chrome/140.0 Electron/38.0 Safari/537.36";
  assert.equal(flowplanAppHost({ FlowplanApp: {} }, safari), true);
  assert.equal(flowplanAppHost({ FlowplanDesktop: {} }, safari), true);
  assert.equal(flowplanAppHost({}, iphone), true);
  assert.equal(flowplanAppHost({}, android), true);
  assert.equal(flowplanAppHost({}, desktop), true);
  assert.equal(flowplanAppHost({}, safari), false);
  assert.equal(flowplanAppHost(undefined, ""), false);
});

test("\"Instanz wechseln …\": the app's own switcher, older apps' profiles, nothing elsewhere", () => {
  const fn = () => {};
  // Apps with the switcher: its sheet (the page learns nothing of the other instances).
  assert.equal(profileSwitcherWay({ openProfileSwitcher: fn, openProfiles: fn }), "switcher");
  assert.equal(profileSwitcherWay({ openProfileSwitcher: fn }), "switcher");
  // Older apps with openProfiles only: their profile screen.
  assert.equal(profileSwitcherWay({ openProfiles: fn }), "profiles");
  assert.equal(profileSwitcherWay({ openProfileSwitcher: "yes", openProfiles: fn }), "profiles", "a broken entry is no switcher");
  // No bridge (a browser, the desktop app) or neither function: no entry.
  assert.equal(profileSwitcherWay(undefined), null);
  assert.equal(profileSwitcherWay({}), null);
  assert.equal(profileSwitcherWay({ openProfileSwitcher: 1, openProfiles: null }), null);
  assert.equal(profileSwitcherWay(), null, "no window here: nothing");

  // It calls exactly one function, with nothing, and a throwing bridge breaks nothing.
  const calls: string[] = [];
  const app = {
    openProfileSwitcher: (...args: unknown[]) => void calls.push(`switcher:${args.length}`),
    openProfiles: (...args: unknown[]) => void calls.push(`profiles:${args.length}`),
  };
  assert.equal(openProfileSwitcher(app), "switcher");
  assert.equal(openProfileSwitcher({ openProfiles: app.openProfiles }), "profiles");
  assert.equal(openProfileSwitcher(undefined), null);
  assert.deepEqual(calls, ["switcher:0", "profiles:0"]);
  assert.equal(
    openProfileSwitcher({
      openProfileSwitcher: () => {
        throw new Error("gone");
      },
    }),
    "switcher",
  );
});

test("a long press on the own account row opens the switcher; a tap, a scroll or another button does not", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const target = new EventTarget();
  const host = globalThis as { window?: unknown };
  const saved = host.window;
  host.window = target;
  t.after(() => {
    host.window = saved;
  });
  const pointer = (type: string, init: { pointerId?: number; x?: number; y?: number } = {}) =>
    Object.assign(new Event(type, { cancelable: true }), { pointerId: init.pointerId ?? 1, clientX: init.x ?? 10, clientY: init.y ?? 10 });
  const clicked = () => {
    const click = new Event("click", { cancelable: true });
    target.dispatchEvent(click);
    return !click.defaultPrevented;
  };
  const down = { pointerId: 1, clientX: 10, clientY: 10, button: 0, target: null };
  let opened = 0;
  const open = () => opened++;

  // Held still: opens once, and the click that ends the press is swallowed.
  holdForProfileSwitcher(down, open);
  t.mock.timers.tick(PROFILE_HOLD_MS - 1);
  assert.equal(opened, 0);
  t.mock.timers.tick(1);
  assert.equal(opened, 1);
  target.dispatchEvent(pointer("pointerup"));
  assert.equal(clicked(), false);
  t.mock.timers.tick(500);
  assert.equal(clicked(), true, "later clicks are the page's again");

  // A tap: lifted before the time.
  holdForProfileSwitcher(down, open);
  t.mock.timers.tick(200);
  target.dispatchEvent(pointer("pointerup"));
  t.mock.timers.tick(1000);
  assert.equal(opened, 1);
  assert.equal(clicked(), true);
  // Scrolling the sidebar: the finger moves.
  holdForProfileSwitcher(down, open);
  target.dispatchEvent(pointer("pointermove", { x: 10, y: 40 }));
  t.mock.timers.tick(1000);
  assert.equal(opened, 1);
  // Another finger's move changes nothing.
  holdForProfileSwitcher(down, open);
  target.dispatchEvent(pointer("pointermove", { pointerId: 2, x: 200 }));
  t.mock.timers.tick(PROFILE_HOLD_MS);
  assert.equal(opened, 2);
  target.dispatchEvent(pointer("pointerup"));
  t.mock.timers.tick(500);
  // The secondary mouse button, or stopped from outside: nothing.
  holdForProfileSwitcher({ ...down, button: 2 }, open);
  holdForProfileSwitcher(down, open)();
  t.mock.timers.tick(1000);
  assert.equal(opened, 2);
  assert.equal(clicked(), true);
});

test("the switcher sits in the workspace menu and on the account row, only with the bridge", () => {
  const app = readFileSync(new URL("../components/workspace-app.tsx", import.meta.url), "utf8");
  assert.match(app, /\{profileSwitcher && \([\s\S]{0,300}onSelect=\{\(\) => void openProfileSwitcher\(\)\}[\s\S]{0,120}t\("Instanz wechseln …", "Switch instance…"\)/);
  assert.match(app, /onPointerDown=\{profileSwitcher \? \(e\) => void holdForProfileSwitcher\(e\) : undefined\}/);
});

test("passkeys in the iPhone/iPad/Android app are added in the browser; a browser and the desktop app are not affected", () => {
  assert.equal(appPasskeysInBrowser({ platform: "ios", openInBrowser: () => {} }, iphone), "open");
  assert.equal(appPasskeysInBrowser({ platform: "android", openInBrowser: () => {} }, android), "open");
  // An older app without openInBrowser: only the note.
  assert.equal(appPasskeysInBrowser({ platform: "ios" }, iphone), "note");
  assert.equal(appPasskeysInBrowser(undefined, iphone), "note");
  assert.equal(appPasskeysInBrowser(undefined, safari), null);
});

test("the desktop app opens “Passkey hinzufügen” in the default browser only with its bridge method", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Electron/45.0.0 Safari/537.36 FlowplanDesktop/1.3.12";
  assert.equal(desktopPasskeyLink({ addPasskeyInBrowser: async () => true }, mac), true);
  // Older desktop apps keep their way (in the window, or the note).
  assert.equal(desktopPasskeyLink({ passkeys: "window" } as never, mac), false);
  assert.equal(desktopPasskeyLink(undefined, mac), false);
  // Only the desktop app's bridge counts.
  assert.equal(desktopPasskeyLink({ addPasskeyInBrowser: async () => true }, safari), false);
  // The settings offer both ways where Touch ID runs in the window as well.
  const source = readFileSync(new URL("../components/account-security.tsx", import.meta.url), "utf8");
  assert.match(source, /Im Schlüsselbund \(iCloud\)/);
  assert.match(source, /Nur in dieser App \(Touch ID\)/);
  assert.match(source, /!inApp && !desktopLink/);
});
