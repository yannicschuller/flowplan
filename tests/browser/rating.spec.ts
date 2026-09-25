import { test, expect } from "@playwright/test";

test("number properties show and collect star ratings", async ({
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
    title: `Bewertungen ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "score", name: "Bewertung", type: "number" },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  const row = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Café" },
  });
  await page.goto(`/#page=${p.id}`);
  // Switch the number property to stars in its settings.
  await page
    .locator(".data-table thead")
    .getByRole("button", { name: /^\W*Bewertung$/ })
    .click();
  const settings = page.getByRole("dialog", { name: "Eigenschaft bearbeiten" });
  await settings.getByLabel("Zahlendarstellung").selectOption("rating");
  await expect(settings.getByLabel("Anzahl Sterne")).toHaveValue("5");
  await settings
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await read()).database.fields.find(
          (f: { id: string }) => f.id === "score",
        ).rollupDisplay,
    )
    .toBe("rating");
  await page.goto(`/#page=${p.id}&row=${row.id}`);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const stars = entry.getByRole("radiogroup", { name: "Bewertung" });
  await stars.getByRole("radio", { name: "4 Sterne" }).click();
  await expect.poll(async () => (await read()).rows[0].cells.score).toBe(4);
  await expect(stars.getByRole("radio", { name: "4 Sterne" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(
    page.locator(".data-table").getByRole("img", { name: "4 von 5 Sternen" }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/rating-verification/${testInfo.project.name}-table.png`,
  });

  // Visitors rate in the public form; invalid values are refused.
  await command({
    action: "form.update",
    pageId: p.id,
    enabled: true,
    internal: false,
    anonymous: true,
  });
  const token = (await read()).form.token;
  const visitor = await browser.newContext();
  const form = await visitor.newPage();
  await form.goto(`${origin}/forms/${token}`);
  await form.getByRole("textbox", { name: "Name" }).fill("Bäckerei");
  await form
    .getByRole("radiogroup", { name: "Bewertung" })
    .getByRole("radio", { name: "2 Sterne" })
    .click();
  await form.getByRole("button", { name: "Antwort senden" }).click();
  await expect(
    form.getByRole("heading", { name: "Vielen Dank!" }),
  ).toBeVisible();
  const invalid = await visitor.request.post(`${origin}/api/forms/${token}`, {
    headers: { origin },
    data: { cells: { title: "Zu gut", score: 7 } },
  });
  expect(invalid.ok()).toBe(false);
  await visitor.close();
  const scores = (await read()).rows
    .map((r: { cells: { score?: number } }) => r.cells.score)
    .sort();
  expect(scores).toEqual([2, 4]);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
