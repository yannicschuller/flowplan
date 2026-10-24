import { test } from "node:test";
import assert from "node:assert/strict";
import { appleOS, detectOS } from "../lib/device-os";
import { fromHardwareKeyboard, hintsVisible } from "../lib/keyboard-hints";
import { cleanOverrides, comboFromEvent, eventMatches, formatCombo, resolveKeymap, type KeyLike } from "../lib/keymap";

const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  chromeos: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 FlowplanMobile/1.4.0",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.4.0",
  ipad: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  // iPadOS asks for desktop pages as a Mac.
  ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  electronWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) FlowplanDesktop/2.1.0 Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36",
  electronMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) FlowplanDesktop/2.1.0 Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36",
};

test("the system is read from Client Hints, the user agent and navigator.platform", () => {
  // Client Hints first.
  assert.equal(detectOS({ uaPlatform: "macOS", platform: "MacIntel", userAgent: UA.mac }), "macos");
  assert.equal(detectOS({ uaPlatform: "Windows", platform: "Win32", userAgent: UA.windows }), "windows");
  assert.equal(detectOS({ uaPlatform: "Chrome OS", platform: "Linux x86_64", userAgent: UA.chromeos }), "chromeos");
  assert.equal(detectOS({ uaPlatform: "Android", platform: "Linux armv8l", userAgent: UA.android }), "android");
  assert.equal(detectOS({ uaPlatform: "Linux", platform: "Linux x86_64", userAgent: UA.linux }), "linux");
  // An older Android WebView says "Linux" in the hint.
  assert.equal(detectOS({ uaPlatform: "Linux", platform: "Linux armv8l", userAgent: UA.android }), "android");
  // Safari has no Client Hints: the user agent.
  assert.equal(detectOS({ platform: "iPhone", userAgent: UA.iphone, maxTouchPoints: 5 }), "ios");
  assert.equal(detectOS({ platform: "iPad", userAgent: UA.ipad, maxTouchPoints: 5 }), "ipados");
  assert.equal(detectOS({ platform: "MacIntel", userAgent: UA.ipadDesktop, maxTouchPoints: 5 }), "ipados");
  assert.equal(detectOS({ platform: "MacIntel", userAgent: UA.ipadDesktop, maxTouchPoints: 0 }), "macos");
  // The desktop app (Electron) names the real system.
  assert.equal(detectOS({ uaPlatform: "Windows", platform: "Win32", userAgent: UA.electronWin }), "windows");
  assert.equal(detectOS({ uaPlatform: "macOS", platform: "MacIntel", userAgent: UA.electronMac }), "macos");
  assert.equal(detectOS({ userAgent: UA.electronWin }), "windows");
  // Only navigator.platform, or nothing.
  assert.equal(detectOS({ platform: "Win32" }), "windows");
  assert.equal(detectOS({ platform: "MacIntel" }), "macos");
  assert.equal(detectOS({ platform: "Linux x86_64" }), "linux");
  assert.equal(detectOS({}), "unknown");
  // Empty hints are no answer.
  assert.equal(detectOS({ uaPlatform: "", platform: "", userAgent: UA.windows }), "windows");

  assert.deepEqual(
    (["macos", "ios", "ipados", "windows", "linux", "chromeos", "android", "unknown"] as const).filter(appleOS),
    ["macos", "ios", "ipados"],
  );
});

