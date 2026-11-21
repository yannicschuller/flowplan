import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  pageLocationHash,
  parsePageLocation,
  notificationUrl,
  loginReturnPath,
  inAppPageHash,
} from "../lib/page-location";
const pageId = "11111111-1111-4111-8111-111111111111",
  rowId = "22222222-2222-4222-8222-222222222222",
  threadId = "33333333-3333-4333-8333-333333333333";
test("internal locations round-trip page, row and thread; reject malformed or ambiguous navigation", () => {
  for (const target of [
    { pageId },
    { pageId, rowId },
    { pageId, threadId },
    { pageId, rowId, threadId },
  ]) {
    assert.deepEqual(parsePageLocation(pageLocationHash(target)), target);
    assert.equal(
      notificationUrl({
        page_id: pageId,
        row_id: target.rowId,
        thread_id: target.threadId,
      }),
      `/${pageLocationHash(target)}`,
    );
  }
  assert.equal(notificationUrl({ page_id: null }), "/#inbox");
  for (const hash of [
    "#page=bad",
    `#page=${pageId}&page=${rowId}`,
    `#page=${pageId}&row=`,
    `#page=${pageId}&thread=bad`,
    `#page=${pageId}&next=https://evil.test`,
    `#thread=${threadId}`,
  ])
    assert.equal(parsePageLocation(hash), null);
});
test("service worker carries only validated internal targets through push and notification clicks", async () => {
  const handlers: Record<string, (event: any) => void> = {},
    shown: any[] = [],
    navigated: string[] = [],
    opened: string[] = [];
  let existing = true;
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    URL,
    URLSearchParams,
    self: {
      location: { origin: "https://flowplan.test" },
      addEventListener: (name: string, fn: any) => (handlers[name] = fn),
      registration: {
        showNotification: async (_: string, options: any) =>
          shown.push(options),
      },
      clients: {
        matchAll: async () =>
          existing
            ? [
                {
                  url: "https://flowplan.test/#home",
                  navigate: async (url: string) => navigated.push(url),
                  focus: async () => {},
                },
              ]
            : [],
        openWindow: async (url: string) => opened.push(url),
      },
    },
  });
  const valid = `/#page=${pageId}&row=${rowId}&thread=${threadId}`;
  for (const input of [
    valid,
    "/#inbox",
    "https://evil.test",
    "//evil.test/#inbox",
    `/#page=${pageId}&row=bad`,
    `/#page=${pageId}&page=${rowId}`,
    `/#page=${pageId}&redirect=bad`,
    undefined,
  ]) {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.push({
      data: { json: () => ({ url: input, body: "New notification" }) },
      waitUntil: (p: Promise<unknown>) => (pending = p),
    });
    await pending;
    const expected = input === valid ? valid : "/#inbox";
    assert.equal(shown.at(-1).data.url, expected);
    handlers.notificationclick({
      notification: { data: { url: input }, close() {} },
      waitUntil: (p: Promise<unknown>) => (pending = p),
    });
    await pending;
    assert.equal(navigated.at(-1), `https://flowplan.test${expected}`);
  }
  existing = false;
  let pending: Promise<unknown> = Promise.resolve();
  handlers.notificationclick({
    notification: { data: { url: valid }, close() {} },
    waitUntil: (p: Promise<unknown>) => (pending = p),
  });
  await pending;
  assert.deepEqual(opened, [`https://flowplan.test${valid}`]);
});

test("login return targets preserve exact internal discussions without open redirects", () => {
  const path = `/#page=${pageId}&row=${rowId}&thread=${threadId}`;
  assert.equal(loginReturnPath(path), path);
  assert.equal(loginReturnPath("/#inbox"), "/#inbox");
  // The desktop app's sign-in through the browser.
  const desktop = `/api/auth/desktop?challenge=${"a".repeat(43)}`;
  assert.equal(loginReturnPath(desktop), desktop);
  for (const input of [
    `${desktop}&via=sso`,
    `/api/auth/desktop?challenge=${"a".repeat(42)}`,
    `//evil.test/api/auth/desktop?challenge=${"a".repeat(43)}`,
    null,
    undefined,
    "",
    "/",
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/%2f%2fevil.test",
    `/#page=${pageId}&next=https://evil.test`,
    "/#page=invalid",
    "/api/admin",
  ])
    assert.equal(loginReturnPath(input), "/");
});

