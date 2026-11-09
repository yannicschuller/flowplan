// An outdated stored copy never leaves a broken page (#61): the build id in
// every answer and page, the page's own check (lib/stale-copy.ts, run here
// in a small stand-in for the browser) and the service worker that shows a
// stored page only with all its files and fills files of an older build
// from the copy (public/sw.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { BUILD_HEADER, BUILD_META, CHECK_EVENT, CHECK_GAP, FRESH_PARAM, HEAL_KEY, HEAL_WINDOW, RETURN_GAP, STALE_BUILD_EVENT, STALE_CHUNK_EVENT, START_WINDOW, healStep, noticeBuild, selfHealScript } from "../lib/stale-copy";

test("the page reloads once when its files are gone, then shows a message", () => {
  const live = { build: "B" };
  // Its own style sheets or scripts did not load.
  assert.equal(healStep("boot", "A", live, false), "reload");
  assert.equal(healStep("boot", "A", live, true), "message");
  // The same build on the server (a hiccup): one reload all the same.
  assert.equal(healStep("boot", "B", live, false), "reload");
  // Offline a reload brings the same copy back.
  assert.equal(healStep("boot", "A", null, false), "message");
  // Later (a part loaded on demand, back/forward cache, service worker):
  // only a newer build is a reason, and only once.
  assert.equal(healStep("later", "A", live, false), "reload");
  assert.equal(healStep("later", "A", live, true), "none");
  assert.equal(healStep("later", "B", live, false), "none");
  assert.equal(healStep("later", "A", null, false), "none");
  assert.equal(healStep("later", "A", { build: null }, false), "none");
});

// A browser just big enough for the inline script.
type Element = {
  localName: string;
  nodeType: 1;
  id?: string;
  attrs: Map<string, string>;
  children: Element[];
  style: Record<string, string>;
  textContent?: string;
  sheet?: object | null;
  isConnected: boolean;
  href?: string;
  listeners: Map<string, (() => void)[]>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: Element): Element;
  addEventListener(type: string, listener: () => void): void;
};
const ORIGIN = "https://flowplan.example.test";
function element(localName: string, attrs: Record<string, string> = {}): Element {
  const el: Element = {
    localName,
    nodeType: 1,
    attrs: new Map(Object.entries(attrs)),
    children: [],
    style: {},
    isConnected: true,
    listeners: new Map(),
    getAttribute: (name) => el.attrs.get(name) ?? null,
    setAttribute: (name, value) => void el.attrs.set(name, value),
    appendChild: (child) => (el.children.push(child), child),
    addEventListener: (type, listener) => void el.listeners.set(type, [...(el.listeners.get(type) || []), listener]),
  };
  if (attrs.href) el.href = new URL(attrs.href, ORIGIN).href;
  return el;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

function page({
  url = `${ORIGIN}/`,
  build = "A",
  server = "B" as string | null,
  styled = true,
  next = true,
  sheetLoaded = true,
  copy = false,
  lastHeal = null as number | null,
  storage = true,
  worker = false,
  caches = null as null | Map<string, Set<string>>,
  desktop = false,
} = {}) {
  // The clock of the page (Date.now) and what the server answers can change
  // while it is open.
  const clock = { now: Date.now() };
  const net = { server };
  const desktopCleared: number[] = [];
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  // Timers run when the test flushes; the 5 s limit of the server's answer
  // never comes first.
  const timers: (() => void)[] = [];
  const stored = new Map<string, string>();
  if (lastHeal !== null) stored.set(HEAL_KEY, String(lastHeal));
  const posted: unknown[] = [];
  const replaced: string[] = [];
  const fetched: string[] = [];
  const root = Object.assign(element("html"), { lang: "de" });
  const sheet = element("link", { rel: "stylesheet", href: "/_next/static/chunks/app.css" });
  sheet.sheet = sheetLoaded ? {} : null;
  const state = { url };
  const window: Record<string, unknown> = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, [...(listeners.get(type) || []), listener]),
    setTimeout: (callback: () => void, ms = 0) => (ms < 5000 ? timers.push(callback) : 0),
    clearTimeout() {},
    getComputedStyle: () => ({ getPropertyValue: (name: string) => (styled && name === "--flowplan-styles" ? " 1" : "") }),
    location: {
      get href() {
        return state.url;
      },
      origin: ORIGIN,
      replace: (to: string) => replaced.push(to),
    },
    history: { state: { tree: 1 }, replaceState: (_: unknown, __: string, to: string) => (state.url = new URL(to, ORIGIN).href) },
    sessionStorage: {
      getItem: (key: string) => {
        if (!storage) throw new Error("blocked");
        return stored.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (!storage) throw new Error("blocked");
        stored.set(key, value);
      },
      removeItem: (key: string) => void stored.delete(key),
    },
    fetch: async (path: string) => {
      fetched.push(path);
      if (net.server === null) throw new TypeError("offline");
      const build = net.server;
      return { headers: { get: (name: string) => (name.toLowerCase() === BUILD_HEADER.toLowerCase() ? build : null) } };
    },
    navigator: {
      onLine: server !== null,
      ...(worker || caches
        ? { serviceWorker: { controller: worker ? {} : null, getRegistrations: async () => [{ update: async () => {} }] } }
        : {}),
    },
    ReactNativeWebView: { postMessage: (data: string) => posted.push(JSON.parse(data)) },
    CSS: { escape: (value: string) => value },
    URL,
    Promise,
    Number,
    String,
    Date: { now: () => clock.now },
    JSON,
    ...(desktop ? { FlowplanDesktop: { clearCache: async () => (desktopCleared.push(clock.now), true) } } : {}),
    document: {
      visibilityState: "visible",
      documentElement: root,
      querySelector: (selector: string) => (selector.includes("flowplan-offline-copy") ? (copy ? element("meta") : null) : null),
      querySelectorAll: (selector: string) => (selector.includes("stylesheet") ? [sheet] : []),
      getElementById: (id: string) => root.children.find((child) => child.id === id) || null,
      createElement: (name: string) => element(name),
    },
  };
  if (next) window.next = { version: "16" };
  if (caches)
    window.caches = {
      keys: async () => [...caches.keys()],
      open: async (name: string) => ({ delete: async (key: string) => caches.get(name)?.delete(key) }),
      delete: async (name: string) => caches.delete(name),
    };
  window.window = window;
  runInNewContext(selfHealScript(build), window);
  const fire = (type: string, event: unknown = {}) => {
    for (const listener of listeners.get(type) || []) listener(event);
  };
  const flush = async () => {
    for (let round = 0; round < 5; round++) {
      await tick();
      while (timers.length) timers.shift()!();
    }
    await tick();
  };
  // The page has loaded: its check runs.
  const load = async () => {
    fire("DOMContentLoaded");
    fire("load");
    await flush();
  };
  const message = () => root.children.find((child) => child.id === "flowplan-stale");
  const visibility = async (to: "hidden" | "visible") => {
    (window.document as { visibilityState: string }).visibilityState = to;
    fire("visibilitychange");
    await flush();
  };
  return { fire, flush, load, posted, replaced, fetched, stored, message, state, root, clock, net, visibility, desktopCleared };
}

