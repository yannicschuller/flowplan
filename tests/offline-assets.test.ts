import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import * as assets from "../lib/offline-assets";
import { buildOfflineAssets, distDir, listStaticAssets, readBuildId } from "../lib/offline-assets-server";
import { storeApp, type OfflineApp } from "../components/offline";

// A build directory like .next: static files, a source map, a font in
// three formats and one only as .ttf, the build's manifest folder.
function fakeBuild(buildId?: string) {
  const dir = mkdtempSync(join(tmpdir(), "offline-assets-"));
  const file = (path: string, bytes: number) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), "x".repeat(bytes));
  };
  file("static/chunks/0abc.js", 100);
  file("static/chunks/0abc.js.map", 900);
  file("static/chunks/1def.css", 20);
  file("static/media/KaTeX_Main-Regular.1ryv.woff2", 30);
  file("static/media/KaTeX_Main-Regular.15u8.woff", 40);
  file("static/media/KaTeX_Main-Regular.0sym.ttf", 50);
  file("static/media/Only.9zz.ttf", 60);
  file("static/media/pdf.worker.min.35m0.mjs", 70);
  file("static/Bld123/_buildManifest.js", 5);
  if (buildId) writeFileSync(join(dir, "BUILD_ID"), `${buildId}\n`);
  return dir;
}

test("the asset list holds every file of the build except source maps and font fallbacks", (t) => {
  const dir = fakeBuild("Bld123");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(listStaticAssets(join(dir, "static")), [
    { path: "/_next/static/Bld123/_buildManifest.js", size: 5 },
    { path: "/_next/static/chunks/0abc.js", size: 100 },
    { path: "/_next/static/chunks/1def.css", size: 20 },
    { path: "/_next/static/media/KaTeX_Main-Regular.1ryv.woff2", size: 30 },
    // No .woff2 of this font: the .ttf is what the browser loads.
    { path: "/_next/static/media/Only.9zz.ttf", size: 60 },
    { path: "/_next/static/media/pdf.worker.min.35m0.mjs", size: 70 },
  ]);
  const list = buildOfflineAssets(dir, "0.6.0");
  assert.equal(list.build, "Bld123");
  assert.equal(list.version, "0.6.0");
  assert.equal(list.bytes, 5 + 100 + 20 + 30 + 60 + 70);
  // No build directory (a development server before its first page): empty.
  assert.deepEqual(listStaticAssets(join(dir, "missing")), []);
});

test("without BUILD_ID the build is named after its files", (t) => {
  const dir = fakeBuild();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = listStaticAssets(join(dir, "static"));
  const id = readBuildId(dir, files);
  assert.match(id, /^files-[0-9a-z]+$/);
  assert.equal(readBuildId(dir, files), id);
  assert.notEqual(readBuildId(dir, [...files, { path: "/_next/static/chunks/new.js", size: 1 }]), id);
  // An unusable BUILD_ID counts as none.
  writeFileSync(join(dir, "BUILD_ID"), "../../etc");
  assert.equal(readBuildId(dir, files), id);
});

