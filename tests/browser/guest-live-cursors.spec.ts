import { test, expect } from "@playwright/test";

test("guests on edit links get changes at once and see members' cursors, and members see theirs", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run is enough for timing.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Gast-Cursor ${Date.now()}`,
  });
  const link = await command({ action: "share.create", pageId: p.id, role: "editor", name: "Kunde" });
  await page.goto(`/#page=${p.id}`);
  const member = page.getByLabel("Dokumentinhalt", { exact: true });
  await member.click();
  await page.keyboard.type("Erste Zeile");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Zweite Zeile");
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${p.id}`)).json()).html)
    .toContain("Zweite Zeile");

  const visitor = await browser.newContext({ viewport: page.viewportSize()! });
  try {
    const guest = await visitor.newPage();
    await guest.goto(`${origin}/share/${link.token}`);
    await guest.getByRole("button", { name: "Inhalt bearbeiten", exact: true }).click();
    const editor = guest.getByLabel("Geteilten Inhalt bearbeiten");
    await expect(editor).toContainText("Zweite Zeile");
    await guest.waitForTimeout(1200);

    // Member text reaches the guest by push, well below the old interval.
    await member.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" plus");
    const start = Date.now();
    await expect(editor).toContainText("Zweite Zeile plus", { timeout: 5000 });
    const latency = Date.now() - start;
    expect(latency, `${latency} ms`).toBeLessThan(1500);

    // The member's cursor shows up in the guest editor with the name.
    await expect(guest.locator(".collaborator-cursor").first()).toBeAttached({ timeout: 5000 });
    await expect(guest.locator(".collaborator-name").first()).toContainText(boot.user.name);

    // The guest's cursor shows up for the member, named after the link.
    await editor.click();
    await guest.keyboard.press("ControlOrMeta+Home");
    const guestCaret = page.locator(".collaborator-cursor", { hasText: "Gast · Kunde" });
    await expect(guestCaret).toBeAttached({ timeout: 5000 });
    // It sits in the first line, where the guest's caret is.
    const caretTop = await guestCaret.evaluate((el) => el.getBoundingClientRect().top);
    const firstLine = await member.locator("p").first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    expect(caretTop).toBeGreaterThanOrEqual(firstLine.top - 4);
    expect(caretTop).toBeLessThanOrEqual(firstLine.bottom);
  } finally {
    await visitor.close();
  }
});
