import { test, expect } from "@playwright/test";

// The sidebar's dragged width is kept in a cookie (lib/layout-cookie.ts),
// so the server renders the page with it: after a reload the very first
// paint already has that width – no jump from the stylesheet's default
// after hydration.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

test("a reload keeps the dragged sidebar width from the first paint", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the sidebar is a drawer on phones");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.goto("/");
  const handle = page.getByRole("separator", { name: "Breite der Seitenleiste" });
  await expect(handle).toBeVisible();
  // Arrow keys move the edge in steps of 16 px (Shift: 48 px).
  await handle.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  const width = Number(await handle.getAttribute("aria-valuenow"));
  expect(width).toBeGreaterThan(300);
  await expect
    .poll(async () => (await page.context().cookies()).find((c) => c.name === "flowplan-layout")?.value)
    .toBe(`${width}.0.0`);

  // The server's HTML already has the width on the app shell …
  const html = await (await page.request.get("/")).text();
  expect(html).toContain(`--sidebar-width:${width}px`);
  // … and so does the app shell the browser parses on a reload, before any
  // script of the app ran (a MutationObserver sees it as it is inserted).
  await page.addInitScript(() => {
    const seen = new MutationObserver(() => {
      const shell = document.querySelector<HTMLElement>(".app-shell");
      if (!shell) return;
      seen.disconnect();
      (window as unknown as { __firstWidth?: string }).__firstWidth = shell.style.getPropertyValue("--sidebar-width");
    });
    seen.observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  await expect(page.locator(".sidebar")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __firstWidth?: string }).__firstWidth)).toBe(`${width}px`);
  await expect(page.locator(".sidebar")).toHaveJSProperty("offsetWidth", width);
});
