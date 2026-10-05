import { test, expect } from "@playwright/test";

// A customer sends a request through a form with the portal on, follows it
// on its private page and replies; the team answers from the record.
test("customer portal: request, status and conversation", async ({ page, browser }, testInfo) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
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
    title: `Support ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () => (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Betreff", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Neu", "In Arbeit", "Erledigt"] },
    ],
    views: initial.database.views,
  });
  await command({
    action: "form.update",
    pageId: p.id,
    enabled: true,
    internal: false,
    anonymous: true,
    config: { hiddenFields: ["status"], portal: true, portalFields: ["status"] },
  });
  const token = (await read()).form.token;

  // The customer, without an account.
  const visitor = await browser.newContext(
    testInfo.project.name === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {},
  );
  const customer = await visitor.newPage();
  customer.on("pageerror", (e) => errors.push(e.message));
  await customer.goto(`${origin}/forms/${token}`);
  await customer.getByLabel("Betreff").fill("Drucker druckt nicht");
  await customer.getByRole("button", { name: "Antwort senden" }).click();
  await customer.getByRole("link", { name: "Anfrage ansehen" }).click();
  await expect(customer.getByRole("heading", { level: 1 })).toHaveText("Drucker druckt nicht");
  const ticketUrl = customer.url();
  expect(ticketUrl).toMatch(/\/ticket\/[A-Za-z0-9_-]{20,}$/);
  await customer.getByLabel("Antwort an das Team").fill("Es blinkt orange.");
  await customer.getByRole("button", { name: "Antwort senden" }).click();
  await expect(customer.locator(".ticket-messages li.customer")).toHaveText(/Es blinkt orange\./);

  // The team sets a status and answers in the record.
  const row = (await read()).rows.find((r: { cells: { title?: string } }) => r.cells.title === "Drucker druckt nicht");
  await command({ action: "row.update", pageId: p.id, rowId: row.id, version: row.version, cells: { status: "In Arbeit" } });
  await page.goto(`/#page=${p.id}&row=${row.id}`);
  const thread = page.getByRole("region", { name: "Kundenanfrage" });
  await expect(thread.getByText("Es blinkt orange.")).toBeVisible({ timeout: 30_000 });
  await thread.getByLabel("Antwort an den Kunden").fill("Wir schauen es uns an.");
  await thread.getByRole("button", { name: "Antworten" }).click();
  await expect(thread.locator(".ticket-messages li.team")).toHaveText(/Wir schauen es uns an\./);

  // The customer sees status and answer.
  await customer.reload();
  await expect(customer.locator(".ticket-status")).toContainText("In Arbeit");
  await expect(customer.locator(".ticket-messages li.team")).toHaveText(/Wir schauen es uns an\./);
  await visitor.close();
  expect(errors).toEqual([]);
});
