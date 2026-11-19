import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { visiblePoll } from "../lib/visible-poll";

// A hidden tab does not poll (#383); the skipped refresh follows when it is
// shown again, offline nothing is asked.
function fakeDocument() {
  const listeners = new Set<() => void>();
  return {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (type: string, fn: () => void) => type === "visibilitychange" && listeners.add(fn),
    removeEventListener: (type: string, fn: () => void) => type === "visibilitychange" && listeners.delete(fn),
    set(state: DocumentVisibilityState) {
      this.visibilityState = state;
      for (const fn of listeners) fn();
    },
    listeners,
  };
}

test("polls while visible, pauses while hidden and catches up when shown", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const doc = fakeDocument();
    let online = true,
      runs = 0;
    const stop = visiblePoll(() => runs++, 10_000, doc as unknown as Document, () => online);
    mock.timers.tick(10_000);
    assert.equal(runs, 1);
    // Hidden: the ticks pass without a request.
    doc.set("hidden");
    mock.timers.tick(30_000);
    assert.equal(runs, 1);
    // Shown: one refresh right away for what was missed, then the ticks again.
    doc.set("visible");
    assert.equal(runs, 2);
    doc.set("hidden");
    doc.set("visible");
    assert.equal(runs, 2, "shown again without a missed tick: nothing extra");
    mock.timers.tick(10_000);
    assert.equal(runs, 3);
    // Offline: neither the tick nor the return asks; the next tick online does.
    online = false;
    doc.set("hidden");
    mock.timers.tick(10_000);
    doc.set("visible");
    mock.timers.tick(10_000);
    assert.equal(runs, 3);
    online = true;
    doc.set("hidden");
    doc.set("visible");
    assert.equal(runs, 4, "the missed tick is made up once online");
    mock.timers.tick(10_000);
    assert.equal(runs, 5);
    stop();
    assert.equal(doc.listeners.size, 0);
    mock.timers.tick(30_000);
    assert.equal(runs, 5);
  } finally {
    mock.timers.reset();
  }
});

test("the workspace refresh and the editor's check skip hidden tabs", () => {
  const app = readFileSync(new URL("../components/workspace-app.tsx", import.meta.url), "utf8");
  // Every 10 s without the live signal, every 60 s with it (#383, components/use-workspace-signals.ts).
  assert.match(app, /return visiblePoll\(\(\) => \{[\s\S]*?refresh\(\)[\s\S]*?\}, live \? LIVE_REFRESH_MS : POLL_REFRESH_MS\);/);
  const editor = readFileSync(new URL("../components/editor.tsx", import.meta.url), "utf8");
  // Only the check: saves of a hidden tab still go out.
  const check = editor.slice(editor.indexOf("// A hidden tab does not check (#383)"));
  assert.ok(check.indexOf('if (document.visibilityState === "hidden") return;') < check.indexOf("apiIfChanged"));
  assert.match(editor, /document\.addEventListener\("visibilitychange", shown\)/);
});
