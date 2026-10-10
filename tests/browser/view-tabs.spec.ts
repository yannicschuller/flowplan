import { test, expect } from "@playwright/test";

// View tabs: rename, duplicate, reorder and delete by right-click; reorder
// by dragging; rename by double-click.
test("view tabs can be renamed, duplicated, reordered and deleted", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Right-click and drag and drop are desktop actions.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.accept());
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Ansichten ${Date.now()}`, kind: "database" },
  });
  const id = (await created.json()).id;
  const viewNames = async () => ((await (await page.request.get(`/api/pages/${id}`)).json()).database.views as { name: string }[]).map((v) => v.name);
  // Only the first two views matter here; the rest stay where they are.
  const start = await viewNames();
  const first = start[0];
  const rest = start.slice(1);
  await page.goto(`/#page=${id}`);
  const tabs = page.locator(".database-tabs");
  const tab = (name: string) => tabs.getByRole("tab", { name, exact: true });

  // Duplicate, then rename the copy from the menu.
  await tab(first).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplizieren" }).click();
  await expect(tab(`${first} (Kopie)`)).toHaveAttribute("aria-selected", "true");
  await tab(`${first} (Kopie)`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Umbenennen" }).click();
  await tabs.getByLabel("Name der Ansicht").fill("Offen");
  await tabs.getByLabel("Name der Ansicht").press("Enter");
  await expect.poll(viewNames).toEqual([first, "Offen", ...rest]);

  // Move left from the menu, then back by dragging.
  await tab("Offen").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Nach links" }).click();
  await expect.poll(viewNames).toEqual(["Offen", first, ...rest]);
  await tab("Offen").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Nach links" })).toBeDisabled();
  await page.keyboard.press("Escape");
  const box = (await tab(first).boundingBox())!;
  await tab("Offen").dragTo(tab(first), { targetPosition: { x: box.width - 4, y: box.height / 2 } });
  await expect.poll(viewNames).toEqual([first, "Offen", ...rest]);

  // Double-click renames too; Escape keeps the name.
  await tab("Offen").dblclick();
  await tabs.getByLabel("Name der Ansicht").fill("Verworfen");
  await tabs.getByLabel("Name der Ansicht").press("Escape");
  await expect(tab("Offen")).toBeVisible();

  // Delete the selected view: the one before it is shown.
  await tab("Offen").click();
  await tab("Offen").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Ansicht löschen" }).click();
  await expect.poll(viewNames).toEqual(start);
  await expect(tab(first)).toHaveAttribute("aria-selected", "true");
  await tab(first).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Ansicht löschen" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(errors).toEqual([]);
});
