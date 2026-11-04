import assert from "node:assert/strict";
import { test } from "node:test";
import { copyImage } from "../lib/copy-image";

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

function setup(opts: { write?: () => Promise<void>; canShare?: boolean; type?: string }) {
  const calls = { write: 0, share: 0 };
  g.fetch = async () => new Response(new Blob(["x"], { type: opts.type || "image/png" }));
  g.ClipboardItem = class { constructor(public items: unknown) {} };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    clipboard: { write: async () => { calls.write++; await opts.write?.(); } },
    canShare: () => !!opts.canShare,
    share: async () => { calls.share++; },
  } });
  return calls;
}

test("a PNG goes straight to the clipboard", async () => {
  const calls = setup({});
  assert.equal(await copyImage("/uploads/a.png"), "copied");
  assert.equal(calls.write, 1);
});

test("without clipboard access the share sheet is used", async () => {
  const calls = setup({ write: async () => { throw new Error("denied"); }, canShare: true });
  assert.equal(await copyImage("/uploads/a.png"), "shared");
  assert.equal(calls.share, 1);
});

test("without both the device is reported as unsupported", async () => {
  setup({ write: async () => { throw new Error("denied"); } });
  assert.equal(await copyImage("/uploads/a.png"), "unsupported");
});

test("a failed download is an error", async () => {
  setup({});
  g.fetch = async () => new Response("no", { status: 404 });
  await assert.rejects(copyImage("/uploads/missing.png"));
});
