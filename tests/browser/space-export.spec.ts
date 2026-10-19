import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// Issue #33: a whole space as one Markdown ZIP, from the sidebar.
test("a space is exported as Markdown from the sidebar", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers it.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  if (process.env.TEST_ADMIN_EMAIL)
    await page.request.post("/api/auth/password", { headers: { origin }, data: { email: process.env.TEST_ADMIN_EMAIL, password: process.env.TEST_ADMIN_PASSWORD } });
  else await page.request.post("/api/auth/demo", { headers: { origin } });
  // A new account would see the introduction first.
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const space = boot.spaces[0];
  await page.goto("/");
  await page.getByRole("button", { name: `${space.name} als Markdown exportieren` }).click();
  const dialog = page.getByRole("dialog", { name: "Bereich als Markdown exportieren" });
  await expect(dialog).toContainText(`"spaceId":"${space.id}"`);
  await dialog.getByLabel("Kommentare und frühere Versionen einschließen").check();
  await page.screenshot({ path: "test-results/space-export.png" });
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Herunterladen" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.zip$/);
  const bytes = readFileSync((await file.path())!);
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.includes(Buffer.from("index.md"))).toBe(true);
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});
