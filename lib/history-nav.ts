// Back and forward in the interface (#125): the arrows at the top left, ⌘[ /
// ⌘] (Alt+← / Alt+→), the mouse's side buttons and the desktop app's menu
// and swipe. The workspace is one page with hash routes (#page=…,
// #settings/…), so the steps ARE the browser's history: the arrows go
// through it as the browser's own buttons do and both stay in step.
//
// What is a step: every place with an address of its own – a page (a
// database, a journal day, a whiteboard), a record opened from a database
// (it has its link, #page=…&row=…), a screen (start page, inbox, my tasks,
// tags, a collection, a library or a book of it, graph, media, trash) and a
// section of the settings or the administration. Not a step: dialogs, menus, the search, hover cards,
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
import { HISTORY_TITLES_KEY, RECENT_PLACES_KEY } from "./tab-storage";

// At most this many places in the list of a long press or right click.
export const LIST_SIZE = 10;
// The places visited in this tab (#647): kept, and shown in the back
// arrow's list (with the current one).
export const RECENT_SIZE = 30;
export const RECENT_SHOWN = 15;
// The trail (without the Navigation API) keeps this many addresses.
export const TRAIL_SIZE = 100;

const SCREENS = ["home", "inbox", "tasks", "graph", "trash", "media", "settings", "admin", "tags", "study", "library"];
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
    return target ? pageLocationHash({ pageId: target.pageId, rowId: target.rowId, full: target.full, edit: target.edit }).slice(1) : null;
  }
  const settings = parseSettingsHash(hash);
  if (settings) return settingsHash(settings).slice(1);
  if (SCREENS.includes(hash)) return hash;
  const [base, id, ...rest] = hash.split("/");
  if ((base === "tags" || base === "collection") && id && UUID.test(id) && !rest.length) return `${base}/${id.toLowerCase()}`;
  // A library, a book's and a chapter's overview (#329, lib/library.ts).
  if (base === "library" && id && UUID.test(id) && rest.length <= 2 && rest.every((r) => UUID.test(r))) return [base, id, ...rest].join("/").toLowerCase();
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
// Recently visited (#647): the places of this tab in the order they were
// last seen, the most recent first – also those a new step after going back
// dropped from the history. The back arrow's list (a long press, a right
// click, the context menu key) shows them with the current one marked;
// choosing one goes back or forward to it while it is in the history,
// otherwise it opens as a new step. Per tab in sessionStorage, nothing on
// the server (the quick search's "Zuletzt angesehen", #243, are the
// person's visits of pages and records across devices).

// The list after a visit of `place` (a step, stepOf): first, once.
export function noteVisit(list: readonly string[], place: string | null, size = RECENT_SIZE): string[] {
  if (!place) return list.slice(0, size);
  if (list[0] === place) return list.slice(0, size);
  return [place, ...list.filter((p) => p !== place)].slice(0, size);
}

// One row of the list: the place, whether it is the current one, and the
// step that reaches it through the history (null: a new step).
export type RecentPlace = { hash: string; current: boolean; step: Step | null };

// The rows of the back arrow's list: the current place first, then the
// places visited before it, the most recent first; a place of the history
// that this tab's list misses (it began before) comes after them. A place
// in the history is reached by its nearest step.
export function recentList(recent: readonly string[], steps: Steps, size = RECENT_SHOWN): RecentPlace[] {
  const nearest = new Map<string, Step>();
  for (const step of [...steps.back, ...steps.forward]) {
    const known = nearest.get(step.hash);
    if (!known || Math.abs(step.delta) < Math.abs(known.delta)) nearest.set(step.hash, step);
  }
  const order: string[] = [];
  const add = (hash: string | null) => {
    if (hash && !order.includes(hash)) order.push(hash);
  };
  add(steps.current);
  recent.forEach(add);
  steps.back.forEach((step) => add(step.hash));
  steps.forward.forEach((step) => add(step.hash));
  return order.slice(0, size).map((hash) => ({ hash, current: hash === steps.current, step: hash === steps.current ? null : nearest.get(hash) || null }));
}

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
const TITLES_KEY = HISTORY_TITLES_KEY;
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
let recent: string[] = [];
function readRecent(): string[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(RECENT_PLACES_KEY) || "[]");
    if (Array.isArray(value)) return value.filter((p): p is string => typeof p === "string" && stepOf(p) === p).slice(0, RECENT_SIZE);
  } catch {}
  return [];
}
const listeners = new Set<() => void>();

