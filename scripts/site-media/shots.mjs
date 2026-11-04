// Screenshots for the docs and the website, as PNGs in MEDIA_DIR/shots
// (publish.mjs then writes them as WebP into the two repositories). Needs
// the content from seed.mjs and ai-mock.mjs running.
//
//   MEDIA_URL=http://127.0.0.1:3641 node scripts/site-media/shots.mjs [name …]
//
// Sizes follow the files they replace: website screenshots 1600×1000
// (1280×800 at 1.25) or 2160×1350 (1440×900 at 1.5), phones 780×1688
// (390×844 at 2); the docs' figures as listed below.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, context, open, settle, ids, sleep, DIR } from "./lib.mjs";

const I = ids();
const out = join(DIR, "shots");
mkdirSync(out, { recursive: true });
const only = process.argv.slice(2);
const pageOf = (who, re) => I[who].pages.find((p) => re.test(p.title))?.id;

const WIDE = { viewport: { width: 1280, height: 800 }, scale: 1.25 };
const BIG = { viewport: { width: 1440, height: 900 }, scale: 1.5 };
const PHONE = { viewport: { width: 390, height: 844 }, scale: 2, extra: { isMobile: true, hasTouch: true } };

const main = (page) => page.locator("main");
async function view(page, name) {
  const tab = main(page).getByRole("button", { name, exact: true }).or(main(page).getByRole("tab", { name, exact: true })).first();
  await tab.click();
  await sleep(2000);
}
async function hideSidebar(page) {
  await page.locator(".sidebar-hide").first().click();
  await sleep(1200);
}
// The notebook one zoom step smaller (75 %), so the whole first sheet with
// the ramp drawing shows.
async function notebookView(page) {
  await hideSidebar(page);
  await page.getByRole("button", { name: /^(Zoom out|Verkleinern)$/ }).first().click();
  await sleep(1500);
}
async function askAi(page, question) {
  await page.getByRole("button", { name: /^(Ask AI|KI fragen)$/ }).first().click();
  await sleep(1500);
  const input = page.getByPlaceholder(/What would you like to know|Was möchtest du wissen/).first();
  await input.click();
  await input.fill(question);
  await page.keyboard.press("Enter");
  // The answer streams; it is done when "Stop" turns back into "Ask".
  await page.getByRole("button", { name: /^(Stop|Stopp)$/ }).waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
  await page.getByRole("button", { name: /^(Stop|Stopp)$/ }).waitFor({ state: "hidden", timeout: 300_000 });
  await sleep(1500);
  // Question, answer and sources from the top.
  await page.evaluate(() => {
    const log = document.querySelector(".ai-ask-log");
    if (log) log.scrollTop = 0;
  });
  await sleep(500);
}
async function openPdf(page) {
  await page.getByRole("button", { name: /^(Open PDF|PDF .* öffnen)/ }).first().click();
  await sleep(4000);
  // One step smaller, so the whole first page shows.
  await page.getByRole("button", { name: /^(Zoom out|Verkleinern)$/ }).first().click().catch(() => {});
  await sleep(1500);
  await page.getByRole("button", { name: /^(Annotate|Anmerken)$/ }).first().click();
  await sleep(2500);
}

// name → who, size, what to do, and an optional clip (CSS px).
const SHOTS = {
  "hero-light": { who: "mia", ...WIDE, go: `page=${I.plan}` },
  "hero-dark": { who: "mia", ...WIDE, dark: true, go: `page=${I.plan}` },
  "ai-ask": { who: "mia", ...WIDE, go: `page=${I.plan}`, run: (p) => askAi(p, "When is the launch, and what does it depend on?") },
  calendar: { who: "alex", ...BIG, go: `page=${pageOf("alex", /^Projects$/)}`, run: (p) => view(p, "Calendar") },
  whiteboard: { who: "alex", ...BIG, go: `page=${pageOf("alex", /^Whiteboard/)}` },
  journal: { who: "alex", ...BIG, go: `page=${pageOf("alex", /^Journal$/)}` },
  "notebook-ipad-light": { who: "mia", ...BIG, go: `page=${I.notebook}`, run: notebookView },
  "pdf-annotate": { who: "mia", ...BIG, go: `page=${I.reading}`, run: openPdf },
  "home-customize": { who: "mia", ...BIG, go: "", run: (p) => p.getByRole("button", { name: "Customize" }).click().then(() => sleep(1500)) },
  "mobile-board": { who: "alex", ...PHONE, go: `page=${pageOf("alex", /^Projects$/)}`, run: (p) => view(p, "Board") },
  "mobile-journal": { who: "alex", ...PHONE, go: `page=${pageOf("alex", /^Journal$/)}` },
  // The docs.
  "docs-notebook": { who: "mia", viewport: { width: 1440, height: 964 }, scale: 1.5, go: `page=${I.notebook}`, run: notebookView },
  "docs-home-customize": { who: "mia", viewport: { width: 1440, height: 1060 }, scale: 1.5, go: "", run: (p) => p.getByRole("button", { name: "Customize" }).click().then(() => sleep(1500)) },
  "docs-draw-block": {
    who: "mia",
    viewport: { width: 1280, height: 900 },
    scale: 2,
    go: `page=${I.flow}`,
    run: async (p) => {
      // Wait for the ink, then open the block's toolbar ("Draw").
      await sleep(3000);
      await p.getByRole("button", { name: /^(Draw|Zeichnen)$/ }).first().click();
      await sleep(3500);
    },
    clip: async (p) => {
      const t = await p.locator(".ink-toolbar").first().boundingBox();
      const b = await p.locator(".ProseMirror").first().boundingBox();
      return { x: b.x - 30, y: t.y - 4, width: 760, height: 575 };
    },
  },
  "docs-code-preview": {
    who: "mia",
    viewport: { width: 1280, height: 900 },
    scale: 2,
    go: `page=${I.pipeline}`,
    // Mermaid draws the diagram after a moment.
    run: (p) => p.waitForFunction(() => !/Loading preview|Vorschau wird geladen/.test(document.querySelector("main")?.innerText || ""), null, { timeout: 180_000 }).then(() => sleep(8000)),
    clip: async (p) => {
      const b = await p.locator(".ProseMirror").first().boundingBox();
      return { x: b.x - 30, y: b.y - 10, width: 760, height: 440 };
    },
  },
};

const browser = await launch();
for (const [name, s] of Object.entries(SHOTS)) {
  if (only.length && !only.includes(name)) continue;
  const ctx = await context(browser, { who: s.who, dark: s.dark, viewport: s.viewport, scale: s.scale, extra: s.extra });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120_000);
  try {
    await open(page, s.go, 3500);
    if (s.run) await s.run(page);
    await settle(page);
    const clip = s.clip ? await s.clip(page) : undefined;
    await page.screenshot({ path: join(out, `${name}.png`), clip });
    console.log(name);
  } catch (e) {
    console.error(name, e.message.split("\n")[0]);
    await page.screenshot({ path: join(out, `${name}-failed.png`) }).catch(() => {});
  }
  await ctx.close();
}
await browser.close();
