import { test, expect } from "@playwright/test";

// A term in the text becomes a graph below it; the functions are edited in
// the graph and saved with the page.
test("draw a graph from a selected term and edit it live", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Selecting text with the mouse is desktop-only here.");
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Graph ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("f(x) = x² − 2");
  const term = editor.getByText("f(x) = x² − 2");
  const box = (await term.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.getByRole("group", { name: "Rechnen" }).getByRole("menuitem", { name: /Graph zeichnen/ }).click();

  const plot = editor.locator(".function-plot");
  await expect(plot.locator("svg.plot-svg")).toBeVisible({ timeout: 30_000 });
  await expect(plot.locator(".plot-curve")).toHaveCount(1);
  // Two zeros at ±√2.
  await expect(plot.locator(".plot-zero")).toHaveCount(2);
  // Live: another function is drawn while typing.
  await plot.getByRole("button", { name: "Funktion hinzufügen" }).click();
  await plot.getByLabel("Funktion g").fill("sin(x)");
  await expect(plot.locator(".plot-curve")).toHaveCount(2);
  await expect(plot.locator(".plot-legend")).toContainText(["f(x) = x² − 2", "g(x) = sin(x)"]);
  // Zooming in keeps working.
  await plot.getByRole("button", { name: "Vergrößern" }).click();
  // Saved with the page.
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${pageId}`)).json()).html, { timeout: 20_000 })
    .toContain("sin(x)");
  expect(errors).toEqual([]);
});

// Selected vectors are drawn as arrows; a vector can be added in the graph.
test("draw selected vectors as arrows and add one in the graph", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Selecting text with the mouse is desktop-only here.");
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Vektoren ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("(1; 2) + (3; 1)");
  const term = editor.getByText("(1; 2) + (3; 1)");
  const box = (await term.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.getByRole("group", { name: "Rechnen" }).getByRole("menuitem", { name: /Vektoren zeichnen/ }).click();

  const plot = editor.locator(".function-plot");
  await expect(plot.locator("svg.plot-svg")).toBeVisible({ timeout: 30_000 });
  // Both vectors and their sum.
  await expect(plot.locator(".plot-vector")).toHaveCount(3);
  await expect(plot.locator(".plot-legend")).toContainText(["a = (1; 2)", "b = (3; 1)", "c = (1; 2) + (3; 1)"]);
  await expect(plot.locator(".plot-vector title").nth(2)).toHaveText("Vektor c = (4 | 3)");
  // A function and a vector side by side.
  await plot.getByRole("button", { name: "Funktion hinzufügen" }).click();
  await plot.getByLabel("Funktion f").fill("x/2");
  await expect(plot.locator(".plot-curve")).toHaveCount(1);
  await expect(plot.locator(".plot-vector")).toHaveCount(3);
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${pageId}`)).json()).html, { timeout: 20_000 })
    .toContain("x/2");
  expect(errors).toEqual([]);
});
