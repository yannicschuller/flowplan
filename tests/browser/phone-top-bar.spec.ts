import { test, expect } from "@playwright/test";
import { openPageMenu } from "./page-top-bar";

// On a phone the page's top bar holds the sidebar button, the title and ⋯
// (components/workspace-app.tsx); follow, favourite and share are at the top
// of the ⋯ menu, and the comments button shows once there is a comment.
test("the phone top bar leaves the room to the title", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Phones only.");
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
  const title = "Dienstag, 10. November 2026";
  const { id: pageId } = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" });
  await page.goto(`/#page=${pageId}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();

  // ☰, the whole title and ⋯ – nothing else takes the room.
  const bar = page.locator(".topbar");
  await expect(bar.getByRole("button")).toHaveCount(2);
  await expect(bar.getByRole("button", { name: "Navigation öffnen", exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Seitenaktionen", exact: true })).toBeVisible();
  // The current segment of the path (#231), not cut off.
  const crumb = bar.locator(".breadcrumb-current .breadcrumb-link > span");
  await expect(crumb).toHaveText(title);
  await expect.poll(() => crumb.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // While everything is saved the cloud is there for screen readers only.
  await expect(bar.locator(".save-status")).toHaveClass(/save-status-quiet/);
  await expect(bar.locator(".save-status")).toContainText("Gespeichert");

  // Favourite and follow from the ⋯ menu, their state shown; the menu stays open.
  const menu = await openPageMenu(page);
  const star = menu.getByRole("menuitemcheckbox", { name: "Favorit", exact: true });
  await expect(star).toHaveAttribute("aria-checked", "false");
  expect((await star.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await star.click();
  await expect(star).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => (await (await page.request.get("/api/bootstrap")).json()).favorites as string[])
    .toContain(pageId);
  const bell = menu.getByRole("menuitemcheckbox", { name: "Folgen", exact: true });
  await expect(bell).toHaveAttribute("aria-checked", "true");
  await bell.click();
  await expect(bell).toHaveAttribute("aria-checked", "false");
  await bell.click();
  await expect(bell).toHaveAttribute("aria-checked", "true");
  // Share opens the share dialog.
  await menu.getByRole("menuitem", { name: "Teilen", exact: true }).click();
  const share = page.getByRole("dialog", { name: "Seite teilen", exact: true });
  await expect(share).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(share).toHaveCount(0);

  // No comments yet: "Kommentare" in the menu, none in the bar.
  await expect(bar.getByRole("button", { name: /^Kommentare/ })).toHaveCount(0);
  await (await openPageMenu(page)).getByRole("menuitem", { name: "Kommentare", exact: true }).click();
  const panel = page.locator(".comments-panel");
  await panel.getByPlaceholder("Schreibe einen Kommentar …").fill("Passt das Datum?");
  await panel.getByRole("button", { name: "Kommentieren", exact: true }).click();
  await expect(panel).toContainText("Passt das Datum?");
  await panel.getByRole("button", { name: "Kommentare schließen", exact: true }).click();
  // With a comment the bar shows the button and its count.
  const comments = bar.getByRole("button", { name: "Kommentare (1)", exact: true });
  await expect(comments).toBeVisible();
  await expect(comments).toContainText("1");
  await (await openPageMenu(page)).getByRole("menuitemcheckbox", { name: "Favorit", exact: true }).waitFor();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "Kommentare", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await comments.click();
  await expect(panel).toBeVisible();

  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId });
});