test("the build is found where the server runs: standalone config, FLOWPLAN_DIST_DIR or .next", () => {
  const saved = { config: process.env.__NEXT_PRIVATE_STANDALONE_CONFIG, dist: process.env.FLOWPLAN_DIST_DIR };
  try {
    delete process.env.__NEXT_PRIVATE_STANDALONE_CONFIG;
    delete process.env.FLOWPLAN_DIST_DIR;
    assert.equal(distDir("/app"), "/app/.next");
    process.env.FLOWPLAN_DIST_DIR = ".next-e2e";
    assert.equal(distDir("/app"), "/app/.next-e2e");
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify({ distDir: "./.next" });
    assert.equal(distDir("/app"), "/app/.next");
  } finally {
    for (const [key, value] of [
      ["__NEXT_PRIVATE_STANDALONE_CONFIG", saved.config],
      ["FLOWPLAN_DIST_DIR", saved.dist],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("caches of other builds and the shared one before #47 are stale", () => {
  const names = ["flowplan-settings", "flowplan-data-v1", "flowplan-static-v1", "flowplan-static-A", "flowplan-static-B"];
  assert.equal(assets.staticCacheName("B"), "flowplan-static-B");
  assert.deepEqual(assets.staleStaticCaches(names, "B"), ["flowplan-static-v1", "flowplan-static-A"]);
  assert.deepEqual(assets.staleStaticCaches(names, "C"), ["flowplan-static-v1", "flowplan-static-A", "flowplan-static-B"]);
  const files = [
    { path: "/_next/static/a.js", size: 1 },
    { path: "/_next/static/b.js", size: 2 },
  ];
  assert.deepEqual(assets.missingAssets(files, ["/_next/static/a.js", "/other"]), [files[1]]);
  assert.equal(assets.fitsQuota(10, null), true);
  assert.equal(assets.fitsQuota(10, { quota: 0 }), true);
  assert.equal(assets.fitsQuota(1024 * 1024, { quota: 100 * 1024 * 1024, usage: 50 * 1024 * 1024 }), true);
  assert.equal(assets.fitsQuota(40 * 1024 * 1024, { quota: 100 * 1024 * 1024, usage: 50 * 1024 * 1024 }), false);
});

test("the service worker plans the same way", () => {
  const context: Record<string, unknown> = {
    self: { addEventListener() {}, location: { origin: "https://example.test" } },
  };
  runInNewContext(`${readFileSync("public/sw.js", "utf8")}\nself.offlineAssets = offlineAssets;`, context);
  const worker = (context.self as { offlineAssets: typeof assets }).offlineAssets;
  const names = ["flowplan-data-v1", "flowplan-static-v1", "flowplan-static-A", "flowplan-static-B"];
  assert.deepEqual(worker.staleStaticCaches(names, "B"), assets.staleStaticCaches(names, "B"));
  assert.equal(worker.staticCacheName("B"), assets.staticCacheName("B"));
  const files = [{ path: "/x", size: 1 }, { path: "/y", size: 1 }];
  assert.deepEqual(JSON.parse(JSON.stringify(worker.missingAssets(files, ["/x"]))), assets.missingAssets(files, ["/x"]));
  for (const estimate of [null, { quota: 100e6, usage: 90e6 }, { quota: 100e6, usage: 10e6 }])
    assert.equal(worker.fitsQuota(5e6, estimate), assets.fitsQuota(5e6, estimate));
});

// In-memory Cache Storage, enough for storing the app's files.
const ORIGIN = "https://example.test";
const keyOf = (r: string | Request) => {
  const url = new URL(typeof r === "string" ? r : r.url, ORIGIN);
  return url.pathname + url.search;
};
class FakeCache {
  entries = new Map<string, Response>();
  async match(r: string | Request) {
    return this.entries.get(keyOf(r))?.clone();
  }
  async put(r: string | Request, response: Response) {
    this.entries.set(keyOf(r), response);
  }
  async keys() {
    return [...this.entries.keys()].map((k) => new Request(ORIGIN + k));
  }
  async delete(r: string | Request) {
    return this.entries.delete(keyOf(r));
  }
}
class FakeCaches {
  stores = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name)!;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  async match(r: string | Request) {
    for (const store of this.stores.values()) {
      const hit = await store.match(r);
      if (hit) return hit;
    }
    return undefined;
  }
}

type Store = (
  list: assets.OfflineAssets,
  shell: boolean,
  env: { caches: FakeCaches; fetch: (path: string) => Promise<Response>; estimate?: { quota: number; usage: number } },
) => Promise<OfflineApp | undefined>;


// components/offline.ts (the open app) …
const fromPage: Store = async (list, shell, env) => {
  const g = globalThis as Record<string, unknown>;
  const saved = { caches: g.caches, fetch: g.fetch };
  const storage = env.estimate ? { estimate: async () => env.estimate } : undefined;
  Object.defineProperty(globalThis.navigator, "storage", { value: storage, configurable: true });
  g.caches = env.caches;
  g.fetch = (path: string) => env.fetch(path);
  try {
    return await storeApp(list, { shell, live: async () => true });
  } finally {
    g.caches = saved.caches;
    g.fetch = saved.fetch;
    Object.defineProperty(globalThis.navigator, "storage", { value: undefined, configurable: true });
  }
};
// … and public/sw.js (Periodic Background Sync).
const fromWorker: Store = async (list, shell, env) => {
  const context: Record<string, unknown> = {
    self: {
      addEventListener() {},
      location: { origin: ORIGIN },
      navigator: { storage: env.estimate ? { estimate: async () => env.estimate } : undefined },
    },
    caches: env.caches,
    fetch: (path: string) => env.fetch(path),
    URL,
    Request,
    Response,
  };
  runInNewContext(`${readFileSync("public/sw.js", "utf8")}\nself.storeApp = storeApp;`, context);
  const run = (context.self as { storeApp: (a: unknown, s: boolean, o: () => Promise<boolean>) => Promise<unknown> }).storeApp;
  return JSON.parse(JSON.stringify(await run(list, shell, async () => true))) as OfflineApp;
};

for (const [name, store] of [
  ["the app", fromPage],
  ["the service worker", fromWorker],
] as const) {
  test(`${name} stores every file of a new build and removes older builds once its page is stored`, async () => {
    const caches = new FakeCaches();
    (await caches.open("flowplan-data-v1")).put("/", new Response("<html>"));
    (await caches.open("flowplan-static-v1")).put("/_next/static/chunks/ancient.js", new Response("old"));
    // An unchanged chunk keeps its name: copied from the older build.
    (await caches.open("flowplan-static-B1")).put("/_next/static/chunks/shared.js", new Response("shared"));
    const fetched: string[] = [];
    const env = {
      caches,
      fetch: async (path: string) => {
        fetched.push(path);
        return path.includes("broken") ? new Response("", { status: 404 }) : new Response(`body of ${path}`);
      },
    };
    const list: assets.OfflineAssets = {
      build: "B2",
      version: "0.7.0",
      files: ["shared.js", "editor.js", "calendar.js", "dashboard.js"].map((f) => ({ path: `/_next/static/chunks/${f}`, size: 10 })),
      bytes: 40,
    };
    // The app's page of the new build is not stored yet: older builds stay
    // (the stored page still needs their files).
    let app = await store(list, false, env);
    assert.deepEqual(app, { build: "B2", version: "0.7.0", stored: 4, total: 4, bytes: 40, complete: true, shell: false });
    assert.deepEqual(fetched.sort(), ["/_next/static/chunks/calendar.js", "/_next/static/chunks/dashboard.js", "/_next/static/chunks/editor.js"]);
    assert.equal(await (await caches.open("flowplan-static-B2")).match("/_next/static/chunks/shared.js").then((r) => r?.text()), "shared");
    assert.deepEqual((await caches.keys()).sort(), ["flowplan-data-v1", "flowplan-static-B1", "flowplan-static-B2", "flowplan-static-v1"]);
    // With its page: nothing is fetched again, the older builds go.
    fetched.length = 0;
    app = await store(list, true, env);
    assert.equal(app?.complete, true);
    assert.deepEqual(fetched, []);
    assert.deepEqual((await caches.keys()).sort(), ["flowplan-data-v1", "flowplan-static-B2"]);
    assert.equal((await (await caches.open("flowplan-static-B2")).keys()).length, 4);

    // A file that fails: incomplete, and the older build is kept.
    (await caches.open("flowplan-static-B2")).put("/_next/static/chunks/keep.js", new Response("x"));
    const next = { ...list, build: "B3", files: [...list.files, { path: "/_next/static/chunks/broken.js", size: 10 }] };
    app = await store(next, true, env);
    assert.equal(app?.complete, false);
    assert.equal(app?.stored, 4);
    assert.equal(app?.total, 5);
    assert.deepEqual((await caches.keys()).sort(), ["flowplan-data-v1", "flowplan-static-B2", "flowplan-static-B3"]);
  });

  test(`${name} stores nothing when the device lacks room`, async () => {
    const caches = new FakeCaches();
    const fetched: string[] = [];
    const list: assets.OfflineAssets = {
      build: "B9",
      version: "0.7.0",
      files: [{ path: "/_next/static/chunks/big.js", size: 30 * 1024 * 1024 }],
      bytes: 30 * 1024 * 1024,
    };
    const app = await store(list, true, {
      caches,
      fetch: async (path) => {
        fetched.push(path);
        return new Response("x");
      },
      estimate: { quota: 100 * 1024 * 1024, usage: 60 * 1024 * 1024 },
    });
    assert.equal(app?.space, true);
    assert.equal(app?.complete, false);
    assert.deepEqual(fetched, []);
  });
}
