// "Back" for the apps (lib/app-back.ts): where a step back goes from every
// kind of place, and in a small DOM that open layers close first, the
// drawer before them, and the start page ends it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { locationKey, parentLocation, remember } from "../lib/app-back";

const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  R = "33333333-3333-4333-8333-333333333333",
  T = "44444444-4444-4444-8444-444444444444";

test("places: pages with their records and threads, settings areas, screens", () => {
  assert.equal(locationKey(""), "home");
  assert.equal(locationKey("#home"), "home");
  assert.equal(locationKey(`#page=${A}`), `page=${A}`);
  assert.equal(locationKey(`#page=${A}&row=${R}`), `page=${A}`);
  assert.equal(locationKey("#settings/account/passkeys"), "settings");
  assert.equal(locationKey("#admin/monitoring"), "admin");
  assert.equal(locationKey("#inbox"), "inbox");
  // Quick actions and broken links are no place.
  assert.equal(locationKey("#search"), null);
  assert.equal(locationKey("#page=nope"), null);
});

test("parts of a page close before the page is left", () => {
  assert.deepEqual(parentLocation(`page=${A}&row=${R}&thread=${T}`, [`page=${A}`]), { hash: `page=${A}&row=${R}`, pop: false });
  assert.deepEqual(parentLocation(`page=${A}&row=${R}`, [`page=${A}`]), { hash: `page=${A}`, pop: false });
  assert.deepEqual(parentLocation(`page=${A}&thread=${T}`, [`page=${A}`]), { hash: `page=${A}`, pop: false });
});

test("a section of the settings or the administration goes to its landing page", () => {
  assert.deepEqual(parentLocation("settings/account/passkeys", ["home", "settings"]), { hash: "settings", pop: false });
  assert.deepEqual(parentLocation("admin/monitoring", ["admin"]), { hash: "admin", pop: false });
  // The landing page goes where the person came from.
  assert.deepEqual(parentLocation("settings", [`page=${A}`, "settings"]), { hash: `page=${A}`, pop: true });
});

test("pages and screens go to the place before, finally home; home ends it", () => {
  assert.deepEqual(parentLocation(`page=${B}`, ["home", `page=${A}`, `page=${B}`]), { hash: `page=${A}`, pop: true });
  assert.deepEqual(parentLocation("inbox", ["inbox"]), { hash: "home", pop: true });
  assert.deepEqual(parentLocation(`page=${A}`, []), { hash: "home", pop: true });
  assert.equal(parentLocation("home", [`page=${A}`, "home"]), null);
  assert.equal(parentLocation("", []), null);
});

test("the list of places counts a place once in a row and stays short", () => {
  const stack: string[] = [];
  for (const hash of ["#home", `#page=${A}`, `#page=${A}&row=${R}`, `#page=${A}`, "#search", "#settings", "#settings/account"]) remember(stack, hash);
  assert.deepEqual(stack, ["home", `page=${A}`, "settings"]);
  for (let i = 0; i < 80; i++) remember(stack, i % 2 ? "#inbox" : "#tasks");
  assert.equal(stack.length, 50);
});

test("in the page: drawer, then dialogs, then the route; the app hears whether back is possible", async () => {
  const win = new Window({ url: "https://flowplan.test/#home" });
  const states: boolean[] = [];
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    location: win.location,
    KeyboardEvent: win.KeyboardEvent,
    MutationObserver: win.MutationObserver,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
  (win as unknown as { FlowplanApp: unknown }).FlowplanApp = { backState: (value: boolean) => states.push(value) };
  const { addBackCloser, installAppBack } = await import("../lib/app-back");
  const tick = () => new Promise((done) => setTimeout(done, 5));
  const hashChange = async (hash: string) => {
    win.location.hash = hash;
    win.dispatchEvent(new win.HashChangeEvent("hashchange"));
    await tick();
  };
  const uninstall = installAppBack();
  const nav = (win as unknown as { FlowplanNavigation: { back: () => boolean; canGoBack: () => boolean } }).FlowplanNavigation;
  await tick();
  assert.equal(nav.canGoBack(), false);
  assert.equal(nav.back(), false);
  await hashChange(`page=${A}`);
  await hashChange(`page=${A}&row=${R}`);
  assert.equal(nav.canGoBack(), true);
  assert.equal(states.at(-1), true);

  // A Radix dialog: Escape goes to it, the route stays.
  const dialog = win.document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("data-state", "open");
  win.document.body.append(dialog);
  let escapes = 0;
  win.document.addEventListener("keydown", (e) => {
    if ((e as unknown as { key: string }).key === "Escape") {
      escapes++;
      dialog.remove();
    }
  }, true);
  // The drawer was opened after it: it closes first.
  let drawer = true;
  const removeCloser = addBackCloser(() => {
    drawer = false;
    removeCloser();
  });
  assert.equal(nav.back(), true);
  assert.equal(drawer, false);
  assert.equal(escapes, 0);
  assert.equal(nav.back(), true);
  assert.equal(escapes, 1);
  assert.equal(win.location.hash, `#page=${A}&row=${R}`);
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(win.location.hash, `#page=${A}&row=${R}`);

  // The record closes, then the page goes home.
  assert.equal(nav.back(), true);
  assert.equal(win.location.hash, `#page=${A}`);
  win.dispatchEvent(new win.HashChangeEvent("hashchange"));
  assert.equal(nav.back(), true);
  assert.equal(win.location.hash, "#home");
  win.dispatchEvent(new win.HashChangeEvent("hashchange"));
  await tick();
  assert.equal(nav.back(), false);
  assert.equal(states.at(-1), false);

  // A modal that ignores Escape is left by its route.
  await hashChange(`page=${B}`);
  const stubborn = win.document.createElement("div");
  stubborn.setAttribute("aria-modal", "true");
  win.document.body.append(stubborn);
  assert.equal(nav.back(), true);
  assert.equal(win.location.hash, `#page=${B}`);
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(win.location.hash, "#home");
  uninstall();
  assert.equal((win as unknown as { FlowplanNavigation?: unknown }).FlowplanNavigation, undefined);
  await win.happyDOM.close();
});
