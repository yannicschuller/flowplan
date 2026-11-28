import { test, expect, type Locator, type Page } from "@playwright/test";

// A written function gets its calculus in the text menu (lib/math-analysis.ts):
// f′, the extreme points and an integral are inserted after the selection,
// "f′(2) =" is answered by the hint, and the graph switches f′, the marked
// points and a hatched area on. SCREENSHOTS=<dir> saves pictures of the graph.
const shots = process.env.SCREENSHOTS;

async function select(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
}
// Opens the menu's "Analysis" group and clicks a row.
async function analysis(page: Page, row: RegExp) {
  const group = page.getByRole("group", { name: "Rechnen" });
  const toggle = group.getByRole("menuitem", { name: /^Analysis/ });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await group.getByRole("menuitem", { name: row }).click();
}

test("derivative, extreme points and integral of a written function, and its graph", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Selecting text with the mouse is desktop-only here.");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Analysis ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("f(x) = x³ − 6x² + 9x");
  const first = editor.locator("p").first();

  // f′ after the selection.
  await select(page, first);
  await analysis(page, /^1\. Ableitung/);
  await expect(first).toHaveText("f(x) = x³ − 6x² + 9x ⇒ f′(x) = 3x² − 12x + 9");
  // The paragraph with the result is still the function: the extreme points.
  await select(page, first);
  await analysis(page, /^Extrempunkte/);
  await expect(first).toContainText("⇒ H(1 | 4); T(3 | 0)");

  // The hint after "=" knows f.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("f′(2) =");
  await expect(editor.locator(".calc-hint")).toContainText("−3", { timeout: 30_000 });
  await page.keyboard.press("Tab");
  await expect(editor.locator("p").nth(1)).toHaveText("f′(2) = −3");

  // A written integral.
  await page.keyboard.press("Enter");
  await page.keyboard.type("∫₀³ x³ − 6x² + 9x dx");
  const integral = editor.locator("p").nth(2);
  await select(page, integral);
  await analysis(page, /^Integral/);
  await expect(integral).toHaveText("∫₀³ x³ − 6x² + 9x dx = 27/4");

  // The graph: f′ dashed, the points marked, the area from 0 to 3 hatched.
  await select(page, first);
  await page.getByRole("group", { name: "Rechnen" }).getByRole("menuitem", { name: /Graph zeichnen/ }).click();
  const plot = editor.locator(".function-plot");
  await expect(plot.locator("svg.plot-svg")).toBeVisible({ timeout: 30_000 });
  await expect(plot.locator(".plot-legend")).toContainText(["f(x) = x³ − 6x² + 9x"]);
  await plot.getByRole("button", { name: "Ableitungen, Punkte und Fläche von f" }).click();
  const options = plot.getByRole("group", { name: "Analyse von f" });
  await options.getByLabel("f′", { exact: true }).check();
  await expect(plot.locator("path.plot-derivative-1")).toHaveCount(1);
  await expect(plot.locator(".plot-legend")).toContainText(["f′(x) = 3x² − 12x + 9"]);
  await options.getByLabel("Punkte", { exact: true }).check();
  await expect(plot.locator(".plot-max")).toHaveCount(1);
  await expect(plot.locator(".plot-min")).toHaveCount(1);
  await expect(plot.locator(".plot-inflection")).toHaveCount(1);
  await expect(plot.locator(".plot-max title")).toHaveText("Hochpunkt H(1 | 4)");
  await options.getByLabel("Fläche", { exact: true }).check();
  await plot.getByLabel("Obere Grenze").fill("3");
  await expect(plot.locator(".plot-area")).toHaveCount(1);
  await expect(plot.locator(".plot-legend-area")).toHaveText("∫ f(x) dx von 0 bis 3 = 27/4, Mittelwert 9/4");
  if (shots) await plot.screenshot({ path: `${shots}/graph-cubic.png` });
  // Switched off again: f′ goes.
  await options.getByLabel("f′", { exact: true }).uncheck();
  await expect(plot.locator("path.plot-derivative-1")).toHaveCount(0);
  // Saved with the page.
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${pageId}`)).json()).html, { timeout: 20_000 })
    .toContain("&quot;points&quot;:true");

  // The maintainer's function in t: f, f′ and f″, the points, an area.
  await plot.getByLabel("Funktion f").fill("½·t³·e^(−t/3 − 3/5)");
  await options.getByLabel("f′", { exact: true }).check();
  await options.getByLabel("f″", { exact: true }).check();
  await plot.getByLabel("Untere Grenze").fill("0");
  await plot.getByLabel("Obere Grenze").fill("9");
  await expect(plot.locator(".plot-legend")).toContainText(["f(t) = ½·t³·e^(−t/3 − 3/5)", "f′(t) = (3/2·t² − 1/6·t³)·e^(−1/3·t − 3/5)"]);
  await expect(plot.locator(".plot-max title")).toHaveText("Hochpunkt H(9 | 729/2·e^(−18/5) ≈ 9,9595)");
  if (shots) {
    // Zoomed out so the maximum at t = 9 and the inflection points are in view.
    for (let i = 0; i < 2; i++) await plot.getByRole("button", { name: "Verkleinern" }).click();
    await plot.screenshot({ path: `${shots}/graph-sheet.png` });
  }
  expect(errors).toEqual([]);
});
