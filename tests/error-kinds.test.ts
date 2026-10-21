import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyError,
  describeError,
  kindForStatus,
  rememberError,
} from "../lib/error-kinds";
import { translate } from "../lib/i18n";

const en = translate("en"),
  de = translate("de");
// A request error as components/ui.tsx throws it.
const apiError = (message: string, status: number, transient = false) =>
  Object.assign(new Error(message), { status, transient });

test("HTTP statuses map to error kinds", () => {
  assert.equal(kindForStatus(401), "unauthorized");
  assert.equal(kindForStatus(403), "forbidden");
  assert.equal(kindForStatus(409, "Version conflict."), "conflict");
  assert.equal(kindForStatus(409, "Diese Seite ist gesperrt."), "locked");
  assert.equal(kindForStatus(423), "locked");
  assert.equal(kindForStatus(413), "too-large");
  assert.equal(kindForStatus(429), "rate-limited");
  assert.equal(kindForStatus(500), "server");
  assert.equal(kindForStatus(404), "unknown");
});

test("network failures and raw server words never reach the reader", () => {
  for (const raw of [new TypeError("Failed to fetch"), "Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."])
    assert.equal(classifyError(raw).kind, "offline");
  assert.deepEqual(classifyError("Internal"), { kind: "server" });
  assert.deepEqual(classifyError(apiError("Internal", 500)), { kind: "server" });
  assert.deepEqual(classifyError(apiError("Server down", 502, true)), { kind: "server" });
  for (const error of ["Internal", "Failed to fetch", apiError("Internal", 500), "", undefined, {}]) {
    const { title, detail } = describeError(classifyError(error), en);
    assert.ok(!/Internal|Failed to fetch/.test(`${title} ${detail ?? ""}`), String(error));
    assert.ok(title.length > 10);
  }
});

test("the server's own 4xx text stays as the detail line", () => {
  const forbidden = classifyError(apiError("No permission for this space.", 403));
  assert.deepEqual(forbidden, { kind: "forbidden", detail: "No permission for this space." });
  assert.deepEqual(describeError(forbidden, en), {
    title: "You don't have permission to do that.",
    detail: "No permission for this space.",
  });
  // A placeholder adds nothing.
  assert.deepEqual(describeError(classifyError(apiError("Forbidden", 403)), en), {
    title: "You don't have permission to do that.",
  });
  // An otherwise unknown failure: the server's explanation is the message.
  assert.deepEqual(describeError(classifyError(apiError("The expiry date must be in the future.", 400)), en), {
    title: "The expiry date must be in the future.",
  });
  assert.equal(describeError({ kind: "locked" }, de).title, "Diese Seite ist gesperrt und kann gerade nicht bearbeitet werden.");
});

test("a message handed on alone keeps the kind of its request", () => {
  rememberError("Someone else changed this record.", 409);
  assert.deepEqual(classifyError("Someone else changed this record."), {
    kind: "conflict",
    detail: "Someone else changed this record.",
  });
  assert.deepEqual(classifyError("A message nobody threw"), { kind: "unknown", detail: "A message nobody threw" });
});
