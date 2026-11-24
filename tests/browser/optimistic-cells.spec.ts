import { test, expect } from "@playwright/test";

// A slow connection: a changed status shows at once, not only after the
// server answered and the database was reloaded.
test("changed cells show immediately on a slow connection", async ({ page }, info) => {
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
    title: `Aufgaben ${info.project.name} ${Date.now()}`,
    kind: "database",
  });
  await command({ action: "row.create", pageId: p.id, cells: { title: "Angebot schreiben", status: "Nicht begonnen" } });
  await page.goto(`/#page=${p.id}`);
  await page.getByText("Angebot schreiben").click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  // On a phone a record's properties start folded (record-properties-fold.spec.ts).
  if (info.project.name === "mobile") await entry.getByRole("button", { name: /^Eigenschaften ausklappen/ }).click();
  // The value's button (the option search, #423).
  const status = entry.getByRole("button", { name: /^Status: / });
  const choose = async (option: string) => {
    await status.click();
    await page.getByRole("listbox", { name: "Optionen von Status" }).getByRole("option", { name: option, exact: true }).click();
  };
  await expect(status).toHaveAccessibleName("Status: Nicht begonnen, ändern");

  await page.route("**/api/command", async (route) => {
    if (route.request().postData()?.includes('"row.update"')) await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });
  await choose("In Arbeit");
  await expect(status).toHaveAccessibleName("Status: In Arbeit, ändern", { timeout: 1000 });
  await expect(status.locator(".tag").filter({ hasText: "In Arbeit" })).toBeVisible({ timeout: 1000 });
  // After the answer the value stays.
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${p.id}`)).json()).rows[0].cells.status)
    .toBe("In Arbeit");
  await page.waitForTimeout(500);
  await expect(status).toHaveAccessibleName("Status: In Arbeit, ändern");

  // A rejected change brings the old value back.
  await page.unroute("**/api/command");
  await page.route("**/api/command", async (route) => {
    if (route.request().postData()?.includes('"row.update"'))
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Geändert von jemand anderem." }) });
    await route.continue();
  });
  await choose("Erledigt");
  await expect(status).toHaveAccessibleName("Status: In Arbeit, ändern");
  await expect(page.getByText("Geändert von jemand anderem.")).toBeVisible();
  expect(errors).toEqual([]);
});
