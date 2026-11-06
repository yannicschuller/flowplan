import { test, expect } from "@playwright/test";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

// Confirmations of the database view ("Link kopiert", "… verschoben") are
// info toasts: not a red error, and not swallowed by the dialog that closes.
test("database confirmations show as info toasts, not as errors", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const stamp = `${info.project.name} ${Date.now()}`;
  const source = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Quelle ${stamp}`, kind: "database" });
  const target = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Ablage ${stamp}`, kind: "database" });
  const first = await command({ action: "row.create", pageId: source.id, cells: { title: "Angebot" } });
  await command({ action: "row.create", pageId: source.id, cells: { title: "Rechnung" } });
  const confirmation = (text: string) => page.getByRole("status").filter({ hasText: text });

  // "Link kopieren" in the record dialog.
  await page.goto(`/#page=${source.id}&row=${first.id}`);
  const record = page.getByRole("dialog", { name: "Eintrag" });
  await record.getByRole("button", { name: "Link kopieren" }).click();
  await expect(confirmation("Link kopiert")).toBeVisible();
  await expect(record.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".toast-error")).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/#page=${source.id}&row=${first.id}`);
  await page.keyboard.press("Escape");
  await expect(record).toBeHidden();

  // Moving the selected records: the dialog closes and the toast says so.
  await page.getByRole("checkbox", { name: "Angebot auswählen" }).check();
  await page.getByRole("checkbox", { name: "Rechnung auswählen" }).check();
  await page.getByRole("button", { name: "Verschieben / kopieren nach …" }).click();
  const dialog = page.getByRole("dialog", { name: "2 Einträge verschieben" });
  await dialog.getByRole("radio", { name: `Ablage ${stamp}` }).check();
  await dialog.getByRole("button", { name: "Verschieben", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(confirmation(`2 Einträge nach „Ablage ${stamp}“ verschoben.`)).toBeVisible();
  await expect(page.locator(".toast-error")).toHaveCount(0);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/pages/${target.id}`)).json()).rows as unknown[]).length)
    .toBe(2);
  expect(errors).toEqual([]);
});
