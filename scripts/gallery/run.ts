// The UI gallery: every page, dialog, menu and popover of the app as
// screenshots on one local HTML page, to spot quickly where something does
// not fit. Development only – nothing of it is served by the app.
//
//   npm run gallery                         all scenes, desktop and phone, light and dark
//   npm run gallery -- --only dialogs       scenes whose id, title or group contains "dialogs"
//   npm run gallery -- --phone --dark       one variant
//   npm run gallery -- --url http://127.0.0.1:3000   a running (dev) server instead
//
// See CONTRIBUTING.md ("UI gallery") for all flags.
import { request, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-ignore – plain JavaScript modules
import { hasBuild, startProductionServer } from "../production-server.mjs";
// @ts-ignore
import { launchChromium } from "../chromium.mjs";
import { FIXED_TIME } from "../../tests/visual/shared";
import { SCENES } from "./scenes";
import { commandFor, seedGallery } from "./seed";
import { writeReport, type Shot } from "./report";
import type { Device, Ids, Scene, SceneContext, Theme, Variant } from "./types";

const root = process.cwd();

type Options = {
  only: string[];
  devices: Device[];
  themes: Theme[];
  concurrency: number;
  out: string;
  url?: string;
  build: boolean;
  open: boolean;
  list: boolean;
  serve: boolean;
  session?: string;
};

function parseArgs(argv: string[]): Options {
  const o: Options = { only: [], devices: [], themes: [], concurrency: 4, out: "gallery-out", build: false, open: false, list: false, serve: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--only") o.only.push(...value().split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    else if (a === "--desktop" || a === "--phone") o.devices.push(a.slice(2) as Device);
    else if (a === "--light" || a === "--dark") o.themes.push(a.slice(2) as Theme);
    else if (a === "--concurrency" || a === "-j") o.concurrency = Math.max(1, Number(value()) || 1);
    else if (a === "--out") o.out = value();
    else if (a === "--url" || a === "--dev") o.url = value().replace(/\/$/, "");
    else if (a === "--build") o.build = true;
    else if (a === "--open") o.open = true;
    else if (a === "--list") o.list = true;
    else if (a === "--serve") o.serve = true;
    else if (a === "--session") o.session = value();
    else if (a === "--help" || a === "-h") {
      console.log(HELP);
      process.exit(0);
    } else throw new Error(`Unknown option ${a} (see --help)`);
  }
  if (!o.devices.length) o.devices = ["desktop", "phone"];
  if (!o.themes.length) o.themes = ["light", "dark"];
  return o;
}

const HELP = `npm run gallery -- [options]

  --only <text>       only scenes whose id, title or group contains <text> (repeatable, comma-separated)
  --desktop, --phone  only these devices (default both)
  --light, --dark     only these themes (default both)
  --concurrency <n>   scenes in parallel (default 4)
  --out <dir>         output directory (default gallery-out/)
  --url <origin>      use a running server (e.g. npm run dev) instead of the production build;
                      signs up a new account there (sign-up must be open; admin scenes need an admin)
  --dev <origin>      same as --url
  --build             run \`npm run build\` first even if a build exists
  --open              open the gallery in the browser when done
  --list              list the scenes and exit
  --serve             only start the server and seed it, write <out>/session.json and wait (Ctrl-C ends it)
  --session <file>    reuse such a session: no server start, no seeding – quick runs while writing a scene`;

export const VARIANTS: Variant[] = [
  { id: "desktop-light", device: "desktop", theme: "light" },
  { id: "desktop-dark", device: "desktop", theme: "dark" },
  { id: "phone-light", device: "phone", theme: "light" },
  { id: "phone-dark", device: "phone", theme: "dark" },
];

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
// iPhone 15-sized.
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

type Session = { origin: string; ids: Ids; storageState: Awaited<ReturnType<BrowserContext["storageState"]>> };

const SCENE_TIMEOUT = 45_000;

function matches(scene: Scene, only: string[]) {
  if (!only.length) return true;
  const hay = `${scene.id} ${scene.title} ${scene.group}`.toLowerCase();
  return only.some((o) => hay.includes(o));
}

function git(args: string[]) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

async function ensureBuild(force: boolean) {
  if (hasBuild() && !force) {
    // A hint when the build is older than the last commit.
    const built = statSync(join(root, ".next/standalone/server.js")).mtimeMs;
    const committed = Number(git(["log", "-1", "--format=%ct"])) * 1000;
    if (committed && built < committed)
      console.log("Note: the production build is older than the last commit – pass --build to rebuild it.");
    return;
  }
  console.log("Building the app (npm run build) – once; later runs reuse .next/ …");
  const code = await new Promise<number>((done) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: root, stdio: "inherit" });
    child.on("exit", (c) => done(c ?? 1));
  });
  if (code !== 0) throw new Error("npm run build failed");
}