// Tabs (#279, components/frame-tabs.tsx): each tab has a history of its
// own; while tabs are on, the arrows, ⌘[ / ⌘], the mouse buttons and the
// desktop app's menu go through the active tab's steps (of the frame
// worked in last) instead of the browser's.
export type StepSource = { steps: () => Steps; go: (step: Step) => void };
let source: StepSource | null = null;
export function setStepSource(next: StepSource | null) {
  source = next;
  update();
}
// Recomputes the steps (the tabs changed).
export function refreshSteps() {
  update();
}
// The place of the browser's entry `delta` steps away (null: none known, or
// not a place of the workspace) – a tab's step that is also the browser's
// goes there by the browser's history, so both stay in step.
export function browserPlaceAt(delta: number): string | null {
  if (typeof window === "undefined") return null;
  const nav = navigationApi();
  let url: string | null | undefined;
  if (nav?.currentEntry) url = nav.entries().find((e) => e.index === nav.currentEntry!.index + delta)?.url;
  else if (trail) url = trail.entries[trail.index + delta];
  if (!url || pathOf(url) !== location.pathname) return null;
  return stepOf(hashOf(url));
}
// Goes `delta` entries through the browser's history, as goToStep does.
export function browserGo(delta: number) {
  if (trail) trail = { ...trail, expect: trail.index + delta };
  history.go(delta);
}

function compute(): Steps {
  if (source) return source.steps();
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

// The places visited in this tab, the most recent first (#647).
export function recentPlaces(): readonly string[] {
  return recent;
}
// Whether the tabs (#279) give the steps instead of the browser's history.
export function tabSteps(): boolean {
  return source !== null;
}
// Notes the current address as visited (on every change of it).
function visitHere() {
  if (location.pathname !== workspacePath) return;
  const next = noteVisit(recent, stepOf(location.hash));
  if (next.length === recent.length && next.every((p, i) => p === recent[i])) return;
  recent = next;
  try {
    sessionStorage.setItem(RECENT_PLACES_KEY, JSON.stringify(recent));
  } catch {}
  listeners.forEach((listener) => listener());
}
let workspacePath = "/";

// The current entry of the tab's history, the same on every return to it by
// back and forward and new for every new step (the Navigation API's key;
// null without it). components/workspace-app.tsx keeps the pane's scroll
// position per entry with it (#262).
export function currentEntryKey(): string | null {
  return navigationApi()?.currentEntry?.key ?? null;
}
export function subscribeHistory(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// Goes to a place of the lists (the arrows take the first one).
export function goToStep(step: Step) {
  if (source && step.key.startsWith("tab:")) return source.go(step);
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
// Goes to a row of the back arrow's list: through the history while the
// place is in it, otherwise as a new step.
export function goToRecent(place: RecentPlace) {
  if (place.current) return;
  if (place.step) return goToStep(place.step);
  location.hash = `#${place.hash}`;
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
  workspacePath = location.pathname;
  recent = readRecent();
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
    visitHere();
    update();
  };
  window.addEventListener("hashchange", changed);
  window.addEventListener("popstate", changed);
  nav?.addEventListener("currententrychange", changed);
  visitHere();
  update();
  return () => {
    window.removeEventListener("hashchange", changed);
    window.removeEventListener("popstate", changed);
    nav?.removeEventListener("currententrychange", changed);
  };
}
