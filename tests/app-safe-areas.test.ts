// The Android app draws its own bars around the page; the page's safe areas
// are zero there, unless the app hands them over (#61, lib/app-safe-areas.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { APP_BARS_ATTRIBUTE, APP_BARS_SCRIPT, appDrawsBars } from "../lib/app-safe-areas";

const ANDROID_APP =
  "Mozilla/5.0 (Linux; Android 15; 24117RN76G Build/AP3A.240617.008; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36 FlowplanMobile/1.0.3";
const IOS_APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.0.3";
const IPAD_APP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) FlowplanMobile/1.0.3";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const DESKTOP_APP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Flowplan/1.2.0 Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36 FlowplanDesktop/1.2.0";

function runScript(userAgent: string) {
  const attributes = new Map<string, string>();
  runInNewContext(APP_BARS_SCRIPT, {
    navigator: { userAgent },
    document: { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) } },
  });
  return attributes.has(APP_BARS_ATTRIBUTE);
}

test("only the Android app draws its own bars", () => {
  for (const [userAgent, expected] of [
    [ANDROID_APP, true],
    [IOS_APP, false],
    [IPAD_APP, false],
    [CHROME_ANDROID, false],
    [DESKTOP_APP, false],
    ["", false],
  ] as const) {
    assert.equal(appDrawsBars(userAgent), expected, userAgent);
    // The inline script for <head> follows the same rule.
    assert.equal(runScript(userAgent), expected, userAgent);
  }
  // Without a document (or navigator) it does nothing and throws nothing.
  assert.doesNotThrow(() => runInNewContext(APP_BARS_SCRIPT, {}));
});

test("the page's safe areas are zero in the Android app unless it hands them over", () => {
  const css = readFileSync("app/globals.css", "utf8");
  const rule = /:root\[data-app-bars\]:not\(\[data-app-safe-areas="page"\]\)\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "the rule for the Android app");
  for (const edge of ["top", "right", "bottom", "left"]) assert.match(rule[1], new RegExp(`--safe-${edge}: 0px;`));
  // Every safe area of the page goes through --safe-* (otherwise the rule
  // above misses it): env() only where they are defined.
  for (const file of ["globals.css", "mobile-ux.css", "whiteboard-diagrams.css", "whiteboard-board.css", "whiteboard-facilitation.css"]) {
    const text = readFileSync(`app/${file}`, "utf8");
    const uses = text.split("\n").filter((line) => line.includes("env(safe-area-inset"));
    assert.deepEqual(
      uses.filter((line) => !/^\s*--safe-(top|right|bottom|left): env\(safe-area-inset-\1, 0px\);$/.test(line)),
      [],
      file,
    );
  }
  const layout = readFileSync("app/layout.tsx", "utf8");
  assert.match(layout, /<script nonce=\{nonce\} dangerouslySetInnerHTML=\{\{ __html: APP_BARS_SCRIPT \}\} \/>/);
});

test("on phones the tab bar keeps the bottom inset once: no second one at the end of a page", () => {
  const css = readFileSync("app/globals.css", "utf8");
  // The tab bar takes the inset…
  assert.match(css, /--tab-bar-space: calc\(56px \+ var\(--safe-bottom\)\);/);
  assert.match(css, /\.main \{\s*height: calc\(100dvh - var\(--tab-bar-space\)\);/);
  // …so the space below a scrolled page drops it while the bar is there
  // (with the keyboard or in focus mode the bar is gone and it counts).
  assert.match(css, /\.app-shell:not\(\.keyboard-open, \.focus-mode\) \.main-scroll::after \{\s*height: 0;\s*\}/);
  assert.match(css, /\.app-shell:not\(\.keyboard-open, \.focus-mode\) \.main-scroll \{\s*scroll-padding-bottom: 0;\s*\}/);
});
