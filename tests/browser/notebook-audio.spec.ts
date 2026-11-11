import { test, expect, type CDPSession, type Page } from "@playwright/test";

// Audio recordings in notebooks (components/notebook/notebook-audio.tsx):
// Chromium's fake microphone records, a stroke written meanwhile carries the
// recording's moment, stopping uploads it, and playback dims what comes later.
// A file of its own: launch options start a new browser, which Playwright
// allows only for a whole file, not for a group inside notebook.spec.ts. They
// replace the config's, so they keep its choice of browser
// (PLAYWRIGHT_CHROMIUM_EXECUTABLE).
test.use({
  hasTouch: true,
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
  permissions: ["microphone"],
});

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
type Point = { x: number; y: number };

// Pen input from the browser itself (DevTools protocol), as in notebook.spec.ts.
async function pen(cdp: CDPSession, points: Point[]) {
  const base = { pointerType: "pen" as const, button: "left" as const, buttons: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: points[0].x, y: points[0].y, clickCount: 1, force: 0.3, ...base });
  for (const [i, p] of points.slice(1).entries())
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, force: 0.3 + (i % 6) * 0.1, ...base });
  const last = points[points.length - 1];
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, clickCount: 1, ...base });
}
const path = (from: Point, to: Point, steps = 14) =>
  Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps + Math.sin(i) * 5 }));

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const create = async (title: string, kind: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind })).id as string;
  return { boot, command, create };
}
const sheet = (page: Page, n: number) => page.locator(".notebook-sheet").nth(n);
async function openNotebook(page: Page, id: string, sheets = 1) {
  await page.goto(`/#page=${id}`);
  await expect(page.locator(".notebook-sheet")).toHaveCount(sheets, { timeout: 30_000 });
  return page.getByRole("toolbar", { name: "Schreibwerkzeuge" });
}

test("record while writing, upload, play back in step, jump to a stroke", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Pen input runs on the desktop project.");
  const { create } = await setup(page);
  const id = await create(`Vorlesung ${Date.now()}`, "notebook");
  await openNotebook(page, id);
  const controls = page.getByRole("toolbar", { name: "Notizbuch" });
  await controls.getByRole("button", { name: "Aufnahmen" }).click();
  await page.getByRole("menuitem", { name: "Aufnahme starten" }).click();
  const bar = page.getByRole("region", { name: "Aufnahme" });
  await expect(bar.getByRole("button", { name: "Aufnahme pausieren" })).toBeVisible();
  await page.waitForTimeout(2000);
  const cdp = await page.context().newCDPSession(page);
  const box = (await sheet(page, 0).boundingBox())!;
  await pen(cdp, path({ x: box.x + 90, y: box.y + 140 }, { x: box.x + 380, y: box.y + 180 }));
  await page.waitForTimeout(1500);
  await bar.getByRole("button", { name: "Beenden" }).click();
  await expect(page.getByText(/ist gespeichert/)).toBeVisible({ timeout: 20_000 });
  const list = await (await page.request.get(`/api/pages/${id}/recordings`)).json();
  expect(list.recordings).toHaveLength(1);
  const recording = list.recordings[0];
  expect(recording.durationMs).toBeGreaterThan(2500);
  const data = await (await page.request.get(`/api/pages/${id}`)).json();
  const [first] = data.notebook.sheets.map((s: { id: string }) => s.id);
  const stroke = data.notebook.sheets[0].ink.pages[first][0];
  expect(stroke.rec.id).toBe(recording.id);
  expect(stroke.rec.t).toBeGreaterThan(1500);
  // The audio is served with ranges.
  const ranged = await page.request.get(`/api/files/${recording.fileId}`, { headers: { range: "bytes=0-99" } });
  expect(ranged.status()).toBe(206);
  expect(ranged.headers()["content-type"]).toMatch(/^audio\//);
  // Playing from the start: the stroke is not "spoken" yet.
  await controls.getByRole("button", { name: "Aufnahmen" }).click();
  await page.locator(".notebook-audio-item").first().click();
  const player = page.locator(".notebook-audio-player");
  await player.getByRole("button", { name: "Pause" }).click().catch(() => {});
  await player.locator("input[type=range]").fill("0");
  await expect(sheet(page, 0).locator(".ink-unspoken")).toHaveCount(1);
  // "Play from here" on the stroke jumps to about when it was written.
  await player.getByRole("button", { name: /Ab hier abspielen/ }).click();
  // Measured again: the player's bar above the sheets moved them down.
  const now = (await sheet(page, 0).boundingBox())!;
  await page.mouse.click(now.x + 235, now.y + 160);
  await expect.poll(() => page.evaluate(() => (document.querySelector(".notebook-audio-player audio") as HTMLAudioElement).currentTime)).toBeGreaterThan(0.4);
});
