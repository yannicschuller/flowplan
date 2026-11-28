// #647: the swipe from the right edge goes forward (lib/forward-swipe.ts)
// – only in an app that lets the page have the edge, with "Wischen vom
// linken Rand" on "Zurück" and a step forward; places that scroll on to the
// right keep their swipe; the app's back goes through the history where
// it can, so forward stays possible; the back arrow's list of places
// visited in this tab (lib/history-nav.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  atRightEdge,
  FORWARD_EDGE,
  FORWARD_THRESHOLD,
  forwardCommits,
  forwardSwipeOn,
  forwardSwipeSupported,
  forwardTravel,
} from "../lib/forward-swipe";
import { canScrollForward } from "../lib/sideways-scroll";
import { backThroughHistory, parentLocation } from "../lib/app-back";
import { noteVisit, RECENT_SIZE, recentList, stepOf, type Steps } from "../lib/history-nav";
import { isAccountTabKey, RECENT_PLACES_KEY } from "../lib/tab-storage";

const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  C = "33333333-3333-4333-8333-333333333333",
  R = "44444444-4444-4444-8444-444444444444";

test("where the swipe is offered: iOS apps that take the choice, Android apps that keep the right edge", () => {
  const ios = { platform: "ios" as const, appTakesChoice: true, appForward: false };
  assert.equal(forwardSwipeSupported(ios), true);
  // An iOS app from before the choice (no FlowplanApp.edgeSwipe): no.
  assert.equal(forwardSwipeSupported({ ...ios, appTakesChoice: false }), false);
  // Android: the right edge is the system's back unless the app keeps it.
  assert.equal(forwardSwipeSupported({ platform: "android", appTakesChoice: true, appForward: false }), false);
  assert.equal(forwardSwipeSupported({ platform: "android", appTakesChoice: true, appForward: true }), true);
  // A browser or the installed web app: the edge is Safari's or nobody's.
  assert.equal(forwardSwipeSupported({ platform: null, appTakesChoice: false, appForward: false }), false);
});

test("the right edge goes forward only with “Zurück” and a step forward", () => {
  const on = { platform: "ios" as const, appTakesChoice: true, appForward: false, pref: "back" as const, canGoForward: true };
  assert.equal(forwardSwipeOn(on), true);
  assert.equal(forwardSwipeOn({ ...on, pref: "drawer" }), false);
  assert.equal(forwardSwipeOn({ ...on, canGoForward: false }), false);
  assert.equal(forwardSwipeOn({ ...on, platform: "android" }), false);
  assert.equal(forwardSwipeOn({ ...on, platform: "android", appForward: true }), true);
});

test("the swipe starts at the very right edge, follows the finger and commits past the threshold or with a flick", () => {
  assert.equal(atRightEdge(390, 390), true);
  assert.equal(atRightEdge(390 - FORWARD_EDGE, 390), true);
  assert.equal(atRightEdge(390 - FORWARD_EDGE - 1, 390), false);
  assert.equal(atRightEdge(10, 390), false);
  assert.equal(atRightEdge(0, 0), false);
  assert.deepEqual(forwardTravel(0), { travel: 0, armed: false });
  assert.equal(forwardTravel(FORWARD_THRESHOLD - 1).armed, false);
  assert.equal(forwardTravel(FORWARD_THRESHOLD).armed, true);
  // A rubber band past the threshold, and no further than a little beyond.
  assert.ok(forwardTravel(FORWARD_THRESHOLD + 40).travel < (FORWARD_THRESHOLD + 40) * 0.9);
  assert.equal(forwardTravel(1000).travel, forwardTravel(2000).travel);
  assert.equal(forwardTravel(-30).travel, 0);
  assert.equal(forwardCommits(FORWARD_THRESHOLD, 0), true);
  assert.equal(forwardCommits(40, 0.1), false);
  assert.equal(forwardCommits(40, 1.2), true);
  // A twitch is no flick.
  assert.equal(forwardCommits(10, 3), false);
});

