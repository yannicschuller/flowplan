import { test, expect, type Page } from "@playwright/test";

// Flow diagrams (#427): typed as text in a document, drawn while typing,
// saved with the page; and a database chart of the kind "flow", published.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  return { boot, command };
}
// Pictures for the review, light and dark (only on desktop).
async function shots(page: Page, name: string, target: ReturnType<Page["locator"]>, project: string) {
  if (project !== "desktop") return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await target.screenshot({ path: `test-results/flow-diagram/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("write a flow diagram as text: drawn live, problems by line, saved", async ({ page }, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await setup(page);
  const pageId = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Budget ${Date.now()}`, kind: "document" })).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("/Flussdiagramm");
  await page.keyboard.press("Enter");
  const block = editor.locator(".flow-diagram");
  const text = block.getByLabel("Flüsse – eine Zeile pro Fluss");
  // The new block opens its text, focused.
  await expect(text).toBeFocused();
  await expect(block.locator(".flow-empty")).toBeVisible();
  await text.fill("Hauptjob -> Budget: 2.750,00\nNebenjob -> Budget: 550\nBudget -> Fixkosten: 1.100\nBudget -> Sparen: 1250\nBudget -> Konsum: 950\nFixkosten #f5c542");
  await expect(block.locator(".flow-node")).toHaveCount(6);
  await expect(block.locator(".flow-link")).toHaveCount(5);
  await block.getByLabel("Einheit (optional)").fill("€");
  await expect(block.locator(".flow-label", { hasText: "Budget" })).toContainText("3.300,00 €");
  await expect(block.locator(".flow-node").nth(3)).toHaveAttribute("fill", "#f5c542");
  // A cycle and a bad number: listed by line, the rest still drawn.
  await text.press("End");
  await text.pressSequentially("\nKonsum -> Hauptjob: 5\nSparen -> Depot: viel");
  const problems = block.getByRole("status", { name: "Probleme im Flussdiagramm" });
  await expect(problems.locator("li")).toHaveText([/^Zeile 7: .*Kreis/, /^Zeile 8: „viel“ ist keine Zahl/]);
  await expect(block.locator(".flow-link")).toHaveCount(5);
  await text.fill(await text.inputValue().then((v) => v.split("\n").slice(0, 6).join("\n")));
  await expect(problems).toBeHidden();
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${pageId}`)).json()).html, { timeout: 20_000 })
    .toMatch(/data-flow-diagram="Hauptjob -&gt; Budget: 2\.750,00[^"]*Fixkosten #f5c542" data-flow-unit="€"/);
  await shots(page, "editor", block, info.project.name);
  // Done: only the diagram; after a reload it is drawn from the stored text.
  await block.getByRole("button", { name: "Fertig" }).click();
  await expect(block.locator(".flow-editor")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true }).locator(".flow-diagram .flow-node")).toHaveCount(6, { timeout: 30_000 });
  await expect(page.getByLabel("Dokumentinhalt", { exact: true }).getByRole("button", { name: "Flüsse bearbeiten" })).toBeVisible();
  // Published: drawn read-only, without the controls.
  await command({ action: "page.publish", pageId, enabled: true });
  const token = (await (await page.request.get(`/api/pages/${pageId}`)).json()).page.public_token;
  await page.goto(`${origin}/share/${token}`);
  const shared = page.locator("[data-flow-diagram]");
  await expect(shared.locator(".flow-node")).toHaveCount(6, { timeout: 30_000 });
  await expect(shared.locator(".flow-toggle")).toHaveCount(0);
  await shots(page, "published", shared, info.project.name);
  expect(errors).toEqual([]);
});

test("a database chart as a flow diagram, in the app and published", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "desktop", "Same rendering on mobile.");
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await setup(page);
  const db = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "database", title: `Geldfluss ${Date.now()}` })).id;
  await command({
    action: "database.update",
    pageId: db,
    version: 1,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "from", name: "Von", type: "select", options: ["Lohn", "Budget"] },
      { id: "to", name: "Nach", type: "select", options: ["Budget", "Miete", "Essen"] },
      { id: "amount", name: "Betrag", type: "number" },
    ],
    views: [
      {
        id: "chart",
        name: "Diagramm",
        type: "chart",
        filters: [],
        sorts: [],
        chart: { kind: "flow", xField: "from", targetField: "to", yField: "amount", aggregate: "sum", unit: "€", dateBucket: "month", order: "label_asc", includeEmpty: false, showValues: true },
      },
    ],
  });
  for (const cells of [
    { title: "Gehalt", from: "Lohn", to: "Budget", amount: 3000 },
    { title: "Miete", from: "Budget", to: "Miete", amount: 1200 },
    { title: "Markt", from: "Budget", to: "Essen", amount: 400 },
    { title: "Bäcker", from: "Budget", to: "Essen", amount: 50 },
  ])
    await command({ action: "row.create", pageId: db, cells });

  await page.goto(`/#page=${db}`);
  const chart = page.locator(".database-chart");
  await expect(chart.locator(".chart-flow .flow-node")).toHaveCount(4, { timeout: 30_000 });
  await expect(chart.locator(".chart-flow .flow-label", { hasText: "Essen" })).toContainText("450,00 €");
  const flows = chart.locator("table.chart-data");
  await expect(flows.locator("th").first()).toHaveText("Fluss");
  await expect(flows.locator("tr", { hasText: "Budget → Essen" })).toContainText("450");
  // A flow opens its records.
  await flows.getByRole("button", { name: "Budget → Essen" }).click();
  await expect(page.getByRole("dialog")).toContainText("Bäcker");
  await page.keyboard.press("Escape");
  // The configuration: source, target, unit; no series or axes.
  await chart.getByRole("button", { name: "Diagramm konfigurieren" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("label", { hasText: /^Ziel/ }).locator("select")).toHaveValue("to");
  await expect(dialog.getByLabel("Einheit", { exact: true })).toHaveValue("€");
  await expect(dialog.getByLabel("Datenreihen")).toHaveCount(0);
  await expect(dialog.getByLabel("Beschriftung Werteachse")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await shots(page, "database-chart", chart.locator(".chart-scroll"), info.project.name);

  await command({ action: "page.publish", pageId: db, enabled: true });
  const token = (await (await page.request.get(`/api/pages/${db}`)).json()).page.public_token;
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`${origin}/share/${token}?view=chart`);
  await expect(visitor.locator(".public-chart .flow-node")).toHaveCount(4);
  await expect(visitor.locator(".public-chart-table tr", { hasText: "Essen" })).toContainText("450");
  expect(errors).toEqual([]);
});
