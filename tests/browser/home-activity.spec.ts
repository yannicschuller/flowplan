import { test, expect } from "@playwright/test";

// "My activity" on the start page (#114): the person's own pages created
// and edited, the period chosen on the widget and kept in its settings,
// charts with a title for screen readers, no horizontal scrolling on phones.
test("my activity: own numbers per week, month and year", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const workspaceId = boot.workspace.id;
  // Something to count: a page created and edited today.
  const created = await (await page.request.post("/api/command", { headers: { origin }, data: { action: "page.create", workspaceId, spaceId: boot.spaces[0].id, title: "Aktivität heute" } })).json();
  await page.request.post("/api/command", { headers: { origin }, data: { action: "page.update", pageId: created.id, patch: { title: "Aktivität heute (bearbeitet)" } } });
  const layout = {
    version: 1,
    widgets: [{ id: "mine", kind: "myActivity", size: "m", config: { period: "week" } }],
    appearance: { header: { type: "none", value: "", position: 50 }, density: "comfortable", background: "none", icon: "", width: "normal" },
  };
  await page.request.post("/api/command", { headers: { origin }, data: { action: "home.save", workspaceId, layout } });

  await page.goto("/#home");
  const widget = page.locator('[data-widget-id="mine"]');
  await expect(widget.getByRole("heading", { name: "Meine Aktivität" })).toBeVisible();
  const periods = widget.getByRole("radiogroup", { name: "Zeitraum" });
  await expect(periods.getByRole("radio", { name: "Woche" })).toBeChecked();
  // Two figures, each with a chart that has a title.
  await expect(widget.getByRole("region", { name: "Seiten erstellt" })).toBeVisible();
  await expect(widget.getByRole("region", { name: "Seiten bearbeitet" })).toBeVisible();
  await expect(widget.getByRole("group", { name: /^Seiten erstellt – Woche\. Pro Tag/ })).toBeVisible();
  const createdValue = Number((await widget.getByRole("region", { name: "Seiten erstellt" }).locator("strong").textContent())!.replace(/\D/g, ""));
  expect(createdValue).toBeGreaterThanOrEqual(1);
  await expect(widget.getByText("Nur du siehst diese Zahlen.")).toBeVisible();

  // Another period: the charts follow, the choice is stored with the layout.
  await periods.getByText("Jahr").click();
  await expect(periods.getByRole("radio", { name: "Jahr" })).toBeChecked();
  await expect(widget.getByRole("group", { name: /^Seiten bearbeitet – Jahr\. Pro Monat/ })).toBeVisible();
  await expect
    .poll(async () => (await (await page.request.get("/api/bootstrap")).json()).home.layout.widgets.find((w: { id: string }) => w.id === "mine").config.period)
    .toBe("year");
  await page.reload();
  await expect(page.locator('[data-widget-id="mine"]').getByRole("radio", { name: "Jahr" })).toBeChecked();

  // Phones: nothing wider than the screen.
  if (info.project.name === "mobile") {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
  expect(errors).toEqual([]);
});

// The development demo account is shared by all browser tests: leave its
// start page as it was.
test.afterEach(async ({ page }) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const boot = await (await page.request.get("/api/bootstrap")).json();
  for (let i = 0; i < 2; i++)
    await page.request.post("/api/command", { headers: { origin }, data: { action: "home.reset", workspaceId: boot.workspace.id, scope: "personal" } });
});