test("a table that scrolls on to the right keeps the swipe; one at its end does not", () => {
  const box = (scrollLeft: number) => ({ overflowX: "auto", scrollLeft, scrollWidth: 1200, clientWidth: 390 });
  assert.equal(canScrollForward([box(0)]), true);
  assert.equal(canScrollForward([box(400)]), true);
  assert.equal(canScrollForward([box(810)]), false);
  assert.equal(canScrollForward([{ ...box(0), overflowX: "hidden" }]), false);
  assert.equal(canScrollForward([{ overflowX: "auto", scrollLeft: 0, scrollWidth: 390, clientWidth: 390 }]), false);
});

test("the app's back goes through the history when the entry before is the place it goes to", () => {
  const step = parentLocation(`page=${B}`, ["home", `page=${A}`, `page=${B}`]);
  assert.deepEqual(step, { hash: `page=${A}`, pop: true });
  // lib/history-nav.ts names that entry the same way.
  assert.equal(stepOf(`#page=${A}`), `page=${A}`);
  assert.equal(backThroughHistory(step, `page=${A}`), true);
  // Another entry before (a replaced filter, another page): in place.
  assert.equal(backThroughHistory(step, `page=${C}`), false);
  assert.equal(backThroughHistory(step, null), false);
  assert.equal(backThroughHistory(null, `page=${A}`), false);
  // Tabs keep histories of their own.
  assert.equal(backThroughHistory(step, `page=${A}`, true), false);
  // A record closes to its page – the entry it was opened from.
  const record = parentLocation(`page=${A}&row=${R}`, [`page=${A}`]);
  assert.equal(backThroughHistory(record, stepOf(`page=${A}`)), true);
  // A settings section goes to the settings' start page, also by history.
  const section = parentLocation("settings/account", ["home", "settings"]);
  assert.equal(backThroughHistory(section, stepOf("#settings")), true);
});

test("visited places: the most recent first, once, at most RECENT_SIZE; no place, no change", () => {
  let list: string[] = [];
  for (const hash of ["home", `page=${A}`, "settings/account", `page=${A}`, `page=${B}`]) list = noteVisit(list, stepOf(hash));
  assert.deepEqual(list, [`page=${B}`, `page=${A}`, "settings/account", "home"]);
  assert.deepEqual(noteVisit(list, stepOf("#search")), list);
  assert.deepEqual(noteVisit(list, `page=${B}`), list);
  for (let i = 0; i < 80; i++) list = noteVisit(list, i % 3 === 0 ? "inbox" : i % 3 === 1 ? "tasks" : `page=${A}`);
  assert.ok(list.length <= RECENT_SIZE);
  // Kept per tab and cleared with the account's other tab data on sign-out.
  assert.equal(isAccountTabKey(RECENT_PLACES_KEY), true);
});

test("the back arrow's list: current first and marked, then by recency; history steps where they reach a place", () => {
  // A → B → C, back to B, then the settings: C dropped out of the history.
  const steps: Steps = {
    current: "settings/account",
    back: [
      { key: "k1", hash: `page=${B}`, delta: -1 },
      { key: "k0", hash: `page=${A}`, delta: -2 },
    ],
    forward: [],
  };
  const recent = ["settings/account", `page=${B}`, `page=${C}`, `page=${A}`];
  const list = recentList(recent, steps);
  assert.deepEqual(
    list.map((p) => [p.hash, p.current, p.step?.delta ?? null]),
    [
      ["settings/account", true, null],
      [`page=${B}`, false, -1],
      // Not in the history any more: a new step.
      [`page=${C}`, false, null],
      [`page=${A}`, false, -2],
    ],
  );
  // A step of the history this tab's list misses still shows, after them;
  // a place both behind and ahead takes the nearer entry.
  const more = recentList([`page=${B}`], {
    current: `page=${B}`,
    back: [
      { key: "k2", hash: `page=${A}`, delta: -1 },
      { key: "k0", hash: `page=${C}`, delta: -3 },
    ],
    forward: [{ key: "k4", hash: `page=${C}`, delta: 1 }],
  });
  assert.deepEqual(
    more.map((p) => [p.hash, p.step?.delta ?? null]),
    [
      [`page=${B}`, null],
      [`page=${A}`, -1],
      [`page=${C}`, 1],
    ],
  );
  // At most `size` rows.
  assert.equal(recentList(["a", "b", "c", "d"].map((x) => `page=${x}`), { current: null, back: [], forward: [] }, 2).length, 2);
});
