// The export dialog's clipboard destination (#220): the clipboard is asked
// in the click itself (text still on its way), HTML also as text/html, a
// fallback to writeText, the export's own errors first, and the remembered
// choice per device.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
const { copyExport, absoluteLinks, storedDestination, storeDestination, DESTINATION_KEY } = await import("../lib/export-clipboard");

type Written = { types: Record<string, string> } | { text: string };
const g = globalThis as Record<string, unknown>;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
function clipboard(options: { item?: boolean; failWrite?: boolean; failText?: boolean } = {}) {
  const written: Written[] = [];
  const calls: string[] = [];
  const api = {
    async write(items: { parts: Record<string, Promise<Blob>> }[]) {
      calls.push("write");
      if (options.failWrite) throw new Error("NotAllowedError");
      const types: Record<string, string> = {};
      for (const [type, blob] of Object.entries(items[0].parts)) types[type] = await (await blob).text();
      written.push({ types });
    },
    async writeText(text: string) {
      calls.push("writeText");
      if (options.failText) throw new Error("NotAllowedError");
      written.push({ text });
    },
  };
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: api }, configurable: true });
  if (options.item === false) delete g.ClipboardItem;
  else
    g.ClipboardItem = class {
      constructor(public parts: Record<string, Promise<Blob>>) {}
    };
  return { written, calls };
}
afterEach(() => {
  delete g.ClipboardItem;
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete g.navigator;
});

test("the clipboard is asked before the text has arrived", async () => {
  const { written, calls } = clipboard();
  let arrive!: (value: { text: string }) => void;
  const content = new Promise<{ text: string }>((resolve) => (arrive = resolve));
  const done = copyExport(content);
  // Synchronously, in the same click: Safari would refuse it later.
  assert.deepEqual(calls, ["write"]);
  arrive({ text: "h1. Titel" });
  await done;
  assert.deepEqual(written, [{ types: { "text/plain": "h1. Titel" } }]);
});

test("HTML goes as text/html and as its source in text/plain", async () => {
  const { written } = clipboard();
  await copyExport(Promise.resolve({ text: "<!doctype html><body><p>Hallo</p></body>", html: "<p>Hallo</p>" }), true);
  assert.deepEqual(written, [{ types: { "text/plain": "<!doctype html><body><p>Hallo</p></body>", "text/html": "<p>Hallo</p>" } }]);
});

test("without ClipboardItem, or when write is refused, writeText follows", async () => {
  const first = clipboard({ item: false });
  await copyExport(Promise.resolve({ text: "eins" }));
  assert.deepEqual(first.written, [{ text: "eins" }]);
  const second = clipboard({ failWrite: true });
  await copyExport(Promise.resolve({ text: "zwei" }));
  assert.deepEqual(second.calls, ["write", "writeText"]);
  assert.deepEqual(second.written, [{ text: "zwei" }]);
});

test("the export's own error is the one reported; a refused clipboard says what to do", async () => {
  clipboard();
  await assert.rejects(copyExport(Promise.reject(new Error("Keine Berechtigung für diese Seite."))), /Keine Berechtigung/);
  clipboard({ failWrite: true, failText: true });
  await assert.rejects(copyExport(Promise.resolve({ text: "x" })), /Datei|file/);
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
  await assert.rejects(copyExport(Promise.resolve({ text: "x" })), /Zwischenablage|clipboard/);
});

test("links of the instance become full addresses, others stay", () => {
  assert.equal(
    absoluteLinks(`<img src="/api/files/abc"><a href="/#page=1">P</a><a href="https://x.org/">X</a><a href="//cdn.org/a">C</a>`, "https://fp.example"),
    `<img src="https://fp.example/api/files/abc"><a href="https://fp.example/#page=1">P</a><a href="https://x.org/">X</a><a href="//cdn.org/a">C</a>`,
  );
});

test("the destination is remembered per device, and storage may fail", () => {
  const store = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.equal(storedDestination(), "file");
  storeDestination("clipboard");
  assert.equal(store.get(DESTINATION_KEY), "clipboard");
  assert.equal(storedDestination(), "clipboard");
  g.localStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.equal(storedDestination(), "file");
  assert.doesNotThrow(() => storeDestination("file"));
  delete g.localStorage;
});
