// The placeholder before the first paint (lib/route-pending.ts): the script
// in <head> marks the same places as routePendingFor(), the start page and
// what opens over it stay unmarked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { ROUTE_PENDING_ATTRIBUTE, ROUTE_PENDING_SCRIPT, routePendingFor } from "../lib/route-pending";

const ID = "0b9c6a4e-3f1d-4c55-9b8e-6f0a1d2c3b4a";
const FRAGMENTS: [string, string | null][] = [
  ["", null],
  ["home", null],
  ["search", null],
  ["new", null],
  ["capture", null],
  [`workspace=${ID}`, null],
  ["search=Notizen", null],
  ["homework", null],
  [`page=${ID}`, "page"],
  [`page=${ID}&row=${ID}`, "page"],
  ["settings", "settings"],
  ["settings/appearance", "settings"],
  ["admin", "settings"],
  ["admin/workspaces", "settings"],
  ["administration", null],
  ["inbox", "list"],
  ["tasks", "list"],
  ["trash", "list"],
  [`tags/${ID}`, "list"],
  [`collection/${ID}`, "list"],
  [`library/${ID}`, "list"],
];

function runScript(fragment: string) {
  const attributes = new Map<string, string>();
  runInNewContext(ROUTE_PENDING_SCRIPT, {
    location: { hash: fragment ? `#${fragment}` : "" },
    document: { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) } },
  });
  return attributes.get(ROUTE_PENDING_ATTRIBUTE) ?? null;
}

test("the head script marks the places routePendingFor() names", () => {
  for (const [fragment, expected] of FRAGMENTS) {
    assert.equal(routePendingFor(fragment), expected, fragment);
    assert.equal(runScript(fragment), expected, fragment);
  }
});

test("the head script never throws", () => {
  assert.doesNotThrow(() => runInNewContext(ROUTE_PENDING_SCRIPT, {}));
});

test("the layout runs the script with the page's nonce, the stylesheet hides the start page meanwhile", () => {
  const layout = readFileSync("app/layout.tsx", "utf8");
  assert.match(layout, /<script nonce=\{nonce\} dangerouslySetInnerHTML=\{\{ __html: ROUTE_PENDING_SCRIPT \}\} \/>/);
  const css = readFileSync("app/globals.css", "utf8");
  // Hidden, and shown again should the app never end the wait.
  assert.match(css, /html\[data-route-pending\] \.main-scroll > \.route-pending ~ \.home-screen,[^{]*\{[^}]*visibility: hidden;[^}]*animation: route-pending-show 0s linear \d+s forwards !important;/);
});