function shortError(error: unknown) {
  const text = String((error as Error)?.message || error)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim();
  const lines = text.split("\n").filter((l) => l.trim());
  // Playwright's first line plus the locator it waited for.
  const locator = lines.find((l) => /waiting for|locator\(|getBy/.test(l) && l !== lines[0]);
  return [lines[0], locator?.trim()].filter(Boolean).join(" — ").slice(0, 500);
}

// Until nothing loads any more (documents keep a live connection open, so
// "idle" may never come: at most a moment), the web fonts are there and
// layout has been painted.
async function settlePage(page: Page, idle = 2500) {
  if (idle) await page.waitForLoadState("networkidle", { timeout: idle }).catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page
    .evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    .catch(() => {});
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenes = SCENES.filter((s) => matches(s, options.only));
  const variants = VARIANTS.filter((v) => options.devices.includes(v.device) && options.themes.includes(v.theme));
  if (options.list) {
    for (const s of scenes) console.log(`${s.group.padEnd(20)} ${s.id.padEnd(36)} ${s.title}`);
    console.log(`${scenes.length} scenes`);
    return;
  }
  if (!scenes.length) throw new Error(`No scene matches ${options.only.join(", ")} (see --list)`);
  const started = Date.now();
  const out = resolve(root, options.out);
  const shotsDir = join(out, "shots");
  if (!options.serve) {
    rmSync(shotsDir, { recursive: true, force: true });
    mkdirSync(shotsDir, { recursive: true });
  }
  const session: Session | null = options.session ? JSON.parse(readFileSync(options.session, "utf8")) : null;

  let server: { origin: string; stop: () => Promise<void> } | null = null;
  let origin = session?.origin || options.url;
  if (!origin) {
    await ensureBuild(options.build);
    console.log("Starting the production server with an empty data directory …");
    server = await startProductionServer();
    origin = server!.origin;
  }
  let browser: Browser | null = null;
  const stopAll = async () => {
    await browser?.close().catch(() => {});
    await server?.stop().catch(() => {});
  };
  if (!options.serve) process.once("SIGINT", () => void stopAll().then(() => process.exit(130)));
  try {
    const api = await request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" },
      ...(session ? { storageState: session.storageState } : {}),
    });
    if (!session) console.log(`Seeding the gallery account on ${origin} …`);
    const ids: Ids = session ? session.ids : await seedGallery(api, origin!, { fresh: !options.url });
    const storageState = await api.storageState();
    if (options.serve) {
      mkdirSync(out, { recursive: true });
      const file = join(out, "session.json");
      writeFileSync(file, JSON.stringify({ origin, ids, storageState } satisfies Session));
      console.log(`Serving ${origin}. Run scenes against it with --session ${file}; Ctrl-C ends the server.`);
      await new Promise<void>((done) => {
        process.once("SIGTERM", done);
        process.once("SIGINT", done);
      });
      return;
    }
    const command = commandFor(api, origin!);
    let htmlState: ((html: string) => Uint8Array) | null = null;
    const fixture: SceneContext["fixture"] = async ({ title = "Entwurf", kind = "document", html } = {}) => {
      const { id } = await command({ action: "page.create", workspaceId: ids.workspaceId, spaceId: ids.spaceId, parentId: ids.sandboxId, kind, title });
      if (html) {
        htmlState ??= (await import("../../lib/document-server")).htmlState;
        const { generation } = await (await api.get(`/api/pages/${id}`)).json();
        await command({ action: "document.sync", pageId: id, generation, update: Buffer.from(htmlState!(html)).toString("base64") });
      }
      return id;
    };

    // A German browser, not only German pages: Playwright's `locale` sets
    // navigator.language and Accept-Language, but Chromium draws native
    // fields (the "tt.mm.jjjj" of <input type="date">) in the language of
    // the browser itself, which on Linux comes from the process locale.
    const launched = await launchChromium({ env: { ...process.env, LANG: "de_DE.UTF-8", LANGUAGE: "de", LC_ALL: "de_DE.UTF-8" } });
    if (!launched.browser) throw new Error(`No Chromium starts: ${launched.error}. Run \`npx playwright install chromium\`.`);
    browser = launched.browser as Browser;

    const jobs: { scene: Scene; variant: Variant }[] = [];
    for (const scene of scenes)
      for (const variant of variants) if (!scene.devices || scene.devices.includes(variant.device)) jobs.push({ scene, variant });
    console.log(`${scenes.length} scenes × variants = ${jobs.length} screenshots, ${options.concurrency} at a time`);

    const shots: Shot[] = [];
    let done = 0;
    const runJob = async ({ scene, variant }: (typeof jobs)[number]) => {
      const t0 = Date.now();
      const phone = variant.device === "phone";
      const context: BrowserContext = await browser!.newContext({
        ...(phone ? PHONE : DESKTOP),
        ...(scene.viewport ? { viewport: scene.viewport } : {}),
        colorScheme: variant.theme,
        reducedMotion: "reduce",
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
        extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" },
        storageState: scene.signedOut ? { cookies: [], origins: [] } : storageState,
      });
      context.setDefaultTimeout(10_000);
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.message.split("\n")[0]));
      const ctx: SceneContext = {
        origin: origin!,
        ids,
        variant,
        phone,
        command,
        api,
        fixture,
        settle: () => settlePage(page),
        open: async (path: string) => {
          if (!scene.realTime) await page.clock.setFixedTime(FIXED_TIME);
          await page.goto(path.startsWith("#") ? `${origin}/${path}` : `${origin}${path}`);
          if (path.startsWith("#")) await page.locator(".sidebar").first().waitFor({ state: "attached" });
          await settlePage(page);
        },
      };
      const file = `${scene.id}--${variant.id}.png`;
      let error: string | undefined;
      try {
        await Promise.race([
          (async () => {
            if (scene.path) await ctx.open(typeof scene.path === "function" ? scene.path(ctx) : scene.path);
            else if (!scene.realTime) await page.clock.setFixedTime(FIXED_TIME);
            await scene.steps?.(page, ctx);
            // Popovers place themselves a frame after they open.
            await settlePage(page, scene.steps ? 1000 : 0);
            await page.waitForTimeout(200);
          })(),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`Scene timed out after ${SCENE_TIMEOUT / 1000}s`)), SCENE_TIMEOUT)),
        ]);
      } catch (e) {
        error = shortError(e);
      }
      try {
        await page.screenshot({ path: join(shotsDir, file), animations: "disabled", caret: "hide", fullPage: !!scene.fullPage, timeout: 15_000 });
      } catch (e) {
        error ??= `Screenshot failed: ${shortError(e)}`;
      }
      await context.close().catch(() => {});
      const shot: Shot = {
        scene: scene.id,
        group: scene.group,
        title: scene.title,
        path: typeof scene.path === "function" ? scene.path(ctx) : scene.path || "",
        variant: variant.id,
        file: existsSync(join(shotsDir, file)) ? `shots/${file}` : "",
        error,
        pageErrors: [...new Set(pageErrors)].slice(0, 5),
        ms: Date.now() - t0,
      };
      shots.push(shot);
      done++;
      const mark = error ? "✗" : "✓";
      console.log(`${mark} [${done}/${jobs.length}] ${scene.id} (${variant.id}) ${((Date.now() - t0) / 1000).toFixed(1)}s${error ? ` – ${error}` : ""}`);
    };
    const queue = [...jobs];
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, queue.length) }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) await runJob(job);
      }),
    );
    await api.dispose();

    const order = new Map(jobs.map((j, i) => [`${j.scene.id}--${j.variant.id}`, i]));
    shots.sort((a, b) => order.get(`${a.scene}--${a.variant}`)! - order.get(`${b.scene}--${b.variant}`)!);
    const seconds = Math.round((Date.now() - started) / 1000);
    const commit = git(["rev-parse", "--short", "HEAD"]);
    const dirty = git(["status", "--porcelain"]) ? "+changes" : "";
    const index = writeReport(out, {
      shots,
      variants: variants.map((v) => v.id),
      generated: new Date().toISOString(),
      commit: commit ? `${commit}${dirty}` : "unknown",
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
      seconds,
      server: options.url ? `running server ${options.url}` : session ? `session ${origin}` : "production build",
    });
    writeFileSync(join(out, "results.json"), JSON.stringify({ seconds, shots }, null, 2));
    const failed = shots.filter((s) => s.error);
    console.log(`\n${shots.length} screenshots of ${scenes.length} scenes in ${seconds}s, ${failed.length} failed.`);
    console.log(`Gallery: ${index}`);
    if (options.open) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      spawn(opener, [index], { detached: true, stdio: "ignore" }).unref();
    }
  } finally {
    await stopAll();
  }
}

// Exit at once: modules the fixtures load (happy-dom for documents) may keep
// timers running.
main().then(() => process.exit(0), (error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
