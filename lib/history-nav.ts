// Back and forward in the interface (#125): the arrows at the top left, ⌘[ /
// ⌘] (Alt+← / Alt+→), the mouse's side buttons and the desktop app's menu
// and swipe. The workspace is one page with hash routes (#page=…,
// #settings/…), so the steps ARE the browser's history: the arrows go
// through it as the browser's own buttons do and both stay in step.
//
// What is a step: every place with an address of its own – a page (a
// database, a journal day, a whiteboard), a record opened from a database
// (it has its link, #page=…&row=…), a screen (start page, inbox, my tasks,
// tags, a collection, graph, media, trash) and a section of the settings or
// the administration. Not a step: dialogs, menus, the search, hover cards,
// the split view (?split= is replaced) and what only passes through the
// address (#search, #new, block links – replaced at once). Closing a record
// or a comment thread opened from its page goes back to that entry
// (leaveTo()), so it adds no step of its own; a record opened by a link
// from elsewhere (the inbox) closes to its database as a new step.
//
// Whether there is a step back or forward: the History API does not say.
// Where the Navigation API is there (Chromium, Safari 26.2, Firefox 147) its
// entries tell exactly; elsewhere a trail of the tab's addresses in
// sessionStorage follows every hash change (follow()). Entries of other
// addresses (/login, a public page) end the list: the arrows stay within
// the workspace.
import { parsePageLocation, pageLocationHash } from "./page-location";
import { parseSettingsHash, settingsHash } from "./settings-sections";

// At most this many places in the list of a long press or right click.
export const LIST_SIZE = 10;
// The trail (without the Navigation API) keeps this many addresses.
export const TRAIL_SIZE = 100;

const SCREENS = ["home", "inbox", "tasks", "graph", "trash", "media", "settings", "admin", "tags"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The place an address stands for, as a hash without "#" – or null when it
// is no place to return to (#search, #new, a broken link). A page keeps its
// record (and whether the record fills the page, #231); threads, blocks and
// whiteboard elements are parts of it.
export function stepOf(fragment: string): string | null {
  const hash = fragment.replace(/^#/, "");
  if (!hash) return "home";
  if (hash.startsWith("page=")) {
    const target = parsePageLocation(hash);
    return target ? pageLocationHash({ pageId: target.pageId, rowId: target.rowId, full: target.full }).slice(1) : null;
  }
  const settings = parseSettingsHash(hash);
  if (settings) return settingsHash(settings).slice(1);
  if (SCREENS.includes(hash)) return hash;
  const [base, id, ...rest] = hash.split("/");
  if ((base === "tags" || base === "collection") && id && UUID.test(id) && !rest.length) return `${base}/${id.toLowerCase()}`;
  return null;
}

// An entry of the tab's history: the Navigation API's NavigationHistoryEntry
// or one of the trail.
export type EntryLike = { key: string; url: string; index: number };
// A place to go back or forward to: the entry's key, its place, and how
// many entries away it is (negative: back).
export type Step = { key: string; hash: string; delta: number };
export type Steps = { current: string | null; back: Step[]; forward: Step[] };
export const NO_STEPS: Steps = { current: null, back: [], forward: [] };

const pathOf = (url: string) => {
  try {
    const u = new URL(url, "http://x");
    return u.pathname;
  } catch {
    return null;
  }
};
const hashOf = (url: string) => {
  const i = url.indexOf("#");
  return i < 0 ? "" : url.slice(i + 1);
};

// The places before and after the current entry, the nearest first. Only
// entries of the workspace's own address count (`path`, usually "/"); an
// entry of another address ends the list. The same place twice in a row
// (or the current one again) counts once – going there takes the entry
// nearest to the current one.
export function stepsAround(entries: readonly EntryLike[], current: number, path: string, size = LIST_SIZE): Steps {
  const byIndex = new Map(entries.map((e) => [e.index, e]));
  const here = byIndex.get(current);
  const hereStep = here && pathOf(here.url) === path ? stepOf(hashOf(here.url)) : null;
  const collect = (direction: -1 | 1) => {
    const out: Step[] = [];
    let last = hereStep;
    for (let i = current + direction; out.length < size; i += direction) {
      const entry = byIndex.get(i);
      if (!entry || pathOf(entry.url) !== path) break;
      const step = stepOf(hashOf(entry.url));
      if (!step || step === last) continue;
      out.push({ key: entry.key, hash: step, delta: i - current });
      last = step;
    }
    return out;
  };
  return { current: hereStep, back: collect(-1), forward: collect(1) };
}

// ---------------------------------------------------------------------------
// The trail: the tab's addresses without the Navigation API.

export type Trail = {
  // Full URLs (path and hash) of the entries, as far as this tab saw them.
  entries: string[];
  index: number;
  // What the next change will be: the entry a jump goes to, or "replace".
  expect?: number | "replace" | null;
};

// The trail after the address changed to `url`. A change the page itself
// started says what it is (expect); otherwise an address equal to the entry
// before or after is taken as back or forward, anything else as a new entry
// (the entries after the current one are dropped, as in the browser).
export function follow(trail: Trail | null, url: string, size = TRAIL_SIZE): Trail {
  if (!trail || !trail.entries.length) return { entries: [url], index: 0 };
  const { entries, index, expect } = trail;
  if (expect === "replace") {
    const next = entries.slice();
    next[index] = url;
    return { entries: next, index };
  }
  if (typeof expect === "number" && entries[expect] === url) return { entries, index: expect };
  if (entries[index] === url) return { entries, index };
  if (index > 0 && entries[index - 1] === url) return { entries, index: index - 1 };
  if (entries[index + 1] === url) return { entries, index: index + 1 };
  const next = [...entries.slice(0, index + 1), url];
  const drop = Math.max(0, next.length - size);
  return { entries: next.slice(drop), index: next.length - 1 - drop };
}
export const trailEntries = (trail: Trail): EntryLike[] => trail.entries.map((url, index) => ({ key: `trail:${index}`, url, index }));

// ---------------------------------------------------------------------------
// In the page.

type NavigationEntry = { key: string; url: string | null; index: number };
type NavigationLike = EventTarget & {
  currentEntry: NavigationEntry | null;
  entries: () => NavigationEntry[];
  traverseTo: (key: string) => { committed: Promise<unknown>; finished: Promise<unknown> };
};
const navigationApi = (): NavigationLike | null => {
  if (typeof window === "undefined") return null;
  const nav = (window as unknown as { navigation?: NavigationLike }).navigation;
  return nav && typeof nav.entries === "function" && typeof nav.traverseTo === "function" ? nav : null;
};

const TRAIL_KEY = "flowplan-history-trail";
const TITLES_KEY = "flowplan-history-titles";
const hereUrl = () => `${location.pathname}${location.hash}`;
function readTrail(): Trail | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(TRAIL_KEY) || "null");
    if (value && Array.isArray(value.entries) && Number.isInteger(value.index)) return { entries: value.entries.filter((e: unknown) => typeof e === "string"), index: value.index };
  } catch {}
  return null;
}
function writeTrail(trail: Trail) {
  try {
    sessionStorage.setItem(TRAIL_KEY, JSON.stringify({ entries: trail.entries, index: trail.index }));
  } catch {}
}

