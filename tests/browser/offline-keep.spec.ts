import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

// #417: the storage budget per device, persistent storage, the storage per
// space and "Keep offline" for a space – its records are stored without
// ever being opened and freed again when it is switched off.
test("offline settings: budget, persistent storage, storage per space and keeping a space offline", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  test.skip(testInfo.project.name !== "desktop", "One service-worker run covers the shared code path.");
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
  const name = `Wissen ${randomUUID().slice(0, 8)}`;
  const space = await command({ action: "space.create", workspaceId: boot.workspace.id, name, private: false });
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: space.id, title: "Zertifizierung", kind: "database" });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Kapitel 1" } });
  const rowKey = `/api/pages/${db.id}/rows/${row.id}`;
  const cached = () =>
    page.evaluate(async () =>
      (await caches.has("flowplan-data-v1")) ? (await (await caches.open("flowplan-data-v1")).keys()).map((r) => new URL(r.url).pathname) : [],
    );
  const marker = () =>
    page.evaluate(async () => (await (await caches.open("flowplan-settings")).match("/__flowplan-offline"))?.json());

  await page.goto("/#settings/devices");
  await page.getByRole("button", { name: "Auf diesem Gerät offline verfügbar machen" }).click();
  await expect(page.getByText(/offline verfügbar\./)).toBeVisible({ timeout: 120_000 });

  // Persistent storage was asked for; the answer is shown either way.
  await expect(page.getByTestId("offline-persisted")).toHaveText(/^(Dauerhaft gespeichert|Kann vom Browser bei Platzmangel gelöscht werden)$/);

  // The browser's default budget, chosen per device.
  const budget = page.getByRole("combobox", { name: "Speicherbudget" });
  await expect(budget).toHaveValue(String(200 * 1024 * 1024));
  await expect(budget.locator("option")).toHaveText(["200 MB", "1 GB", "2 GB", "5 GB", "10 GB"]);
  await budget.selectOption(String(1024 * 1024 * 1024));
  await expect(page.getByText("Offline-Kopie ist auf dem neuesten Stand.")).toBeVisible({ timeout: 120_000 });
  expect((await marker()).budget).toBe(1024 * 1024 * 1024);
  await expect(page.getByTestId("offline-budget-left")).toContainText("von 1 GB");

  // Storage per space; the record was never opened, so it is not stored.
  const spaceRow = page.getByTestId("offline-spaces").getByRole("row").filter({ hasText: name });
  await expect(spaceRow).toBeVisible();
  expect(await cached()).not.toContain(rowKey);

  // Keep the space offline: its records follow without being opened.
  await spaceRow.getByRole("switch", { name: `${name} offline behalten` }).click();
  await expect.poll(cached, { timeout: 120_000 }).toContain(rowKey);
  expect((await marker()).keep).toEqual([{ kind: "space", id: space.id }]);
  await expect.poll(async () => (await marker()).spaces?.[space.id]?.records || 0, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(spaceRow.getByRole("switch", { name: `${name} offline behalten` })).toHaveAttribute("aria-checked", "true");

  // The space's "⋯" menu and the database's page menu say so too.
  await page.goto(`/#page=${db.id}`);
  await page.getByRole("button", { name: `Bereich ${name} verwalten` }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: /Offline behalten/ })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  const pageItem = page.getByRole("menuitemcheckbox", { name: /Offline behalten/ });
  await expect(pageItem).toHaveAttribute("aria-checked", "true");
  await expect(pageItem).toContainText("Der ganze Bereich wird offline behalten.");
  await page.keyboard.press("Escape");

  // Switched off from the space's menu: the record goes with the next refresh.
  await page.getByRole("button", { name: `Bereich ${name} verwalten` }).click();
  await page.getByRole("menuitemcheckbox", { name: /Offline behalten/ }).click();
  await expect.poll(cached, { timeout: 120_000 }).not.toContain(rowKey);
  expect((await marker()).keep).toEqual([]);
  expect((await marker()).released || []).toEqual([]);

  await page.goto("/#settings/devices");
  await page.getByRole("button", { name: "Offline-Kopien entfernen" }).click();
  await expect(page.getByText("Offline-Kopien auf diesem Gerät wurden entfernt.")).toBeVisible();
  await command({ action: "space.delete", spaceId: space.id }).catch(() => undefined);
  expect(errors).toEqual([]);
});
