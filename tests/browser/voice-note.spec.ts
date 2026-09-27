import { test, expect } from "@playwright/test";

// Chromium's fake microphone.
test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["microphone"],
});

test("a voice note is recorded and inserted as audio", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same recorder on mobile.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const pageId = (
    await (
      await page.request.post("/api/command", {
        headers: { origin },
        data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Sprachnotiz ${Date.now()}`, kind: "document" },
      })
    ).json()
  ).id;
  await page.goto(`/#page=${pageId}`);
  await page.getByLabel("Dokumentinhalt", { exact: true }).click();
  await page.keyboard.type("/sprachnotiz");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Sprachnotiz" });
  await dialog.getByRole("button", { name: "Aufnahme starten" }).click();
  await expect(dialog.locator(".voice-time")).toHaveText("0:02", { timeout: 5000 });
  await dialog.getByRole("button", { name: "Aufnahme beenden" }).click();
  await expect(dialog.getByLabel("Aufnahme anhören")).toBeVisible();
  // Without WHISPER_URL there is no transcription, only the audio.
  await expect(dialog).toContainText("nicht eingerichtet");
  await dialog.getByRole("button", { name: "Einfügen" }).click();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true }).locator("audio")).toBeVisible();
  expect(errors).toEqual([]);
});
