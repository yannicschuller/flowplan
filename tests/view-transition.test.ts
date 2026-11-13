// View transitions of the shell (lib/view-transition.ts) against a small
// stand-in for the browser: when they run, the order of changes, rapid
// changes, the "Animationen" setting (#260) and taps that end them.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

type Fake = { update: () => void; skipped: boolean; finish: () => void; finished: Promise<void> };
const transitions: Fake[] = [];
const listeners = new Map<string, ((e: unknown) => void)[]>();
let reduced = false;
const doc = {
  visibilityState: "visible",
  documentElement: { dataset: {} as Record<string, string> },
  startViewTransition: undefined as undefined | ((update: () => void) => unknown),
};
function supportTransitions() {
  doc.startViewTransition = (update: () => void) => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const fake: Fake = { update, skipped: false, finish, finished };
    transitions.push(fake);
    return {
      finished,
      skipTransition() {
        fake.skipped = true;
        // The browser still runs a waiting update, then ends at once.
        queueMicrotask(() => {
          runUpdate(fake);
          finish();
        });
      },
    };
  };
}
const ran = new WeakSet<Fake>();
function runUpdate(fake: Fake) {
  if (ran.has(fake)) return;
  ran.add(fake);
  fake.update();
}
Object.assign(globalThis, {
  document: doc,
  window: {
    document: doc,
    matchMedia: () => ({ matches: reduced }),
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, [...(listeners.get(type) || []), fn]),
  },
});
class FakeElement {
  style = { viewTransitionName: "" };
}
Object.assign(globalThis, { HTMLElement: FakeElement, SVGElement: class {} });

const { transitionView, withoutViewTransition, holdViewTransitions, RAPID_MS, viewTransitionRunning } = await import("../lib/view-transition");
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Each test starts after the rapid window of the previous one.
beforeEach(async () => {
  for (const t of transitions.splice(0)) {
    runUpdate(t);
    t.finish();
  }
  await later(RAPID_MS + 20);
  reduced = false;
});

test("without the API or with reduced motion the change happens at once", async () => {
  doc.startViewTransition = undefined;
  let value = 0;
  transitionView(() => value++, { kind: "page" });
  assert.equal(value, 1);
  supportTransitions();
  await later(RAPID_MS + 20);
  reduced = true;
  transitionView(() => value++, { kind: "page" });
  assert.equal(value, 2);
  assert.equal(transitions.length, 0);
});

test("what the app opens with comes without a transition", () => {
  supportTransitions();
  let value = 0;
  withoutViewTransition(() => transitionView(() => value++, { kind: "page" }));
  assert.equal(value, 1);
  assert.equal(transitions.length, 0);
});

test("with the API the change waits for the old picture; flush applies it early, once", async () => {
  supportTransitions();
  let value = 0;
  const view = transitionView(() => value++, { kind: "page" });
  assert.equal(value, 0, "the old view is captured first");
  assert.equal(transitions.length, 1);
  assert.equal(doc.documentElement.dataset.viewTransition, "page");
  view.flush();
  assert.equal(value, 1);
  runUpdate(transitions[0]);
  assert.equal(value, 1, "not applied twice");
  transitions[0].finish();
  await later(0);
  assert.equal(doc.documentElement.dataset.viewTransition, undefined);
  assert.equal(viewTransitionRunning(), false);
});

test("quick successive changes keep their order and go without a transition", async () => {
  supportTransitions();
  const log: string[] = [];
  transitionView(() => log.push("first"), { kind: "page" });
  transitionView(() => log.push("second"), { kind: "page" });
  assert.deepEqual(log, ["first", "second"], "the waiting change is applied before the new one");
  assert.equal(transitions.length, 1);
  await later(0);
  assert.equal(transitions[0].skipped, true, "the running one ends at once");
  runUpdate(transitions[0]);
  assert.deepEqual(log, ["first", "second"]);
  // A third change right after: still no transition.
  transitionView(() => log.push("third"), { kind: "page" });
  assert.deepEqual(log, ["first", "second", "third"]);
  assert.equal(transitions.length, 1);
});

test("“Animationen: Aus” changes at once; “Reduziert” keeps the cross-fade", async () => {
  supportTransitions();
  let value = 0;
  doc.documentElement.dataset.motion = "off";
  try {
    transitionView(() => value++, { kind: "page" });
    assert.equal(value, 1);
    assert.equal(transitions.length, 0);
    await later(RAPID_MS + 20);
    doc.documentElement.dataset.motion = "reduced";
    transitionView(() => value++, { kind: "page" });
    assert.equal(transitions.length, 1, "a fade of the main pane only");
    runUpdate(transitions[0]);
    assert.equal(value, 2);
  } finally {
    delete doc.documentElement.dataset.motion;
  }
});

test("a tap or a key during a transition ends it", async () => {
  supportTransitions();
  let value = 0;
  transitionView(() => value++, { kind: "page" });
  runUpdate(transitions[0]);
  assert.equal(viewTransitionRunning(), true);
  for (const fn of listeners.get("pointerdown") || []) fn({});
  assert.equal(transitions[0].skipped, true);
  await later(0);
  assert.equal(viewTransitionRunning(), false);
  assert.equal(value, 1);
});

test("while the phone's drawer holds them, changes come without a transition", async () => {
  supportTransitions();
  let value = 0;
  // A transition that runs when the drawer starts to open ends at once.
  transitionView(() => value++, { kind: "page" });
  runUpdate(transitions[0]);
  const release = holdViewTransitions();
  assert.equal(transitions[0].skipped, true);
  await later(RAPID_MS + 20);
  // Einstellungen in the open drawer: the screen changes at once.
  transitionView(() => value++, { kind: "page" });
  assert.equal(value, 2);
  assert.equal(transitions.length, 1);
  // Two holds (opened again while it still slid out): both must go.
  const again = holdViewTransitions();
  release();
  release();
  transitionView(() => value++, { kind: "page" });
  assert.equal(transitions.length, 1, "a release counts once");
  again();
  await later(RAPID_MS + 20);
  transitionView(() => value++, { kind: "page" });
  assert.equal(transitions.length, 2, "transitions are back once the drawer has slid out");
  assert.equal(value, 3);
});
