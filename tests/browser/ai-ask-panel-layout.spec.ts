import { test, expect, type Page, type Locator } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

// The page beside "KI fragen" (#59, components/ai-ask.tsx, lib/ask-panel.ts):
// the page lays out for the room it has left (container queries on the
// main area, app/globals.css), not for the window. On a 1000 px window the
// panel lies over the page until it is pinned ("Anheften"); pinned it docks
// and the page takes its narrow layout without sideways scrolling, the
// table of contents gives way to a button with a popover, the
// administration keeps its header, cards and status line in order. The
// panel's width follows the keyboard at its handle, within 45 % of the
// window, and is kept per device like the pin.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.ASK_PANEL_SCREENSHOTS || "";
test.setTimeout(180_000);

// An OpenAI-compatible provider that answers briefly (the panel only needs
// a usable AI to be offered).
async function startMock() {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const section = (n: number) =>
  `<h2>Abschnitt ${n}: Planung und Ablauf</h2><p>${"Der Betriebsausflug findet am 12. Juni in Hamburg statt. Treffpunkt ist der Hauptbahnhof um 9 Uhr. ".repeat(3)}</p>`;

async function setup(page: Page, tag: string) {
  const mock = await startMock();
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data: { workspaceId: boot.workspace.id, ...data } });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  await command({ action: "profile.onboarded" });
  await command({ action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: mock.base, model: "mock-model", embeddingModel: "" } } });
  await command({ action: "ai.settings", enabled: true });
  const doc = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: `Ausflug ${tag}`, kind: "document" });
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  d.prepare("UPDATE documents SET html=?,state=NULL,generation=? WHERE page_id=?").run(`<p>Einleitung.</p>${[1, 2, 3, 4, 5, 6].map(section).join("")}`, randomUUID(), doc.id);
  d.close();
  // A fresh device: default width, not pinned, the table of contents open.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("layout-test")) return;
    sessionStorage.setItem("layout-test", "1");
    localStorage.removeItem("flowplan-ask-width");
    localStorage.removeItem("flowplan-ask-pinned");
    localStorage.setItem("flowplan.outline", "1");
  });
  return { mock, doc };
}

