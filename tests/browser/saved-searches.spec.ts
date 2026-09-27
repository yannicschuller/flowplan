import { test, expect } from "@playwright/test";

test("quick search saves, reapplies and deletes personal searches", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const tag = `${testInfo.project.name}${Date.now()}`;
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: {
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      title: `Gespeichert ${tag}`,
    },
  });
  const p = await response.json();
  await page.goto(`/#page=${p.id}`);
  await expect(page.locator(".tiptap")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", {
    name: "Schnellsuche",
    exact: true,
  });
  const input = dialog.getByLabel("Suchen oder Befehl");
  await input.fill(`Gespeichert ${tag}`);
  await dialog.getByRole("radio", { name: "Dokumente", exact: true }).click();
  await dialog.getByRole("button", { name: "Suche speichern" }).click();
  const name = dialog.getByLabel("Name der gespeicherten Suche");
  await name.fill(`Meine Suche ${tag}`);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  const list = dialog.getByRole("list", { name: "Gespeicherte Suchen" });
  const chip = list.getByRole("button", {
    name: `Meine Suche ${tag}`,
    exact: true,
  });
  await expect(chip).toBeVisible();

  // Reset, then apply the saved search again.
  await input.fill("");
  await dialog.getByRole("radio", { name: "Alles", exact: true }).click();
  await chip.click();
  await expect(input).toHaveValue(`Gespeichert ${tag}`);
  await expect(
    dialog.getByRole("radio", { name: "Dokumente", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    dialog.getByRole("button", { name: new RegExp(`Gespeichert ${tag}`) }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/saved-search-verification/${testInfo.project.name}.png`,
  });

  // Survives a reload and can be deleted.
  await page.reload();
  await expect(page.locator(".tiptap")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(chip).toBeVisible();
  await list
    .getByRole("button", {
      name: `Gespeicherte Suche Meine Suche ${tag} löschen`,
    })
    .click();
  await expect(chip).toHaveCount(0);
  const after = await (await page.request.get("/api/bootstrap")).json();
  expect(
    after.savedSearches.some((s: { name: string }) => s.name.includes(tag)),
  ).toBe(false);
  expect(errors).toEqual([]);
});