let trail: Trail | null = null;
let steps: Steps = NO_STEPS;
const listeners = new Set<() => void>();

function compute(): Steps {
  const nav = navigationApi();
  if (nav?.currentEntry) {
    const entries = nav.entries().map((e) => ({ key: e.key, url: e.url || "", index: e.index }));
    return stepsAround(entries, nav.currentEntry.index, location.pathname);
  }
  if (!trail) return NO_STEPS;
  return stepsAround(trailEntries(trail), trail.index, location.pathname);
}
const same = (a: Step[], b: Step[]) => a.length === b.length && a.every((s, i) => s.key === b[i].key && s.hash === b[i].hash && s.delta === b[i].delta);
function update() {
  const next = compute();
  if (next.current === steps.current && same(next.back, steps.back) && same(next.forward, steps.forward)) return;
  steps = next;
  listeners.forEach((listener) => listener());
}

export function historySteps(): Steps {
  return steps;
}
export function subscribeHistory(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// Goes to a place of the lists (the arrows take the first one).
export function goToStep(step: Step) {
  const nav = navigationApi();
  if (nav && !step.key.startsWith("trail:")) {
    try {
      const result = nav.traverseTo(step.key);
      // An interrupted traversal (another one started) is no error.
      result.committed.catch(() => {});
      result.finished.catch(() => {});
      return;
    } catch {}
  }
  if (trail) trail = { ...trail, expect: trail.index + step.delta };
  history.go(step.delta);
}
export function goBack() {
  const step = steps.back[0];
  if (!step) return false;
  goToStep(step);
  return true;
}
export function goForward() {
  const step = steps.forward[0];
  if (!step) return false;
  goToStep(step);
  return true;
}

// Leaves a part of the page (a record, a comment thread) for `hash` (with
// "#"): back to the entry it was opened from when that is the one before,
// so closing adds no step. Otherwise – opened by a link from elsewhere –
// the page is a new place ("push", a record: back opens it again) or takes
// the entry's place ("replace", a thread).
export function leaveTo(hash: string, otherwise: "push" | "replace" = "push") {
  if (typeof window === "undefined") return;
  const target = hash.startsWith("#") ? hash : `#${hash}`;
  if (location.hash === target) return;
  const nav = navigationApi();
  let previous: string | null = null;
  if (nav?.currentEntry) {
    const entry = nav.entries().find((e) => e.index === nav.currentEntry!.index - 1);
    if (entry?.url && pathOf(entry.url) === location.pathname) previous = `#${hashOf(entry.url)}`;
  } else if (trail && trail.index > 0) {
    const url = trail.entries[trail.index - 1];
    if (pathOf(url) === location.pathname) previous = `#${hashOf(url)}`;
  }
  if (previous === target) {
    if (trail) trail = { ...trail, expect: trail.index - 1 };
    history.back();
    return;
  }
  if (otherwise === "push") {
    location.hash = target;
    return;
  }
  if (trail) trail = { ...trail, expect: "replace" };
  location.replace(target);
}

// Titles of places seen in this tab (records, pages of other workspaces),
// for the lists when the interface does not know them (any more).
export type StepTitle = { title: string; icon?: string };
export function rememberTitle(step: string, value: StepTitle) {
  if (typeof window === "undefined" || !value.title) return;
  try {
    const all = JSON.parse(sessionStorage.getItem(TITLES_KEY) || "{}") as Record<string, StepTitle>;
    delete all[step];
    all[step] = { title: value.title.slice(0, 200), ...(value.icon ? { icon: value.icon.slice(0, 200) } : {}) };
    const keys = Object.keys(all);
    for (const key of keys.slice(0, Math.max(0, keys.length - 200))) delete all[key];
    sessionStorage.setItem(TITLES_KEY, JSON.stringify(all));
  } catch {}
}
export function rememberedTitle(step: string): StepTitle | null {
  if (typeof window === "undefined") return null;
  try {
    const value = (JSON.parse(sessionStorage.getItem(TITLES_KEY) || "{}") as Record<string, StepTitle>)[step];
    return value && typeof value.title === "string" ? value : null;
  } catch {
    return null;
  }
}

// The desktop app (flowplan-desktop, preload.js): its menu items "Back" and
// "Forward" (⌘[ / ⌘] on the Mac), the trackpad's swipe and the mouse's side
// buttons (app-command on Windows and Linux) come as commands; the page
// says whether there is a step, for the menu items. Once per page: the
// bridge has no way to unsubscribe.
export type DesktopHistory = {
  state?: (back: boolean, forward: boolean) => void;
  onCommand?: (callback: (command: string) => void) => void;
};
let desktopConnected = false;
export function connectDesktop(bridge: DesktopHistory | undefined, run: (command: "back" | "forward") => void) {
  if (!bridge || desktopConnected) return;
  desktopConnected = true;
  try {
    bridge.onCommand?.((command) => {
      if (command === "back" || command === "forward") run(command);
    });
  } catch {}
  let last = "";
  const report = () => {
    const value = `${steps.back.length > 0}|${steps.forward.length > 0}`;
    if (value === last) return;
    last = value;
    try {
      bridge.state?.(steps.back.length > 0, steps.forward.length > 0);
    } catch {}
  };
  subscribeHistory(report);
  report();
}

// The mouse's side buttons ("back" and "forward", button 3 and 4). A
// browser goes through its history itself – the arrows follow; only the
// desktop app's window, which has no such buttons, needs them from here.
export function installMouseButtons(run: (command: "back" | "forward") => void) {
  if (typeof window === "undefined") return () => {};
  const side = (e: MouseEvent) => (e.button === 3 ? "back" : e.button === 4 ? "forward" : null);
  const down = (e: MouseEvent) => {
    if (side(e)) e.preventDefault();
  };
  const up = (e: MouseEvent) => {
    const command = side(e);
    if (!command) return;
    e.preventDefault();
    run(command);
  };
  window.addEventListener("mousedown", down, true);
  window.addEventListener("mouseup", up, true);
  return () => {
    window.removeEventListener("mousedown", down, true);
    window.removeEventListener("mouseup", up, true);
  };
}

// Follows the tab's history (once per page); returns the uninstall.
export function installHistory(): () => void {
  if (typeof window === "undefined") return () => {};
  const nav = navigationApi();
  if (!nav) {
    const stored = readTrail();
    trail = follow(stored && stored.entries[stored.index] === hereUrl() ? stored : stored ? { ...stored, expect: null } : null, hereUrl());
    writeTrail(trail);
  }
  const changed = () => {
    if (!nav && trail) {
      trail = follow(trail, hereUrl());
      writeTrail(trail);
    }
    update();
  };
  window.addEventListener("hashchange", changed);
  window.addEventListener("popstate", changed);
  nav?.addEventListener("currententrychange", changed);
  update();
  return () => {
    window.removeEventListener("hashchange", changed);
    window.removeEventListener("popstate", changed);
    nav?.removeEventListener("currententrychange", changed);
  };
}
