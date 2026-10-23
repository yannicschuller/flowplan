// Only meaningful text is selectable (app/globals.css, "Text selection"):
// a long press on the tab bar, buttons, menus or toolbars selects nothing,
// while documents, inputs, code, errors and copyable values stay selectable.
// tests/browser/text-selection.spec.ts checks the same in Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("app/globals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
// Top-level rules as [selectors, declarations].
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim().replace(/\s+/g, " "), body] as const);
const declares = (body: string, value: string) =>
  new RegExp(`(^|;|\\s)user-select:\\s*${value}\\s*(;|$)`).test(body) && new RegExp(`-webkit-user-select:\\s*${value}`).test(body);

const chrome = rules.find(([selector, body]) => selector.startsWith(":where(") && selector.includes(".mobile-tab-bar") && declares(body, "none"));
const content = rules.find(([selector, body]) => selector.includes("textarea") && selector.includes(".ProseMirror") && declares(body, "text"));

test("UI chrome is not selectable and has no long-press callout", () => {
  assert.ok(chrome, "a :where(…) rule with user-select: none for the chrome");
  const [selector, body] = chrome;
  assert.match(body, /-webkit-touch-callout:\s*none/);
  for (const part of ["button", "nav", '[role="tab"]', '[role="menuitem"]', '[role="toolbar"]', ".data-table thead th", ".sidebar", ".topbar", ".breadcrumb", ".mobile-tab-bar", ".dropdown", ".toast", ".chip", ".settings-tile", ".no-select"])
    assert.ok(selector.includes(part), `chrome rule covers ${part}`);
  // Zero specificity: component rules and the content exceptions win.
  assert.ok(selector.startsWith(":where("));
});

test("content, editors and inputs stay selectable, also inside the chrome", () => {
  assert.ok(content, "a rule with user-select: text for content");
  const [selector, body] = content;
  assert.match(body, /-webkit-touch-callout:\s*default/);
  for (const part of ["input", "textarea", '[contenteditable]:not([contenteditable="false"])', ".ProseMirror", "pre", "code", '[role="alert"]', ".search-snippet", ".selectable"])
    assert.ok(selector.includes(part), `content rule covers ${part}`);
  // None of them is in the chrome rule.
  const [chromeSelector] = chrome!;
  // Toggle blocks (details/summary) and tables of documents are content.
  for (const part of ["input", "textarea", "contenteditable", "ProseMirror", "code", "pre,", "summary", " thead th"]) assert.ok(!chromeSelector.replace(/\.[a-z-]+ thead th/g, "").includes(part), `${part} is not chrome`);
  // The content rule comes after the chrome rule and outranks it anyway.
  assert.ok(rules.indexOf(content!) > rules.indexOf(chrome!));
});

test("the tab bar is chrome and search snippets are content in the markup", () => {
  assert.match(readFileSync("components/mobile-tab-bar.tsx", "utf8"), /className="mobile-tab-bar"/);
  assert.match(readFileSync("components/workspace-app.tsx", "utf8"), /"search-snippet"/);
});
