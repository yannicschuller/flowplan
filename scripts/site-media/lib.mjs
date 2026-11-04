// Shared helpers for the media of the docs and the website
// (scripts/site-media/, see seed.mjs for the order). The same conventions as
// scripts/readme-media/ (the README's media):
//
//   MEDIA_URL   the running dev instance (default http://127.0.0.1:3000)
//   MEDIA_DATA  its FLOWPLAN_DATA_DIR (seed.mjs edits the demo accounts there)
//   MEDIA_DIR   working directory for state, raw videos and PNGs
//               (default ./.site-media, not committed)
//   CHROMIUM    path to a Chromium binary (optional; Playwright's own otherwise)
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(new URL("../../package.json", import.meta.url));
export const { chromium } = require("playwright");
export const APP = (process.env.MEDIA_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
export const DIR = process.env.MEDIA_DIR || join(process.cwd(), ".site-media");
export const DATA = process.env.MEDIA_DATA || "";
mkdirSync(DIR, { recursive: true });
export const state = (who) => join(DIR, `state-${who}.json`);
export const ids = () => JSON.parse(readFileSync(join(DIR, "ids.json"), "utf8"));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const PASSWORD = "kickoff-atlas-2026!";
export const VIEW = { width: 1280, height: 800 };

// Who is signed in for which language: Mia's team workspace (English) and
// the demo showcase in German (Lena) and English (Alex).
export const PEOPLE = { mia: "en", lena: "de", alex: "en" };

export async function launch() {
  return chromium.launch({
    ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
    args: ["--no-sandbox"],
  });
}

// The dev server's "N" indicator and toasts do not belong in screenshots.
const HIDE_CSS =
  "nextjs-portal,[data-nextjs-toast],[data-nextjs-dev-tools-button],.demo-banner{display:none!important}";

export async function context(browser, { who, lang = PEOPLE[who] || "en", dark = false, viewport = VIEW, scale = 1, extra = {} } = {}) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    locale: lang === "de" ? "de-DE" : "en-GB",
    timezoneId: "Europe/Berlin",
    extraHTTPHeaders: { "Accept-Language": lang === "de" ? "de-DE,de;q=0.9" : "en-GB,en;q=0.9" },
    colorScheme: dark ? "dark" : "light",
    storageState: who ? state(who) : undefined,
    ...extra,
  });
  await ctx.addCookies([{ name: "flowplan-lang", value: lang, url: APP }]);
  await ctx.addInitScript(
    ([css, dark]) => {
      try {
        localStorage.setItem("flowplan-theme", dark ? "dark" : "light");
      } catch {}
      const add = () => document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
      if (document.head) add();
      else document.addEventListener("DOMContentLoaded", add);
    },
    [HIDE_CSS, dark],
  );
  return ctx;
}

