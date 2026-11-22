import { test } from "node:test";
import assert from "node:assert/strict";
import { absoluteCssUrls, APP_PRINT_IMAGE_BUDGET, APP_PRINT_MAX_CHARS, printWay, styleText } from "../lib/print-way";

const print = () => {};

test("the app prints itself where it offers it, on Android and on iOS (#424)", () => {
  assert.equal(printWay({ app: { print }, ios: false, standalone: false }), "app");
  assert.equal(printWay({ app: { print }, ios: true, standalone: false }), "app");
});

test("older apps and browsers keep their ways", () => {
  // Android app before print: a frame as before (its web view ignores it).
  assert.equal(printWay({ app: {}, ios: false, standalone: false }), "frame");
  // iPhone/iPad app before print: the copy in the page, as before.
  assert.equal(printWay({ app: {}, ios: true, standalone: false }), "in-page");
  assert.equal(printWay({ app: { print: "yes" }, ios: true, standalone: false }), "in-page");
  // Home screen app on the iPhone: the print view in the browser.
  assert.equal(printWay({ ios: true, standalone: true }), "browser");
  // Safari, and every other browser.
  assert.equal(printWay({ app: null, ios: true, standalone: false }), "in-page");
  assert.equal(printWay({ ios: false, standalone: false }), "frame");
  assert.equal(printWay({ ios: false, standalone: true }), "frame");
});

test("the app's limit leaves room for pictures as base64 and the styles", () => {
  assert.equal(APP_PRINT_MAX_CHARS, 25 * 1024 * 1024);
  assert.ok((APP_PRINT_IMAGE_BUDGET * 4) / 3 < APP_PRINT_MAX_CHARS - 2 * 1024 * 1024);
});

test("relative addresses in a style sheet become absolute against the sheet", () => {
  const sheet = "https://plan.example/_next/static/css/app.css";
  assert.equal(
    absoluteCssUrls("@font-face{src:url(../media/a.woff2) format('woff2')}", sheet),
    "@font-face{src:url(https://plan.example/_next/static/media/a.woff2) format('woff2')}",
  );
  assert.equal(absoluteCssUrls('a{background:url("/icons/x.svg")}', sheet), 'a{background:url("https://plan.example/icons/x.svg")}');
  assert.equal(absoluteCssUrls("a{background:url( 'b.png' )}", sheet), "a{background:url('https://plan.example/_next/static/css/b.png')}");
  for (const kept of ["url(data:image/png;base64,AAAA)", "url(https://cdn.example/x.png)", "url(#mask)", "url()"])
    assert.equal(absoluteCssUrls(`a{b:${kept}}`, sheet), `a{b:${kept}}`);
});

test("a style sheet cannot end its <style> early", () => {
  assert.equal(styleText("a{content:'</style><script>'}"), "a{content:'<\\/style><script>'}");
  assert.equal(styleText("a{content:'</STYLE>'}"), "a{content:'<\\/STYLE>'}");
});
