import { test, expect } from "@playwright/test";

test("link cards show previews and videos take a chosen width", async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/example\.org|vimeo\.com/, (route) =>
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
    title: `Links ${testInfo.project.name} ${Date.now()}`,
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({
    action: "document.sync",
    pageId: p.id,
    generation: (await read()).generation,
    update: Buffer.from(
      htmlState(
        '<div data-link-card="https://example.org/bericht" data-link-title="Quartalsbericht" data-link-provider="Beispiel AG" data-link-description="Zahlen und Ziele"></div><iframe src="https://player.vimeo.com/video/76979871"></iframe><p>Ende</p>',
      ),
    ).toString("base64"),
  });
  await page.goto(`/#page=${p.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const card = editor.locator(".link-card a");
  await expect(card).toHaveAttribute("href", "https://example.org/bericht");
  await expect(card).toContainText("Quartalsbericht");
  await expect(card).toContainText("Beispiel AG");
  // Selecting the video offers its width.
  await page
    .getByRole("button", { name: /^Blockaktionen: Medium/ })
    .first()
    .click();
  const blocks = page.getByRole("dialog", { name: "Blöcke verwalten" });
  await blocks.getByLabel("Medienbreite").selectOption("50");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await read()).html).toMatch(/width:\s?50%/);
  // Visitors see the card on the public page.
  await command({ action: "page.publish", pageId: p.id, enabled: true });
  const token = (await read()).page.public_token;
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.route(/example\.org|vimeo\.com/, (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await visitor.goto(`${origin}/share/${token}`);
  await expect(visitor.locator(".link-card a")).toContainText(
    "Quartalsbericht",
  );
  await expect(visitor.locator("iframe")).toHaveAttribute("style", /50%/);
  await visitorContext.close();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
