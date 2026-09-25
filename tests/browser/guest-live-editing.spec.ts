import { test, expect } from "@playwright/test";

test("guests and members edit a shared page live together", async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Live ${testInfo.project.name} ${Date.now()}`,
  });
  const link = await command({
    action: "share.create",
    pageId: p.id,
    role: "editor",
    name: "Live",
  });
  // The member writes first and keeps the page open.
  await page.goto(`/#page=${p.id}`);
  const member = page.getByLabel("Dokumentinhalt", { exact: true });
  await member.click();
  await page.keyboard.type("Vom Mitglied");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/pages/${p.id}`)).json()).html,
    )
    .toContain("Vom Mitglied");

  const visitor = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: testInfo.project.name === "mobile",
  });
  try {
    const guest = await visitor.newPage();
    guest.on("pageerror", (e) => errors.push(e.message));
    await guest.goto(`${origin}/share/${link.token}`);
    await guest
      .getByRole("button", { name: "Inhalt bearbeiten", exact: true })
      .click();
    const editor = guest.getByLabel("Geteilten Inhalt bearbeiten");
    await expect(editor).toContainText("Vom Mitglied");
    await expect(guest.locator(".shared-live-status")).toContainText("Live");
    // Guest text appears in the member's open editor without reloading.
    await editor.click();
    await guest.keyboard.press("ControlOrMeta+End");
    await guest.keyboard.press("Enter");
    await guest.keyboard.type("Vom Gast");
    await expect(member).toContainText("Vom Gast", { timeout: 15000 });
    // Member text appears for the guest while they keep editing.
    await member.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Antwort vom Mitglied");
    await expect(editor).toContainText("Antwort vom Mitglied", {
      timeout: 15000,
    });
    await expect(editor).toContainText("Vom Gast");
    // Saving ends editing and keeps the merged content.
    await guest
      .getByRole("button", { name: "Änderungen speichern", exact: true })
      .click();
    await expect(guest.getByRole("status")).toHaveText(
      "Änderungen gespeichert",
    );
    await guest.screenshot({
      path: `test-results/guest-live-editing/${testInfo.project.name}.png`,
      fullPage: true,
    });
  } finally {
    await visitor.close();
  }
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/pages/${p.id}`)).json()).html,
    )
    .toMatch(/Vom Mitglied[\s\S]*Vom Gast[\s\S]*Antwort vom Mitglied/);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
