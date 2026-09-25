import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

const png = readFileSync(join(process.cwd(), "tests/fixtures/scan.png"));

test("workspaces get an emoji or an image as their symbol", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const icon = async () =>
    (await (await page.request.get("/api/bootstrap")).json()).workspace.icon;
  const previous = boot.workspace.icon;
  // Unsafe values are refused.
  const bad = await page.request.post("/api/command", {
    headers: { origin },
    data: {
      action: "workspace.update",
      workspaceId: boot.workspace.id,
      icon: "<script>",
    },
  });
  expect(bad.status()).toBe(400);
  await page.goto("/");
  if (await page.getByRole("button", { name: "Navigation öffnen" }).isVisible())
    await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await page
    .getByRole("button", { name: "Einstellungen", exact: true })
    .click();
  await page.getByRole("button", { name: "Emoji oder Symbol" }).click();
  const picker = page.getByRole("dialog", {
    name: "Symbol für den Arbeitsbereich",
  });
  await picker.getByPlaceholder(/Rakete/).fill("Rakete");
  await picker.getByRole("button", { name: /🚀/ }).first().click();
  await expect.poll(icon).toBe("🚀");
  await expect(
    page.locator(".workspace-switch .workspace-letter"),
  ).toContainText("🚀");
  await page.getByLabel("Bild für den Arbeitsbereich").setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect.poll(icon).toMatch(/^data:image\/(webp|png);base64,/);
  await expect(
    page.locator(".workspace-switch .workspace-letter img"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Entfernen" }).click();
  await expect.poll(icon).toBe("");
  await expect(page.locator(".workspace-switch .workspace-letter")).toHaveText(
    boot.workspace.name.slice(0, 1).toUpperCase(),
  );
  await page.request.post("/api/command", {
    headers: { origin },
    data: {
      action: "workspace.update",
      workspaceId: boot.workspace.id,
      icon: previous && /^[A-Za-z]$/.test(previous) ? "" : previous,
    },
  });
  expect(errors).toEqual([]);
});
