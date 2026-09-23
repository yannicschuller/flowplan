import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  pageLocationHash,
  parsePageLocation,
  notificationUrl,
  loginReturnPath,
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
  for (const input of [
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