test("the same account's shortcuts read ⌘ on Apple devices and Ctrl elsewhere", () => {
  // As stored per account: platform-neutral.
  const map = resolveKeymap(cleanOverrides({ capture: ["Mod+Shift+K"], search: ["Cmd+K"] }));
  const show = (ua: string, platform: string, uaPlatform?: string) =>
    formatCombo(map.capture[0], appleOS(detectOS({ userAgent: ua, platform, uaPlatform })));
  assert.equal(show(UA.mac, "MacIntel", "macOS"), "⇧ ⌘ K");
  assert.equal(show(UA.ipad, "iPad"), "⇧ ⌘ K");
  assert.equal(show(UA.windows, "Win32", "Windows"), "Ctrl + Shift + K");
  assert.equal(show(UA.linux, "Linux x86_64", "Linux"), "Ctrl + Shift + K");
  assert.equal(show(UA.chromeos, "Linux x86_64", "Chrome OS"), "Ctrl + Shift + K");
  assert.equal(show(UA.android, "Linux armv8l", "Android"), "Ctrl + Shift + K");
  // All modifiers: symbols on the Mac, words elsewhere.
  assert.equal(formatCombo("Ctrl+Alt+Shift+Mod+Enter", true), "⌃ ⌥ ⇧ ⌘ ↵");
  assert.equal(formatCombo("Mod+Alt+Shift+Enter", false), "Ctrl + Alt + Shift + Enter");
  assert.equal(formatCombo("Mod+Backspace", false), "Ctrl + Backspace");
  // "Cmd+K" (written by hand or through the API) is Mod+K: the default.
  assert.deepEqual(cleanOverrides({ search: ["Cmd+K"] }), {});
  assert.deepEqual(cleanOverrides({ search: ["⌘+⌥+K"] }), { search: ["Mod+Alt+K"] });
});

test("Mod is pressed with ⌘ on the Mac and with Ctrl elsewhere; recording stores Mod", () => {
  const ev = (mods: Partial<KeyLike>): KeyLike => ({ key: "k", code: "KeyK", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  assert.ok(eventMatches(ev({ metaKey: true, shiftKey: true }), "Mod+Shift+K", true));
  assert.ok(eventMatches(ev({ ctrlKey: true, shiftKey: true }), "Mod+Shift+K", false));
  assert.ok(!eventMatches(ev({ ctrlKey: true, shiftKey: true }), "Mod+Shift+K", true));
  // Recorded on a Mac with ⌘ and on a PC with Ctrl: the same stored text.
  assert.equal(comboFromEvent(ev({ metaKey: true }), true), "Mod+K");
  assert.equal(comboFromEvent(ev({ ctrlKey: true }), false), "Mod+K");
});

test("hints only where a keyboard is", () => {
  const base = { touchOnly: false, finePointer: true, mobileApp: false, hardwareKeyboard: false };
  // Desktop browsers and the desktop app.
  assert.equal(hintsVisible(base), true);
  // Phones in the browser and in the app.
  assert.equal(hintsVisible({ ...base, touchOnly: true, finePointer: false }), false);
  assert.equal(hintsVisible({ ...base, touchOnly: true, finePointer: false, mobileApp: true }), false);
  // An iPad with a trackpad, or a keyboard that was used.
  assert.equal(hintsVisible({ ...base, touchOnly: true, finePointer: true, mobileApp: true }), true);
  assert.equal(hintsVisible({ ...base, touchOnly: true, finePointer: false, mobileApp: true, hardwareKeyboard: true }), true);
  // A touch laptop has a fine pointer as well.
  assert.equal(hintsVisible({ ...base, touchOnly: false, finePointer: true }), true);

  const key = (k: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; isComposing?: boolean } = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  });
  // Software keyboards type letters, Enter and Backspace – or "Unidentified".
  for (const k of ["a", "Enter", "Backspace", "Unidentified", "Process", " "]) assert.equal(fromHardwareKeyboard(key(k)), false, k);
  assert.equal(fromHardwareKeyboard(key("a", { isComposing: true, ctrlKey: true })), false);
  for (const k of ["Tab", "Escape", "ArrowDown", "F5", "Meta", "Control"]) assert.equal(fromHardwareKeyboard(key(k)), true, k);
  assert.equal(fromHardwareKeyboard(key("k", { metaKey: true })), true);
  assert.equal(fromHardwareKeyboard(key("n", { altKey: true })), true);
  assert.equal(fromHardwareKeyboard(key("Alt", { altKey: true })), false);
});
