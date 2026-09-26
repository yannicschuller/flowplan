import { test, expect } from "@playwright/test";

test("embeds from several providers are inserted, stored and published", async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // External players are not loaded in tests.
  await page.route(/vimeo\.com|spotify\.com/, (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
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
    title: `Einbettungen ${testInfo.project.name} ${Date.now()}`,
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  await page.goto(`/#page=${p.id}`);
  const insert = async (url: string) => {
    await page
      .getByRole("button", { name: "Block hinzufügen", exact: true })
      .click();
    await page.locator(".slash-menu").getByRole("button", { name: /^Einbetten / }).click();
    const dialog = page.getByRole("dialog", { name: "Inhalt einbetten" });
    await dialog.getByLabel(/^Link/).fill(url);
    await dialog
      .getByRole("button", { name: "Einbetten", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
  };
  const content = page.getByLabel("Dokumentinhalt", { exact: true });
  await insert("https://vimeo.com/76979871");
  await expect(
    content.locator('iframe[src="https://player.vimeo.com/video/76979871"]'),
  ).toHaveAttribute("title", "Vimeo");
  await insert("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc");
  await expect(
    content.locator(
      'iframe[src="https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT"]',
    ),
  ).toBeVisible();
  // Unknown sites are refused.
  await page
    .getByRole("button", { name: "Block hinzufügen", exact: true })
    .click();
  await page.locator(".slash-menu").getByRole("button", { name: /^Einbetten / }).click();
  const dialog = page.getByRole("dialog", { name: "Inhalt einbetten" });
  await dialog.getByLabel(/^Link/).fill("http://example.com/video/1");
  await dialog.getByRole("button", { name: "Einbetten", exact: true }).click();
  await expect(page.getByText(/Nur öffentliche HTTPS-Adressen/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await read()).html)
    .toContain("player.vimeo.com/video/76979871");
  // Saving is debounced; the second player may arrive a moment later.
  await expect
    .poll(async () => (await read()).html)
    .toContain("open.spotify.com/embed/track/");

  // The published page shows the same players.
  await command({ action: "page.publish", pageId: p.id, enabled: true });
  const token = (await read()).page.public_token;
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.route(/vimeo\.com|spotify\.com/, (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await visitor.goto(`${origin}/share/${token}`);
  await expect(
    visitor.locator('iframe[src="https://player.vimeo.com/video/76979871"]'),
  ).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-presentation",
  );
  await visitorContext.close();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
