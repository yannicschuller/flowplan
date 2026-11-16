import { test, expect, type Locator } from "@playwright/test";

// Board shortcuts with a non-Latin keyboard layout (#319): with a Russian
// layout the Z key writes "я", the D key "в". The physical key counts, as
// with a Latin layout.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

type Key = { key: string; code: string; ctrlKey?: boolean; shiftKey?: boolean };
const press = (wb: Locator, init: Key) =>
  wb.evaluate((root, init) => {
    const target = document.activeElement && root.contains(document.activeElement) ? document.activeElement : root;
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  }, init);

test("board shortcuts work with a Cyrillic layout", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Hardware-Tastatur");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  // Past the introduction a new account sees first.
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Layouts ${Date.now()}`, kind: "whiteboard" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const board = await created.json();
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  const box = (await wb.locator(".wb-canvas").boundingBox())!;
  // A note, typed in Cyrillic: the letters land in the note, no tool switches.
  await wb.getByRole("button", { name: "Notizzettel", exact: true }).click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // Playwright types these letters without a key press: into the open field.
  await expect(wb.locator("textarea")).toBeFocused();
  await page.keyboard.type("привет");
  await page.keyboard.press("Escape");
  await expect(wb.locator(".wb-sticky")).toHaveCount(1);
  await expect(wb.locator(".wb-sticky")).toContainText("привет");
  // Ctrl+D ("в" on the D key) duplicates the selected note.
  await press(wb, { key: "в", code: "KeyD", ctrlKey: true });
  await expect(wb.locator(".wb-sticky")).toHaveCount(2);
  // Ctrl+Z ("я" on the Z key) undoes it, Ctrl+Shift+Z redoes it.
  await press(wb, { key: "я", code: "KeyZ", ctrlKey: true });
  await expect(wb.locator(".wb-sticky")).toHaveCount(1);
  await press(wb, { key: "Я", code: "KeyZ", ctrlKey: true, shiftKey: true });
  await expect(wb.locator(".wb-sticky")).toHaveCount(2);
  // Single-key tools by the physical key: "р" on the H key is the hand.
  await page.keyboard.press("Escape");
  await press(wb, { key: "р", code: "KeyH" });
  await expect(wb.getByRole("button", { name: "Verschieben", exact: true })).toHaveAttribute("aria-pressed", "true");
  await press(wb, { key: "м", code: "KeyV" });
  await expect(wb.getByRole("button", { name: "Auswählen", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);
  await page.request.post("/api/command", { headers: { origin }, data: { action: "page.delete", pageId: board.id } });
});
