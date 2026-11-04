// Shared helpers for the README media scripts (scripts/readme-media/).
//
//   MEDIA_URL   the running dev instance (default http://127.0.0.1:3000)
//   MEDIA_DIR   working directory for state, raw videos and PNGs
//               (default <tmp>/flowplan-readme-media)
//   CHROMIUM    path to a Chromium binary (optional; Playwright's own otherwise)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(new URL("../../package.json", import.meta.url));
export const { chromium } = require("playwright");
export const APP = (process.env.MEDIA_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
export const DIR = process.env.MEDIA_DIR || join(tmpdir(), "flowplan-readme-media");
export const ASSETS = new URL("../../.github/assets/readme/", import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });
export const state = (who) => join(DIR, `state-${who}.json`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const PASSWORD = "kickoff-atlas-2026!";

export async function launch() {
  return chromium.launch({
    ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
}
export async function context(browser, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "en-GB",
    timezoneId: "Europe/Berlin",
    storageState: opts.who ? state(opts.who) : undefined,
    ...opts.extra,
  });
  // The dev server's "N" indicator does not belong in screenshots.
  await ctx.addInitScript(HIDE_DEV_SCRIPT);
  // A busy dev server compiles slowly.
  ctx.setDefaultTimeout(90_000);
  ctx.setDefaultNavigationTimeout(120_000);
  return ctx;
}
// Opens a page of the app by id.
export async function open(page, pageId) {
  const hash = `#page=${pageId}`;
  await page.goto(`${APP}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.getByText("Northwind Studio").first().waitFor();
  await sleep(1000);
  // The app may settle on Home first; go to the page once it is ready.
  await page.evaluate((h) => { if (location.hash !== h) location.hash = h; }, hash);
}
const HIDE_DEV_SCRIPT = `
addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('style');
  s.textContent = 'nextjs-portal{display:none!important}';
  document.head.appendChild(s);
});
`;
async function check(res, label) {
  const text = await res.text();
  if (!res.ok()) throw new Error(`${label} ${res.status()} ${text}`);
  return text ? JSON.parse(text) : null;
}
export async function cmd(page, body) {
  const res = await page.request.post(APP + "/api/command", {
    headers: { Origin: APP, "content-type": "application/json" },
    data: body,
  });
  return check(res, body.action);
}
export async function post(page, path, data) {
  const res = await page.request.post(APP + "/api/" + path, {
    headers: { Origin: APP, "content-type": "application/json" },
    data,
  });
  return check(res, path);
}
export async function get(page, path) {
  return check(await page.request.get(APP + "/api/" + path, { headers: { Origin: APP } }), path);
}

// Eased mouse movement, so recordings look like a person.
const mice = new WeakMap();
export async function move(page, x, y, ms = 500) {
  const from = mice.get(page) || { x: 640, y: 400 };
  const steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await sleep(ms / steps);
  }
  mice.set(page, { x, y });
}
export async function moveTo(page, locator, ms = 500, dx = 0.5, dy = 0.5) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not visible: " + locator);
  await move(page, b.x + b.width * dx, b.y + b.height * dy, ms);
  return b;
}
export async function typeSlowly(page, text, delay = 55) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(delay + Math.random() * 35);
  }
}

// Headless video has no mouse pointer: draw one.
export const CURSOR_SCRIPT = `
(() => {
  const install = () => {
    if (document.getElementById('__cursor')) return;
    const c = document.createElement('div');
    c.id = '__cursor';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 14.8 L11.6 21.6 L14.4 20.4 L11.3 13.7 L17.5 13.4 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '-50px', top: '0px', width: '22px', height: '22px', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-4px,-2px)' });
    document.documentElement.appendChild(c);
    const at = (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; };
    window.addEventListener('mousemove', at, true);
    window.addEventListener('pointermove', at, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();
`;
