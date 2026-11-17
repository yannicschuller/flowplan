import { test } from "node:test";
import assert from "node:assert/strict";
import { reportError, setErrorToaster, showError, type ShownError } from "../components/ui";

// #332: a background request (a kept page copy brought up to date) that
// failed only because the device is offline shows no toast – the offline
// icon in the top bar says so. Every other failure is still shown.

function withOnline<T>(online: boolean, run: () => T): T {
  const before = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { onLine: online }, configurable: true });
  try {
    return run();
  } finally {
    if (before) Object.defineProperty(globalThis, "navigator", before);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

test("background failures stay quiet only while the device is offline", () => {
  const shown: ShownError[] = [];
  const stop = setErrorToaster((view) => shown.push(view));
  try {
    const retry = () => {};
    // Offline: the kept copy's refresh says nothing …
    withOnline(false, () => reportError(new TypeError("Failed to fetch"), { retry, background: true }));
    assert.equal(shown.length, 0);
    // … but a request the reader asked for does, with Retry.
    withOnline(false, () => reportError(new TypeError("Failed to fetch"), { retry }));
    assert.equal(shown.length, 1);
    assert.equal(shown[0].kind, "offline");
    assert.equal(shown[0].retry, retry);
    // Online, a network failure in the background is shown too (no offline
    // icon says it).
    withOnline(true, () => reportError(new TypeError("Failed to fetch"), { background: true }));
    assert.equal(shown.length, 2);
    // Other kinds are never swallowed, offline or not.
    withOnline(false, () => showError("forbidden", undefined, { background: true }));
    withOnline(true, () => showError("server", undefined, { background: true }));
    assert.deepEqual(shown.slice(2).map((view) => view.kind), ["forbidden", "server"]);
  } finally {
    stop();
  }
});