test("a page without its styles loads the live page once, past the stored copy", async () => {
  const caches = new Map([
    ["flowplan-data-v1", new Set(["/", "/api/bootstrap"])],
    ["flowplan-static-A", new Set(["/_next/static/chunks/app.css"])],
  ]);
  const p = page({ styled: false, sheetLoaded: false, caches });
  await p.load();
  assert.equal(p.replaced.length, 1);
  const target = new URL(p.replaced[0]);
  assert.equal(target.pathname, "/");
  assert.ok(target.searchParams.has(FRESH_PARAM));
  // The stored page of the older build goes, its data stays.
  assert.deepEqual([...caches.get("flowplan-data-v1")!], ["/api/bootstrap"]);
  assert.ok(caches.has("flowplan-static-A"));
  assert.ok(Number(p.stored.get(HEAL_KEY)) > 0);
  // The app (flowplan-app) hears it.
  assert.deepEqual(p.posted, [{ type: "staleCopy", build: "A", clear: false }]);
  assert.equal(p.message(), undefined);
});

test("missing scripts count as well, the style sheet's error event too", async () => {
  const noScript = page({ next: false });
  await noScript.load();
  assert.equal(noScript.replaced.length, 1);
  const error = page();
  error.fire("error", { target: element("link", { rel: "stylesheet", href: "/_next/static/chunks/old.css" }) });
  await error.flush();
  assert.equal(error.replaced.length, 1);
  // Files elsewhere (fonts.css, other sites) are none of its business.
  const other = page();
  other.fire("error", { target: element("link", { rel: "stylesheet", href: "/fonts.css" }) });
  other.fire("error", { target: element("script", { src: "https://elsewhere.example/x.js" }) });
  await other.flush();
  assert.equal(other.fetched.length, 0);
});

