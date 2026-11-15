import { test, expect } from "@playwright/test";

// #300: on touch devices a document scrolls on past its last line, so the
// line being typed can always be brought above the keyboard – the iPad's
// floating keyboard (and Safari) do not shrink the visible area. A mouse
// keeps the page ending where it ends.
test("a document scrolls past its last line on touch devices", async ({ page }, info) => {
  test.setTimeout(120_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Past the end ${Date.now()}`, kind: "document" },
    })
  ).json();
  await page.goto(`/#page=${created.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await page.waitForTimeout(300);
  if (await welcome.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(welcome).toBeHidden();
  }
  await editor.click();
  for (let i = 1; i <= 30; i++) {
    await page.keyboard.type(`Zeile ${i}`);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.type("Letzte Zeile");
  // Scrolled to the very end: where does the last line sit?
  const at = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".main-scroll")!;
    scroller.scrollTop = scroller.scrollHeight;
    const last = [...document.querySelectorAll(".ProseMirror p")].pop()!.getBoundingClientRect();
    return { bottom: last.bottom, height: window.innerHeight };
  });
  if (info.project.name === "mobile") expect(at.bottom).toBeLessThanOrEqual(at.height * 0.5);
  else expect(at.bottom).toBeGreaterThan(at.height * 0.6);
});