// Opens a hash route and waits until the page is drawn.
export async function open(page, hash, wait = 2500) {
  await page.goto(`${APP}/${hash ? "#" + hash : ""}`, { timeout: 300_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  await page
    .waitForFunction(() => !/Seite wird geöffnet|Opening page/.test(document.body.innerText), null, { timeout: 300_000 })
    .catch(() => {});
  await page.waitForTimeout(wait);
  for (const name of [/Willkommen bei Flowplan/i, /Welcome to Flowplan/i]) {
    if (await page.getByRole("dialog", { name }).count()) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    }
  }
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
}

// Pointer out of the way, nothing focused: ready for a screenshot.
export async function settle(page, ms = 800) {
  const v = page.viewportSize();
  await page.mouse.move(v.width - 1, v.height - 1);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await sleep(ms);
}

async function check(res, label) {
  const text = await res.text();
  if (!res.ok()) throw new Error(`${label} ${res.status()} ${text}`);
  return text ? JSON.parse(text) : null;
}
export async function cmd(page, body) {
  const res = await page.request.post(APP + "/api/command", {
    headers: { Origin: APP, "content-type": "application/json" },
    data: body,
    timeout: 300_000,
  });
  return check(res, body.action);
}
export async function post(page, path, data) {
  const res = await page.request.post(APP + "/api/" + path, {
    headers: { Origin: APP, "content-type": "application/json" },
    data,
    timeout: 300_000,
  });
  return check(res, path);
}
export async function get(page, path) {
  return check(await page.request.get(APP + "/api/" + path, { headers: { Origin: APP }, timeout: 300_000 }), path);
}

// ---------------------------------------------------------------- recording
// Headless video has no mouse pointer: draw one, with a ripple on clicks.
export const CURSOR = `(() => { const go = () => { if (document.getElementById('rec-cursor')) return;
  const st = document.createElement('style'); st.textContent = '#rec-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483646;pointer-events:none;transform:translate(-100px,-100px)} #rec-cursor svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))} .rec-ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(65,70,230,.28);z-index:2147483645;pointer-events:none;animation:rec-r .5s ease-out forwards}@keyframes rec-r{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}';
  document.head.append(st); const c = document.createElement('div'); c.id = 'rec-cursor';
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2.5 4 19.5 8.6 15.4 11.6 22 14.6 20.7 11.7 14.2 18 14.2Z" fill="#1d1c22" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.append(c);
  addEventListener('mousemove', (e) => (c.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)'), true);
  addEventListener('mousedown', (e) => { const r = document.createElement('div'); r.className = 'rec-ripple'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.body.append(r); setTimeout(() => r.remove(), 600); }, true); };
  if (document.body) go(); else addEventListener('DOMContentLoaded', go); })()`;

// Eased mouse movement, so recordings look like a person.
const pointers = new WeakMap();
export function pointerAt(page, x, y) {
  pointers.set(page, { x, y });
}
export async function glide(page, x, y, ms = 550) {
  const from = pointers.get(page) || { x: 1100, y: 700 };
  const start = Date.now();
  for (;;) {
    const k = Math.min(1, (Date.now() - start) / ms);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    if (k >= 1) break;
    await page.waitForTimeout(12);
  }
  pointers.set(page, { x, y });
}
export async function center(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not visible: " + locator);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
}
export async function clickOn(page, locator, ms = 550) {
  const c = await center(locator);
  await glide(page, c.x, c.y, ms);
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.mouse.up();
  return c;
}
// Types `text` spread over `ms`, independent of the machine's speed.
export async function typeText(page, text, ms) {
  const start = Date.now();
  let done = 0;
  while (done < text.length) {
    const want = Math.max(done + 1, Math.min(text.length, Math.ceil(((Date.now() - start) / ms) * text.length)));
    await page.keyboard.insertText(text.slice(done, want));
    done = want;
    await page.waitForTimeout(30);
  }
}

// Records `act` as CDP screencast frames with their timestamps and writes a
// 25 fps H.264 master to DIR/raw/<name>.mp4 (real time, whatever the speed
// of the machine while recording).
export async function record(page, name, act, { fps = 25 } = {}) {
  const raw = join(DIR, "raw");
  const dir = join(raw, `${name}-frames`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const v = page.viewportSize();
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, time: metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: v.width, maxHeight: v.height, everyNthFrame: 1 });
  const started = Date.now();
  // One change on screen, so the first frame arrives right away.
  await page.evaluate(() => (document.body.style.outline = "0 solid transparent"));
  await act();
  await page.waitForTimeout(400);
  const seconds = (Date.now() - started) / 1000;
  await cdp.send("Page.stopScreencast");
  await page.waitForTimeout(150);
  let list = "";
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].time : f.time + 0.5;
    list += `file '${f.file}'\nduration ${Math.max(0.001, next - f.time).toFixed(4)}\n`;
  });
  list += `file '${frames.at(-1).file}'\n`;
  writeFileSync(`${dir}.txt`, list);
  const out = join(raw, `${name}.mp4`);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${dir}.txt`,
    "-vf", `scale=${v.width}:${v.height}:flags=lanczos,fps=${fps},format=yuv420p`,
    "-t", seconds.toFixed(2), "-r", String(fps), "-c:v", "libx264", "-preset", "medium", "-crf", "10", out,
  ]);
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}.txt`, { force: true });
  console.log(`${name}: ${frames.length} frames, ${seconds.toFixed(1)} s`);
  return out;
}
