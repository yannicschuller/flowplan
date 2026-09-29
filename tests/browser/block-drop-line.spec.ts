import { test, expect } from "@playwright/test";

// Dragging a block across the gap between two others: the line stays in one
// place (the middle of the gap) instead of jumping between the lower edge of
// the upper block and the upper edge of the lower one.
test("the drop line sits still in the gap between two blocks", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse drag.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const p = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: {
        action: "page.import",
        workspaceId: boot.workspace.id,
        spaceId: boot.spaces[0].id,
        title: `Linie ${Date.now()}`,
        content: "<p>Erster Block</p><p>Zweiter Block</p><p>Dritter Block</p><p>Vierter Block</p>",
        format: "html",
      },
    })
  ).json();
  await page.goto(`/#page=${p.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Vierter Block");
  const handle = page.getByRole("button", { name: /Blockaktionen: .*Erster Block/ });
  await editor.getByText("Erster Block").hover();
  const h = (await handle.boundingBox())!;
  const second = (await editor.getByText("Zweiter Block").boundingBox())!;
  const third = (await editor.getByText("Dritter Block").boundingBox())!;
  const x = second.x + 40;
  const gapTop = second.y + second.height, gapBottom = third.y;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  const line = page.locator(".document-block-drop");
  const tops: number[] = [];
  for (const y of [second.y + second.height * 0.75, gapTop + 1, (gapTop + gapBottom) / 2, gapBottom - 1, third.y + third.height * 0.25]) {
    await page.mouse.move(x, y, { steps: 4 });
    await expect(line).toBeVisible();
    await page.waitForTimeout(150);
    tops.push(Math.round((await line.boundingBox())!.y));
  }
  // One place for the whole way through the gap.
  expect(new Set(tops).size, JSON.stringify(tops)).toBe(1);
  await page.mouse.up();
  await expect(editor.locator("p").nth(1)).toHaveText("Erster Block");
});

// A proxy error page (HTML) while saving: no "Unexpected token" message; the
// change is kept and saved once the server answers again.
test("an HTML error page while saving is retried quietly", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const p = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Neustart ${Date.now()}`, kind: "document" },
    })
  ).json();
  await page.goto(`/#page=${p.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  let failed = 0;
  await page.route("**/api/command", async (route) => {
    if (route.request().postData()?.includes('"document.sync"') && failed < 2) {
      failed++;
      return route.fulfill({ status: 502, contentType: "text/html", body: "<!DOCTYPE html><html><body>Bad Gateway</body></html>" });
    }
    await route.continue();
  });
  await page.keyboard.type("Trotz Neustart gespeichert");
  await expect.poll(() => failed, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(page.getByText(/Unexpected token|not valid JSON/)).toHaveCount(0);
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${p.id}`)).json()).html, { timeout: 15_000 })
    .toContain("Trotz Neustart gespeichert");
  await expect(page.getByText(/Unexpected token|not valid JSON|nicht erreichbar/)).toHaveCount(0);
});

// The case from the video: "2. Minus Formel" dragged between two paragraphs
// stays a numbered item with its number.
test("a numbered item dragged out of its list keeps its number", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse drag.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const p = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: {
        action: "page.import",
        workspaceId: boot.workspace.id,
        spaceId: boot.spaces[0].id,
        title: `Liste ${Date.now()}`,
        content: "<ol><li><p>Plus Formel</p></li><li><p>Minus Formel</p></li></ol><p>Plus mal Minus</p><p>Binomische Formeln</p>",
        format: "html",
      },
    })
  ).json();
  await page.goto(`/#page=${p.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Binomische Formeln");
  await editor.getByText("Minus Formel", { exact: true }).hover();
  const handle = page.getByRole("button", { name: /Blockaktionen: .*Minus Formel$/ });
  const h = (await handle.boundingBox())!;
  const below = (await editor.getByText("Plus mal Minus").boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(below.x + 40, below.y + below.height - 2, { steps: 8 });
  await expect(page.locator(".document-block-drop")).toBeVisible();
  await page.mouse.up();
  const moved = editor.locator("ol", { hasText: "Minus Formel" });
  await expect(moved).toHaveAttribute("start", "2");
  await expect(moved).not.toContainText("Plus Formel");
  // In order: the first list, the paragraph, the moved item, the last paragraph.
  await expect(editor.locator(":scope > *")).toHaveText([/Plus Formel/, "Plus mal Minus", /Minus Formel/, "Binomische Formeln"]);
});
