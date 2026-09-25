import { test, expect } from "@playwright/test";

test("dropping a block at the side of another creates columns", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Mouse drag on wide layouts.");
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
  const host = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Spalten ${Date.now()}`,
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${host.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({
    action: "document.sync",
    pageId: host.id,
    generation: (await read()).generation,
    update: Buffer.from(
      htmlState("<p>Alpha</p><p>Bravo</p><p>Charlie</p>"),
    ).toString("base64"),
  });
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator(":scope > p")).toHaveText([
    "Alpha",
    "Bravo",
    "Charlie",
  ]);
  const handle = page.getByRole("button", {
    name: "Blockaktionen: Absatz · Charlie",
    exact: true,
  });
  await editor.locator("p", { hasText: "Charlie" }).hover();
  const from = (await handle.boundingBox())!;
  const target = (await editor
    .locator("p", { hasText: "Alpha" })
    .boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width - 8,
    target.y + target.height / 2,
    { steps: 10 },
  );
  // A vertical marker shows the side drop.
  const marker = page.locator(".document-block-drop");
  await expect(marker).toBeVisible();
  expect((await marker.boundingBox())!.height).toBeGreaterThan(8);
  await page.mouse.up();
  const columns = editor.locator(".editor-columns");
  await expect(columns.locator(".editor-column")).toHaveText([
    "Alpha",
    "Charlie",
  ]);
  await expect(editor.locator(":scope > p")).toHaveText(["Bravo"]);
  await expect
    .poll(async () => (await read()).html)
    .toMatch(/data-columns[\s\S]*Alpha[\s\S]*Charlie/);
  await page.reload();
  await expect(
    page
      .getByLabel("Dokumentinhalt", { exact: true })
      .locator(".editor-column"),
  ).toHaveText(["Alpha", "Charlie"]);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: host.id });
});