test("no loop: after a recent reload the message with Reload and Clear cache", async () => {
  const p = page({ styled: false, lastHeal: Date.now() - 10_000 });
  await p.load();
  assert.equal(p.replaced.length, 0);
  const box = p.message();
  assert.ok(box);
  const buttons = box!.children[0].children.filter((child) => child.localName === "button");
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    ["Neu laden", "Zwischenspeicher leeren"],
  );
  // "Clear cache" drops the copy's files as well and reloads.
  buttons[1].listeners.get("click")![0]();
  await p.flush();
  assert.equal(p.replaced.length, 1);
  assert.deepEqual(p.posted.at(-1), { type: "staleCopy", build: "A", clear: true });
  // Long enough ago: another reload is allowed.
  const later = page({ styled: false, lastHeal: Date.now() - HEAL_WINDOW - 1000 });
  await later.load();
  assert.equal(later.replaced.length, 1);
});

test("without sessionStorage the address is the guard", async () => {
  const first = page({ styled: false, storage: false });
  await first.load();
  assert.equal(first.replaced.length, 1);
  const second = page({ styled: false, storage: false, url: first.replaced[0] });
  await second.load();
  assert.equal(second.replaced.length, 0);
  assert.ok(second.message());
});

test("offline the page says so instead of reloading", async () => {
  const p = page({ styled: false, server: null });
  await p.load();
  assert.equal(p.replaced.length, 0);
  assert.match(String(p.message()!.children[0].children[1].textContent), /Keine Verbindung/);
});

test("a working page asks nobody and drops the reload's mark from its address", async () => {
  const p = page({ url: `${ORIGIN}/?w=1&${FRESH_PARAM}=123#page=x` });
  await p.load();
  assert.equal(p.fetched.length, 0);
  assert.equal(p.replaced.length, 0);
  assert.equal(p.state.url, `${ORIGIN}/?w=1#page=x`);
});

test("later: parts of an older build reload the page, of the same build they do not", async () => {
  const older = page({ build: "A", server: "B" });
  await older.load();
  older.fire(STALE_CHUNK_EVENT);
  await older.flush();
  assert.equal(older.replaced.length, 1);
  const same = page({ build: "B", server: "B" });
  await same.load();
  same.fire("unhandledrejection", { reason: { name: "ChunkLoadError" } });
  same.fire("error", { target: element("script", { src: "/_next/static/chunks/lazy.js" }) });
  await same.flush();
  assert.equal(same.fetched.length, 1);
  assert.equal(same.replaced.length, 0);
  assert.equal(same.message(), undefined);
  // A page a service worker served is checked once after loading.
  const served = page({ build: "A", server: "B", worker: true });
  await served.load();
  assert.equal(served.replaced.length, 1);
  const current = page({ build: "B", server: "B", worker: true });
  await current.load();
  assert.equal(current.fetched.length, 1);
  assert.equal(current.replaced.length, 0);
  // Back from the back/forward cache after an update.
  const restored = page({ build: "A", server: "B" });
  await restored.load();
  restored.fire("pageshow", { persisted: true });
  await restored.flush();
  assert.equal(restored.replaced.length, 1);
});

test("#182: a page of an older build whose files all load reloads when the app sees the newer build", async () => {
  // Right after loading (an outdated page that loaded completely – from a
  // stored copy or a window open across an update): at once.
  const start = page({ build: "A", server: "B" });
  await start.load();
  assert.equal(start.fetched.length, 0, "a working page asks nobody by itself");
  start.fire(STALE_BUILD_EVENT);
  await start.flush();
  assert.equal(start.replaced.length, 1);
  assert.ok(new URL(start.replaced[0]).searchParams.has(FRESH_PARAM));
  // Later, while someone works in the page: not in the middle of it, but
  // when they come back to it.
  const working = page({ build: "A", server: "B" });
  await working.load();
  working.clock.now += START_WINDOW + 1000;
  working.fire(STALE_BUILD_EVENT);
  await working.flush();
  assert.equal(working.fetched.length, 0);
  await working.visibility("hidden");
  assert.equal(working.replaced.length, 0);
  await working.visibility("visible");
  assert.equal(working.replaced.length, 1);
  // Once: right after its own reload the page does not reload again.
  const again = page({ build: "A", server: "B", lastHeal: Date.now() - 5000 });
  await again.load();
  again.fire(STALE_BUILD_EVENT);
  await again.flush();
  // Every answer of the app names the build: asked once, not for each.
  again.fire(STALE_BUILD_EVENT);
  await again.flush();
  assert.equal(again.fetched.length, 1);
  assert.equal(again.replaced.length, 0);
  assert.equal(again.message(), undefined, "no message over a working page");
});