test("read-only documents open only this app's page links in the same window (#274)", () => {
  const base = `https://flow.example/#page=${threadId}`;
  assert.equal(inAppPageHash(`/#page=${pageId}`, base), `#page=${pageId}`);
  assert.equal(inAppPageHash(`#page=${pageId}`, base), `#page=${pageId}`);
  assert.equal(inAppPageHash(`https://flow.example/#page=${pageId}`, base), `#page=${pageId}`);
  // Record and block links keep their target.
  assert.equal(inAppPageHash(`/#page=${pageId}&row=${rowId}`, base), `#page=${pageId}&row=${rowId}`);
  assert.equal(inAppPageHash(`/#page=${pageId}&block=b1`, base), `#page=${pageId}&block=b1`);
  for (const href of [
    // Another Flowplan instance, another path (published pages), queries.
    `https://other.example/#page=${pageId}`,
    `//other.example/#page=${pageId}`,
    `/s/token#page=${pageId}`,
    `/?x=1#page=${pageId}`,
    // Not a page location.
    "/#page=invalid",
    `/#page=${pageId}&evil=1`,
    "https://example.com/",
    "javascript:alert(1)//#page=x",
    "",
  ])
    assert.equal(inAppPageHash(href, base), null, href);
});
test("a link to a view starts its study session (#340): view and study only together, never with a record", () => {
  for (const target of [{ pageId, viewId: "table" }, { pageId, viewId: "44444444-4444-4444-8444-444444444444", study: true }])
    assert.deepEqual(parsePageLocation(pageLocationHash(target)), target);
  assert.equal(pageLocationHash({ pageId, viewId: "v1", study: true }), `#page=${pageId}&view=v1&study=1`);
  // Through the sign-in and as an in-app link the view stays.
  assert.equal(loginReturnPath(`/#page=${pageId}&view=v1&study=1`), `/#page=${pageId}&view=v1&study=1`);
  assert.equal(inAppPageHash(`/#page=${pageId}&view=v1&study=1`, "https://flowplan.test/"), `#page=${pageId}&view=v1&study=1`);
  for (const hash of [
    `#page=${pageId}&study=1`,
    `#page=${pageId}&view=v1&study=yes`,
    `#page=${pageId}&view=a%20b`,
    `#page=${pageId}&view=${"x".repeat(65)}`,
    `#page=${pageId}&view=v1&view=v2`,
    `#page=${pageId}&row=${rowId}&view=v1`,
  ])
    assert.equal(parsePageLocation(hash), null, hash);
});

test("a library's book or chapter opened in the editor (#329): edit only alone", () => {
  const pageId = "11111111-1111-4111-8111-111111111111";
  const rowId = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(parsePageLocation(`#page=${pageId}&edit=1`), { pageId, edit: true });
  assert.equal(pageLocationHash({ pageId, edit: true }), `#page=${pageId}&edit=1`);
  // With a record, block or view it is a link into the page: no edit.
  assert.equal(pageLocationHash({ pageId, rowId, edit: true }), `#page=${pageId}&row=${rowId}`);
  for (const bad of [`#page=${pageId}&edit=0`, `#page=${pageId}&edit=1&row=${rowId}`, `#page=${pageId}&edit=1&block=b1`, `#page=${pageId}&edit=1&edit=1`])
    assert.equal(parsePageLocation(bad), null, bad);
});

test("a form that asks for a sign-in is a way back after it, nothing else under /forms (#416)", async () => {
  const { loginReturnPath, formReturnPath } = await import("../lib/page-location");
  const token = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.equal(formReturnPath(token), `/forms/${token}`);
  assert.equal(loginReturnPath(`/forms/${token}`), `/forms/${token}`);
  for (const bad of ["../x", `${token}/x`, "//evil.example", "", null, `${token}?a=1`])
    assert.equal(formReturnPath(bad), "", String(bad));
  assert.equal(loginReturnPath("/forms/../admin"), "/");
  assert.equal(loginReturnPath(`/forms/${token}//evil`), "/");
});
