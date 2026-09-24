import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("templates can be searched, exported as a file and imported again", async ({
  page,
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
  const tag = `${testInfo.project.name}${Date.now()}`;
  const p = await command({
    action: "page.import",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Quelle ${tag}`,
    format: "markdown",
    content: "Agenda und Beschlüsse",
  });
  await command({
    action: "template.save",
    pageId: p.id,
    name: `Protokoll ${tag}`,
  });
  await page.goto(`/#page=${p.id}`);
  if (testInfo.project.name === "mobile")
    await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await page.getByRole("button", { name: "Vorlagen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Vorlagen" });
  await dialog.getByLabel("Vorlagen durchsuchen").fill(`Protokoll ${tag}`);
  const row = dialog.locator(".saved-template-row", {
    hasText: `Protokoll ${tag}`,
  });
  await expect(row).toHaveCount(1);
  await dialog.getByLabel("Vorlagentyp").selectOption("database");
  await expect(row).toHaveCount(0);
  await dialog.getByLabel("Vorlagentyp").selectOption("all");
  const downloadPromise = page.waitForEvent("download");
  await row.getByRole("link", { name: `Protokoll ${tag} exportieren` }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    `Protokoll ${tag}.flowplan-template.zip`,
  );
  const file = readFileSync(await download.path());
  await dialog.getByLabel("Vorlagendatei importieren").setInputFiles({
    name: "vorlage.zip",
    mimeType: "application/zip",
    buffer: file,
  });
  await expect(row).toHaveCount(2);
  await page.screenshot({
    path: `test-results/template-exchange-verification/${testInfo.project.name}-templates.png`,
  });
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