// Nothing in the main area scrolls sideways, nor the window.
async function expectNoSidewaysScroll(page: Page) {
  const sizes = await page.evaluate(() => {
    const scroll = document.querySelector(".main-scroll")!;
    return { scroll: scroll.scrollWidth - scroll.clientWidth, root: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(sizes).toEqual({ scroll: 0, root: 0 });
}

const box = async (l: Locator) => (await l.boundingBox())!;
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

async function openPanel(page: Page) {
  await page.locator(".main-nav").getByRole("button", { name: "KI fragen" }).click();
  const panel = page.getByRole("complementary", { name: "KI fragen" });
  await expect(panel).toBeVisible();
  await panel.getByLabel("Deine Frage").blur();
  return panel;
}

test("Ask AI beside the page: the layout follows the room that is left", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  test.skip(info.project.name === "mobile", "Desktop windows; phones keep the bottom sheet (ai-ask-panel.spec.ts)");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { mock, doc } = await setup(page, `${Date.now()}`);
  try {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(`/#page=${doc.id}`);
    const editor = page.locator(".page-content .ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 60_000 });
    const shell = page.locator(".app-shell");
    const main = page.locator("main.main");
    const mainBefore = await box(main);

    // A narrow window: over the page, which keeps its width.
    const panel = await openPanel(page);
    await expect(shell).toHaveClass(/ask-overlay/);
    await expect(shell).not.toHaveClass(/ask-open/);
    expect((await box(main)).width).toBeCloseTo(mainBefore.width, 0);
    const over = await box(panel);
    expect(over.x + over.width).toBeGreaterThan(998);
    expect(over.width).toBe(420);
    expect(await panel.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
    expect(await panel.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    await expectNoSidewaysScroll(page);
    if (shots) await page.screenshot({ path: `${shots}/layout-overlay.png` });

    // "Anheften": docked beside the page, the page narrows (and the sidebar
    // makes room).
    const pin = panel.getByRole("button", { name: "Anheften" });
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect(shell).toHaveClass(/ask-open/);
    expect(await page.evaluate(() => localStorage.getItem("flowplan-ask-pinned"))).toBe("1");
    await expect.poll(async () => (await box(main)).width).toBeLessThan(600);
    const docked = await box(panel);
    const mainBox = await box(main);
    expect(mainBox.x + mainBox.width).toBeLessThanOrEqual(docked.x + 1);
    await expectNoSidewaysScroll(page);

    // The table of contents gives way: a button at the text's edge, the
    // list (open before) as a popover only on demand.
    const toggle = page.locator(".outline-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".document-outline")).toHaveCount(0);
    await expect(page.locator(".editor-wrapper")).not.toHaveClass(/with-outline/);
    await toggle.click();
    const outline = page.locator(".document-outline.outline-popover");
    await expect(outline).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(outline.locator("li > button:first-child")).toHaveCount(6);
    await expect(outline.locator('button[aria-current="location"]')).toHaveCount(1);
    await expect(outline.locator('button[aria-current="location"]')).toBeFocused();
    const list = await box(outline);
    const button = await box(toggle);
    expect(list.y).toBeGreaterThan(button.y + button.height - 1);
    expect(list.x + list.width).toBeLessThanOrEqual(docked.x);
    expect(list.x).toBeGreaterThanOrEqual(mainBox.x);
    if (shots) await page.screenshot({ path: `${shots}/layout-pinned-toc.png` });
    await page.keyboard.press("Escape");
    await expect(outline).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(panel).toBeVisible();
    // A heading jumps there and closes it; so does a click elsewhere.
    await toggle.click();
    await outline.getByRole("button", { name: "Abschnitt 4: Planung und Ablauf", exact: true }).click();
    await expect(outline).toHaveCount(0);
    await toggle.click();
    await expect(outline).toBeVisible();
    await page.mouse.click(mainBox.x + 40, mainBox.y + mainBox.height - 40);
    await expect(outline).toHaveCount(0);

    // The width by keyboard at the handle: 420 px, at most 45 % of the
    // window (450 px here), kept per device; Home goes back.
    const handle = panel.getByRole("separator", { name: /Breite/ });
    await expect(handle).toHaveAttribute("aria-valuenow", "420");
    await expect(handle).toHaveAttribute("aria-valuemin", "320");
    await expect(handle).toHaveAttribute("aria-valuemax", "450");
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(handle).toHaveAttribute("aria-valuenow", "436");
    await expect.poll(async () => (await box(panel)).width).toBe(436);
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(handle).toHaveAttribute("aria-valuenow", "450");
    await expect.poll(async () => (await box(panel)).width).toBe(450);
    expect(await page.evaluate(() => localStorage.getItem("flowplan-ask-width"))).toBe("450");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "418");
    await page.keyboard.press("Home");
    await expect(handle).toHaveAttribute("aria-valuenow", "420");
    expect(await page.evaluate(() => localStorage.getItem("flowplan-ask-width"))).toBeNull();
    await expectNoSidewaysScroll(page);

    // The administration beside the docked panel (the pin is remembered).
    await page.goto("/#admin/users");
    await page.reload();
    await expect(page.locator(".settings-shell")).toBeVisible({ timeout: 60_000 });
    await openPanel(page);
    await expect(shell).toHaveClass(/ask-open/);
    await expect(page.locator(".admin-user-table")).toBeVisible();
    await expectNoSidewaysScroll(page);
    // The header's text keeps a readable width (not a word per line).
    const intro = await box(page.locator(".settings-detail-head p").first());
    expect(intro.width).toBeGreaterThan(250);
    // The section list does not float over the content.
    await expect(page.locator(".settings-rail")).toBeHidden();
    // "Registrierung einstellen" below the status text, not over it.
    const fix = page.locator(".admin-status").getByRole("link", { name: "Registrierung einstellen" });
    await expect(fix).toBeVisible();
    expect(overlaps(await box(fix), await box(page.locator(".admin-status > p").first()))).toBe(false);
    if (shots) await page.screenshot({ path: `${shots}/layout-admin-pinned.png` });
    // Unpinned: over the page again.
    await panel.getByRole("button", { name: "Anheften" }).click();
    await expect(shell).toHaveClass(/ask-overlay/);
    expect(await page.evaluate(() => localStorage.getItem("flowplan-ask-pinned"))).toBeNull();
    await expectNoSidewaysScroll(page);

    // A wide window: always docked, no pin; the table of contents fits
    // beside the text and covers neither the text nor the toolbar.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/#page=${doc.id}`);
    await page.reload();
    await expect(editor).toBeVisible({ timeout: 60_000 });
    await openPanel(page);
    await expect(shell).toHaveClass(/ask-open/);
    await expect(panel.getByRole("button", { name: "Anheften" })).toHaveCount(0);
    const side = page.locator(".document-outline");
    await expect(side).toBeVisible();
    await expect(side).not.toHaveClass(/outline-popover/);
    const sideBox = await box(side);
    expect(overlaps(sideBox, await box(editor))).toBe(false);
    expect(overlaps(sideBox, await box(page.locator(".page-layout .editor-toolbar").first()))).toBe(false);
    expect(sideBox.x + sideBox.width).toBeLessThanOrEqual((await box(panel)).x);
    await expectNoSidewaysScroll(page);
    expect(errors).toEqual([]);
  } finally {
    await mock.close();
  }
});