test("#182: errors ask the server – a newer build reloads, the same build does not, not on every error", async () => {
  const older = page({ build: "A", server: "B" });
  await older.load();
  older.fire(CHECK_EVENT);
  await older.flush();
  assert.equal(older.replaced.length, 1);
  // An error nobody caught (the white page) counts as well.
  const uncaught = page({ build: "A", server: "B" });
  await uncaught.load();
  uncaught.fire("error", { target: {}, error: new TypeError("x is undefined") });
  await uncaught.flush();
  assert.equal(uncaught.replaced.length, 1);
  // The same build: the error is the app's own, asked once in CHECK_GAP.
  const same = page({ build: "B", server: "B" });
  await same.load();
  same.fire(CHECK_EVENT);
  await same.flush();
  same.fire(CHECK_EVENT);
  same.fire("error", { target: {}, error: new TypeError("again") });
  await same.flush();
  assert.equal(same.fetched.length, 1);
  same.clock.now += CHECK_GAP;
  same.fire(CHECK_EVENT);
  await same.flush();
  assert.equal(same.fetched.length, 2);
  assert.equal(same.replaced.length, 0);
  assert.equal(same.message(), undefined);
});

test("#182: a page open for long asks again when one comes back to it", async () => {
  const p = page({ build: "A", server: "A" });
  await p.load();
  await p.visibility("hidden");
  await p.visibility("visible");
  assert.equal(p.fetched.length, 1, "the first return asks");
  await p.visibility("hidden");
  await p.visibility("visible");
  assert.equal(p.fetched.length, 1, "not again within RETURN_GAP");
  // The server was updated meanwhile.
  p.net.server = "B";
  p.clock.now += RETURN_GAP;
  await p.visibility("hidden");
  await p.visibility("visible");
  assert.equal(p.replaced.length, 1);
});

test("#182: a stored page shown without a connection asks again once it is back", async () => {
  const p = page({ build: "A", server: null, worker: true });
  await p.load();
  assert.equal(p.fetched.length, 1);
  assert.equal(p.replaced.length, 0);
  p.net.server = "B";
  p.fire("online");
  await p.flush();
  assert.equal(p.replaced.length, 1);
});

test("#182: in the desktop app the reload clears the window's HTTP cache first", async () => {
  const p = page({ build: "A", server: "B", desktop: true });
  await p.load();
  p.fire(STALE_CHUNK_EVENT);
  await p.flush();
  assert.equal(p.desktopCleared.length, 1);
  assert.equal(p.replaced.length, 1);
});

test("#182: the app's answers name the server's build", () => {
  const events: string[] = [];
  const saved = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, {
    document: { querySelector: (selector: string) => (selector === `meta[name="${BUILD_META}"]` ? { content: "A" } : null) },
    window: { dispatchEvent: (event: Event) => events.push(event.type) },
  });
  try {
    const answer = (build: string | null) => ({ get: (name: string) => (name === BUILD_HEADER ? build : null) });
    noticeBuild(answer("A"));
    noticeBuild(answer(null));
    assert.deepEqual(events, []);
    noticeBuild(answer("B"));
    assert.deepEqual(events, [STALE_BUILD_EVENT]);
  } finally {
    Object.assign(globalThis, saved);
  }
  assert.match(readFileSync("components/ui.tsx", "utf8"), /noticeBuild\(r\.headers\);\n  let data;/);
  for (const file of ["app/error.tsx", "app/global-error.tsx", "components/view-fallback.tsx"])
    assert.match(readFileSync(file, "utf8"), /new Event\((chunk \? STALE_CHUNK_EVENT : )?CHECK_EVENT\)/, file);
});

test("the app's stored copy is the app's to replace", async () => {
  const p = page({ styled: false, copy: true });
  await p.load();
  assert.equal(p.fetched.length, 0);
  assert.equal(p.replaced.length, 0);
  assert.deepEqual(p.posted, [{ type: "staleCopy", build: "A", copy: true }]);
  // An app that does not know the message: the page says it itself.
  assert.ok(p.message());
});

