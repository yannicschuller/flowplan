import { test, expect } from "@playwright/test";

test("a synced block edited on one page changes on the other", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const create = async (title: string) =>
    (
      await (
        await page.request.post("/api/command", {
          headers: { origin },
          data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" },
        })
      ).json()
    ).id;
  const stamp = `${info.project.name} ${Date.now()}`;
  const first = await create(`Sync A ${stamp}`);
  const second = await create(`Sync B ${stamp}`);
  const text = `Öffnungszeiten ${stamp}`;

  await page.goto(`/#page=${first}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true }).first();
  await editor.click();
  await page.keyboard.type("/synchronisierter");
  await page.keyboard.press("Enter");
  const block = page.locator(".synced-block");
  await expect(block).toBeVisible();
  await expect(block.locator(".synced-block-bar")).toContainText("Synchronisiert");
  const inner = block.getByLabel("Dokumentinhalt", { exact: true });
  await inner.click();
  await page.keyboard.type(text);
  await expect
    .poll(async () => {
      const list = await (await page.request.get(`/api/synced?workspace=${boot.workspace.id}`)).json();
      return JSON.stringify(list);
    }, { timeout: 15_000 })
    .toContain(text);

  // Insert the same block on the second page.
  await page.goto(`/#page=${second}`);
  await page.getByLabel("Dokumentinhalt", { exact: true }).first().click();
  await page.keyboard.type("/synchronisierten");
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Synchronisierten Block einfügen" }).locator(".synced-choice", { hasText: text }).click();
  const copy = page.locator(".synced-block");
  await expect(copy).toContainText(text);
  // Edit here …
  await copy.getByLabel("Dokumentinhalt", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" – geändert");
  await page.waitForTimeout(1500);
  // … and see it on the first page.
  await page.goto(`/#page=${first}`);
  await expect(page.locator(".synced-block")).toContainText(`${text} – geändert`);
  await expect(page.locator(".synced-block-bar")).toContainText("auf 2 Seiten");
  expect(errors).toEqual([]);
});
