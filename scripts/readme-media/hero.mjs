// Records the README hero (light mode, 1280×800): Mia writes in the
// kickoff page with the slash menu (a heading and a checklist) while Jonas
// edits along in a second browser; she switches the roadmap from table to
// board to calendar and ends on the whiteboard, where Jonas's cursor moves
// and a shape is dragged with its connectors following.
//
//   MEDIA_URL=http://127.0.0.1:3583 node scripts/readme-media/hero.mjs
//
// Writes MEDIA_DIR/video/hero.webm and hero.json (start and end in seconds);
// make-hero.sh turns that into .github/assets/readme/hero.gif. It edits the
// seeded content, so take the screenshots first.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, context, open, cmd, DIR, sleep, move, moveTo, typeSlowly, CURSOR_SCRIPT } from "./lib.mjs";

const ids = JSON.parse(readFileSync(join(DIR, "ids.json"), "utf8"));
const videoDir = join(DIR, "video");
mkdirSync(videoDir, { recursive: true });
const browser = await launch();

// Start from the seeded kickoff page, also after an earlier attempt.
{
  const c = await context(browser, { who: "mia" });
  const p = await c.newPage();
  await cmd(p, { action: "snapshot.restore", pageId: ids.kickoff, snapshotId: ids.kickoffSnapshot });
  await c.close();
}

// Jonas, the second person, without a recording. He first opens every
// view once, so the dev server has compiled them before the recording.
const jctx = await context(browser, { who: "jonas" });
const jonas = await jctx.newPage();
await open(jonas, ids.db);
for (const view of ["Board", "Calendar", "Table"]) {
  await jonas.getByText(view, { exact: true }).first().click();
  await sleep(2500);
}
await open(jonas, ids.board);
await jonas.getByText("File area", { exact: true }).first().waitFor();
await open(jonas, ids.kickoff);
await jonas.locator(".ProseMirror").first().waitFor();
await sleep(1500);

const mctx = await context(browser, {
  who: "mia",
  extra: { colorScheme: "light", recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } },
});
await mctx.addInitScript(CURSOR_SCRIPT);
const mia = await mctx.newPage();
const t0 = Date.now();
await open(mia, ids.kickoff);
await mia.locator(".ProseMirror").first().waitFor().catch(async (e) => { await mia.screenshot({ path: join(DIR, "hero-failed.png") }); throw e; });
await sleep(2500);
const lastQuestion = mia.locator(".ProseMirror li").filter({ hasText: "How long do we keep files" }).first();
await lastQuestion.evaluate((el) => el.scrollIntoView({ block: "center" }));
await jonas.locator(".ProseMirror li").filter({ hasText: "Do clients need to comment" }).first().click();
await jonas.keyboard.press("End");
await mia.mouse.move(900, 640);
await sleep(1500);

// Pieces of the video to keep: waiting for pages to load is cut out.
const now = () => (Date.now() - t0) / 1000;
const segments = [];
let open_ = now();
// target: seconds the piece should last in the GIF (a busy machine records
// in slow motion; make-hero.mjs speeds it up to fit).
const cut = (target) => segments.push(target ? [open_, now(), target] : [open_, now()]);
const resume = () => { open_ = now(); };
const slash = async (command) => {
  await typeSlowly(mia, command, 90);
  await mia.locator("[role=option]").first().waitFor({ timeout: 20_000 }).catch(async (e) => {
    await mia.screenshot({ path: join(DIR, "hero-failed.png") });
    throw e;
  });
  await sleep(350);
  await mia.keyboard.press("Enter");
};

// ---- Scene 1: writing, with a colleague in the same page ------------------
const box = await moveTo(mia, lastQuestion, 650, 0.98, 0.5);
await mia.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
await mia.keyboard.press("End");
await sleep(250);
const jonasTurn = Promise.withResolvers();
await Promise.all([
  (async () => {
    await mia.keyboard.press("Enter");
    await mia.keyboard.press("Enter");
    await slash("/h2");
    await typeSlowly(mia, "Next steps", 45);
    await mia.keyboard.press("Enter");
    await slash("/todo");
    jonasTurn.resolve();
    await typeSlowly(mia, "Share the prototype with pilots", 38);
    await mia.keyboard.press("Enter");
    await typeSlowly(mia, "Book user tests", 40);
  })(),
  (async () => {
    await jonasTurn.promise;
    await typeSlowly(jonas, " Ask the pilots.", 70);
  })(),
]);
await sleep(700);

// ---- Scene 2: one database, three views ----------------------------------
const jonasToBoard = open(jonas, ids.board); // Jonas moves on meanwhile.
await moveTo(mia, mia.getByText("Atlas roadmap", { exact: true }).first(), 650);
await mia.mouse.down();
await mia.mouse.up();
cut(6.5);
await mia.getByText("Data model and API draft").first().waitFor();
// The view tabs at the top (the page may keep the previous scroll position).
await mia.getByText("Calendar", { exact: true }).first().scrollIntoViewIfNeeded();
await mia.evaluate(() => document.querySelectorAll("*").forEach((el) => { if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) el.scrollTop = 0; }));
await sleep(600);
resume();
await sleep(900);
for (const [view, ready] of [["Board", ".board-column"], ["Calendar", null]]) {
  await moveTo(mia, mia.getByText(view, { exact: true }).first(), 550);
  await mia.mouse.down();
  await mia.mouse.up();
  cut(1.3);
  if (ready) await mia.locator(ready).first().waitFor().catch(() => {});
  else await mia.locator(".board-column").first().waitFor({ state: "detached" }).catch(() => {});
  await sleep(1200);
  resume();
  await sleep(1300);
}

// ---- Scene 3: the whiteboard, together -----------------------------------
const jonasCursor = (async () => {
  await jonasToBoard;
  await sleep(600);
  for (const [x, y] of [[620, 560], [700, 600], [760, 540], [690, 520], [640, 590], [720, 640]]) {
    await move(jonas, x, y, 450);
    await sleep(120);
  }
})();
await moveTo(mia, mia.getByText("Atlas brainstorm", { exact: true }).first(), 600);
await mia.mouse.down();
await mia.mouse.up();
cut(2);
await mia.getByText("File area", { exact: true }).first().waitFor();
await sleep(500);
resume();
await sleep(800);
const shape = await moveTo(mia, mia.getByText("File area", { exact: true }).first(), 600);
await mia.mouse.down();
await sleep(120);
const [dx, dy] = [25, 55];
await move(mia, shape.x + shape.width / 2 + dx, shape.y + shape.height / 2 + dy, 800);
await mia.mouse.up();
await sleep(400);
await mia.mouse.click(1180, 760);
await jonasCursor;
await sleep(800);
cut(4.5);
// Put the shape back for the next run (not in the video).
await mia.mouse.move(shape.x + shape.width / 2 + dx, shape.y + shape.height / 2 + dy);
await mia.mouse.down();
await move(mia, shape.x + shape.width / 2, shape.y + shape.height / 2, 300);
await mia.mouse.up();
await sleep(1500);

const video = mia.video();
await mctx.close();
renameSync(await video.path(), join(videoDir, "hero.webm"));
writeFileSync(join(videoDir, "hero.json"), JSON.stringify(segments));
console.log(segments, "length", segments.reduce((n, [a, b]) => n + b - a, 0).toFixed(1), "s");
await jctx.close();
await browser.close();
