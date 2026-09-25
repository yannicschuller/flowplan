import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("quick search finds text in scanned images", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One OCR run is enough.");
  test.setTimeout(240000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: {
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      title: `Scans ${Date.now()}`,
    },
  });
  const p = await response.json();
  const fileName = `rechnung-${Date.now()}.png`;
  const upload = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: {
      pageId: p.id,
      file: {
        name: fileName,
        mimeType: "image/png",
        buffer: readFileSync("tests/fixtures/scan.png"),
      },
    },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  // The background worker recognises the text within a few seconds.
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(
              `/api/search?workspace=${boot.workspace.id}&q=Wartungsvertrag&kind=file`,
            )
          ).json()
        ).some((hit: { id: string }) => hit.id === p.id),
      { timeout: 180000, intervals: [2000] },
    )
    .toBe(true);
  await page.goto(`/#page=${p.id}`);
  await expect(page.locator(".tiptap")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Schnellsuche" });
  await dialog
    .getByPlaceholder("Seiten, Inhalte und Einträge finden …")
    .fill("Wartungsvertrag Heizung");
  await expect(
    dialog.getByRole("button", { name: new RegExp(fileName) }),
  ).toBeVisible();
});
