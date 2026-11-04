// README screenshots: document, database, whiteboard and phone, each in
// light and dark, as PNGs in MEDIA_DIR/shots (then optimise.sh copies them
// to .github/assets/readme/). Needs the content from seed.mjs.
//
//   MEDIA_URL=http://127.0.0.1:3583 node scripts/readme-media/screenshots.mjs [only]
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, context, open, DIR, sleep } from "./lib.mjs";

const ids = JSON.parse(readFileSync(join(DIR, "ids.json"), "utf8"));
const out = join(DIR, "shots");
mkdirSync(out, { recursive: true });
const only = process.argv[2];

const settle = async (page) => {
  await page.mouse.move(1279, 799);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await sleep(800);
};
const shots = {
  async document(page) {
    await open(page, ids.kickoff);
    await page.locator(".ProseMirror").first().waitFor();
    await sleep(2500);
  },
  async database(page) {
    await open(page, ids.db);
    await page.getByRole("tab", { name: "Board" }).or(page.getByText("Board", { exact: true })).first().click();
    await sleep(2500);
  },
  async whiteboard(page) {
    await open(page, ids.board);
    await sleep(3500);
    // Full screen, then "Show everything" (both may sit below the fold of
    // the toolbar, so click them through the DOM).
    await page.getByTitle("Full screen", { exact: true }).first().evaluate((b) => b.click());
    await sleep(1000);
    await page.getByTitle("Show everything (⇧1)").first().evaluate((b) => b.click());
    await sleep(800);
    // Make room for the toolbar on the left.
    await page.mouse.move(700, 450);
    await page.keyboard.press("Control+-");
    await sleep(500);
    await page.mouse.wheel(-40, 0);
    await sleep(1000);
  },
  async phone(page) {
    await open(page, ids.db);
    await sleep(2000);
    await page.getByText("Board", { exact: true }).first().click().catch(() => {});
    await sleep(2500);
  },
  async "phone-wiki"(page) {
    await open(page, ids.wiki);
    await page.locator(".ProseMirror").first().waitFor();
    await sleep(2500);
  },
};

const browser = await launch();
for (const [name, run] of Object.entries(shots)) {
  if (only && only !== name) continue;
  for (const scheme of ["light", "dark"]) {
    const phone = name.startsWith("phone");
    const ctx = await context(browser, {
      who: "mia",
      extra: phone
        ? { colorScheme: scheme, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
        : { colorScheme: scheme, deviceScaleFactor: 1.5 },
    });
    // The renderer can crash on a busy machine: try up to three times.
    for (let attempt = 1; ; attempt++) {
      const page = await ctx.newPage();
      try {
        await run(page);
        await settle(page);
        await page.screenshot({ path: join(out, `${name}-${scheme}.png`) });
        console.log(name, scheme);
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        console.log(name, scheme, "retry", e.message.split("\n")[0]);
      } finally {
        await page.close().catch(() => {});
      }
    }
    await ctx.close();
  }
}
await browser.close();
