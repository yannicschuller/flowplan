import { test, expect, type Page, type Locator } from "@playwright/test";

// #259: with a long table of contents scrolled down, its close button had
// scrolled away with the list. The head (title, fold buttons, close) stays
// at the top of the list's own scroll area, over the entries; Escape in the
// list closes it beside the text too (the popover closed on Escape already).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const HEADINGS = 60;
const html = Array.from({ length: HEADINGS }, (_, i) => `<h2>Abschnitt ${i + 1}</h2><p>Text zu Abschnitt ${i + 1}.</p>`).join("");

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Lange Gliederung ${Date.now()}`, kind: "document" });
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${host.id}`)).json()).generation;
  await command({ action: "document.sync", pageId: host.id, generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return { host, command };
}

// The close button is on top (not covered by an entry) and inside the list's box.
async function reachable(outline: Locator, close: Locator) {
  const nav = (await outline.boundingBox())!;
  const box = (await close.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(nav.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(nav.y + nav.height);
  const hit = await close.evaluate((button) => {
    const r = button.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!at && button.contains(at);
  });
  expect(hit).toBe(true);
}

for (const scheme of ["light", "dark"] as const) {
  test(`a long table of contents scrolled down can still be closed (${scheme})`, async ({ page }, info) => {
    test.setTimeout(90_000);
    const phone = info.project.name === "mobile";
    await page.emulateMedia({ colorScheme: scheme });
    const { host, command } = await setup(page);
    // Beside the text (wide), and a popover (narrow window; phones).
    for (const width of phone ? [0] : [1440, 820]) {
      if (width) await page.setViewportSize({ width, height: 800 });
      await page.goto(`/#page=${host.id}`);
      const editor = page.getByLabel("Dokumentinhalt", { exact: true });
      await expect(editor.getByText(`Abschnitt ${HEADINGS}`, { exact: true })).toBeAttached({ timeout: 30_000 });
      const toggle = page.locator(".outline-toggle");
      await toggle.click();
      const outline = page.getByRole("navigation", { name: "Inhaltsverzeichnis" });
      await expect(outline.getByRole("button", { name: `Abschnitt ${HEADINGS}`, exact: true })).toBeAttached();
      const close = outline.getByRole("button", { name: "Inhaltsverzeichnis schließen" });
      // The list scrolls on its own …
      expect(await outline.evaluate((n) => n.scrollHeight - n.clientHeight)).toBeGreaterThan(200);
      await outline.evaluate((n) => (n.scrollTop = n.scrollHeight));
      await expect.poll(() => outline.evaluate((n) => n.scrollTop)).toBeGreaterThan(200);
      // … and the head stays: the close button visible, on top, with a
      // background of its own over the entries.
      await expect(close).toBeInViewport();
      await reachable(outline, close);
      const head = outline.locator(".document-outline-head");
      expect(await head.evaluate((h) => getComputedStyle(h).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      await page.screenshot({ path: `test-results/outline-close-sticky-${info.project.name}-${width || "phone"}-${scheme}.png` });
      await close.click();
      await expect(outline).toHaveCount(0);

      // Escape in the list closes it too and goes back to its toggle.
      await toggle.click();
      await expect(outline).toBeVisible();
      await outline.getByRole("button", { name: "Abschnitt 3", exact: true }).focus();
      await page.keyboard.press("Escape");
      await expect(outline).toHaveCount(0);
      await expect(toggle).toBeFocused();
    }
    await page.goto("/#home");
    await command({ action: "page.delete", pageId: host.id });
  });
}
