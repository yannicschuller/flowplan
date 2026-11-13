import { test, expect, type Page } from "@playwright/test";

// #262: back on the start page (or another screen) after scrolling down in a
// document, the start page showed up scrolled down as well. Every place
// starts at its top; back and forward bring a place back where it was left
// in that step of the history, never where another page was.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const pane = (page: Page) => page.locator(".main-scroll").first();
const scrollTop = (page: Page) => pane(page).evaluate((el) => el.scrollTop);
const scrollTo = async (page: Page, top: number) => {
  await pane(page).evaluate((el, top) => {
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  }, top);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(top - 50);
};

test("home and other screens after a scrolled document start at their top; back and forward restore each entry", async ({ page }, info) => {
  const phone = info.project.name === "mobile";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const { htmlState } = await import("../../lib/document-server");
  const stamp = Date.now();
  const long = async (name: string) => {
    const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title: `${name} ${stamp}` });
    const generation = (await (await page.request.get(`/api/pages/${created.id}`)).json()).generation;
    const paragraphs = Array.from({ length: 120 }, (_, i) => `<p data-block-id="${name}-${i}">${name} Absatz ${i}</p>`).join("");
    await command({ action: "document.sync", pageId: created.id, generation, update: Buffer.from(htmlState(paragraphs)).toString("base64") });
    return created.id as string;
  };
  const a = await long("Scrolldok");
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  // The start page tall enough to scroll (a small window).
  if (!phone) await page.setViewportSize({ width: 1280, height: 520 });

  await page.goto("/#home");
  await expect(page.locator(".main-scroll .home-screen")).toBeVisible({ timeout: 20_000 });
  const homeScrolls = await pane(page).evaluate((el) => el.scrollHeight - el.clientHeight);
  // From the start page's "recently edited" card.
  await page.locator(".main-scroll").getByText(`Scrolldok ${stamp}`).first().click();
  await expect(editor.getByText("Scrolldok Absatz 119", { exact: true })).toBeAttached({ timeout: 20_000 });
  await expect(page.locator("article[data-revalidating]")).toHaveCount(0);
  await scrollTo(page, 2000);

  // Back to the start page (it was at its top in that entry).
  await page.goBack();
  await expect(editor).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(await scrollTop(page)).toBe(0);

  // Forward to the document: where it was left.
  await page.goForward();
  await expect(editor.getByText("Scrolldok Absatz 119", { exact: true })).toBeAttached();
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(1900);

  // The sidebar's "Startseite", then the other screens: each at its top.
  for (const hash of ["home", "inbox", "tasks", "graph", "settings"]) {
    await page.evaluate((h) => (location.hash = `page=${h}`), a);
    await expect(editor.getByText("Scrolldok Absatz 119", { exact: true })).toBeAttached();
    await scrollTo(page, 1800);
    if (hash === "home" && !phone) await page.getByRole("button", { name: "Startseite", exact: true }).first().click();
    else await page.evaluate((h) => (location.hash = h), hash);
    await expect(editor).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(await scrollTop(page), hash).toBe(0);
  }

  // A scrolled start page comes back scrolled with back, not with a new visit.
  expect(homeScrolls).toBeGreaterThan(100);
  {
    await page.evaluate(() => (location.hash = "home"));
    await expect(editor).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(await scrollTop(page)).toBe(0);
    await scrollTo(page, Math.min(300, homeScrolls));
    const left = await scrollTop(page);
    await page.evaluate((h) => (location.hash = `page=${h}`), a);
    await expect(editor.getByText("Scrolldok Absatz 119", { exact: true })).toBeAttached();
    expect(await scrollTop(page)).toBe(0);
    await page.goBack();
    await expect(editor).toHaveCount(0);
    await expect.poll(() => scrollTop(page)).toBe(left);
  }

  await page.goto("/#home");
  await command({ action: "page.delete", pageId: a });
});