// public/sw.js: answers for navigations and the app's files.
const SW_ORIGIN = "https://example.test";
function worker({ network, stored }: { network: (path: string) => Response | Error; stored: Record<string, Record<string, Response>> }) {
  let fetchListener: ((event: unknown) => void) | null = null;
  const caches = {
    async open(name: string) {
      stored[name] ??= {};
      const cache = stored[name];
      const keyOf = (r: string | Request) => {
        const url = new URL(typeof r === "string" ? r : r.url, SW_ORIGIN);
        return url.pathname + url.search;
      };
      return {
        match: async (r: string | Request) => cache[keyOf(r)]?.clone(),
        put: async (r: string | Request, response: Response) => void (cache[keyOf(r)] = response),
      };
    },
    async match(r: string | Request) {
      const url = new URL(typeof r === "string" ? r : r.url, SW_ORIGIN);
      for (const cache of Object.values(stored)) {
        const hit = cache[url.pathname + url.search];
        if (hit) return hit.clone();
      }
      return undefined;
    },
    keys: async () => Object.keys(stored),
  };
  const context: Record<string, unknown> = {
    self: {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === "fetch") fetchListener = listener;
      },
      location: { origin: SW_ORIGIN },
    },
    caches,
    fetch: async (request: Request) => {
      const answer = network(new URL(request.url).pathname);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    URL,
    Request,
    Response,
  };
  runInNewContext(readFileSync("public/sw.js", "utf8"), context);
  return async (path: string, mode: RequestMode = "no-cors") => {
    const answers: Promise<Response>[] = [];
    const request = { url: SW_ORIGIN + path, method: "GET", mode, headers: new Headers() };
    fetchListener!({ request, respondWith: (promise: Promise<Response>) => answers.push(promise) });
    assert.equal(answers.length, 1, `${path} is answered by the worker`);
    return answers[0];
  };
}
const MARKER = { "/__flowplan-offline": new Response(JSON.stringify({ user: "u", app: { build: "A" } })) };
const pageA = `<html><head><link rel="stylesheet" href="/_next/static/chunks/a.css"/><script src="/_next/static/chunks/a.js" async=""></script></head><body></body></html>`;
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });

test("the service worker fills files of an older build from the copy instead of a 404", async () => {
  const handle = worker({
    network: (path) => (path === "/_next/static/chunks/a.css" ? new Response("gone", { status: 404 }) : new Response("new")),
    stored: { "flowplan-settings": MARKER, "flowplan-static-A": { "/_next/static/chunks/a.css": new Response(":root{--flowplan-styles:1}") } },
  });
  const css = await handle("/_next/static/chunks/a.css");
  assert.equal(css.status, 200);
  assert.equal(await css.text(), ":root{--flowplan-styles:1}");
  // Not in the copy: the server's answer as it is.
  const missing = worker({ network: () => new Response("gone", { status: 404 }), stored: { "flowplan-settings": MARKER } });
  assert.equal((await missing("/_next/static/chunks/b.js")).status, 404);
});

test("offline the service worker shows the stored page only with all its files", async () => {
  const offline = () => new TypeError("Failed to fetch");
  const complete = worker({
    network: offline,
    stored: {
      "flowplan-settings": MARKER,
      "flowplan-data-v1": { "/": html(pageA) },
      "flowplan-static-A": { "/_next/static/chunks/a.css": new Response("css"), "/_next/static/chunks/a.js": new Response("js") },
    },
  });
  assert.equal(await (await complete("/", "navigate")).text(), pageA);
  // A file of the page is missing: the browser's own offline page (the app
  // shows its offline screen) rather than a page without styles.
  const incomplete = worker({
    network: offline,
    stored: {
      "flowplan-settings": MARKER,
      "flowplan-data-v1": { "/": html(pageA) },
      "flowplan-static-A": { "/_next/static/chunks/a.js": new Response("js") },
    },
  });
  await assert.rejects(incomplete("/", "navigate"), /Failed to fetch/);
  // Online the live page, always.
  const online = worker({ network: () => html("live"), stored: { "flowplan-settings": MARKER, "flowplan-data-v1": { "/": html(pageA) } } });
  assert.equal(await (await online("/", "navigate")).text(), "live");
});

test("every page and answer names the running build", () => {
  const layout = readFileSync("app/layout.tsx", "utf8");
  assert.match(layout, /<meta name=\{BUILD_META\} content=\{build\} \/>/);
  assert.match(layout, /<script nonce=\{nonce\} dangerouslySetInnerHTML=\{\{ __html: selfHealScript\(build\) \}\} \/>/);
  assert.match(readFileSync("proxy.ts", "utf8"), /response\.headers\.set\(BUILD_HEADER, build\)/);
  assert.match(readFileSync("app/globals.css", "utf8"), /--flowplan-styles: 1;/);
  // The script survives a build id with quotes or a closing tag.
  assert.ok(!selfHealScript('x"</script>').includes("</script>"));
});
