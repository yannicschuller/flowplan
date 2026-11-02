import { test, expect } from "@playwright/test";

// Collections (#86): saved from the quick search, shown in the sidebar with
// their results, updated when a matching page appears, deleted with undo.
test("quick search saves a collection that lists matching pages live", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const tag = `${testInfo.project.name}${Date.now()}`;
  const create = async (title: string) =>
    (
      await (
        await page.request.post("/api/command", {
          headers: { origin },
          data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title },
        })
      ).json()
    ).id as string;
  const first = await create(`Gespeichert ${tag}`);
  await page.goto(`/#page=${first}`);
  await expect(page.locator(".tiptap")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Schnellsuche", exact: true });
  await dialog.getByLabel("Suchen oder Befehl").fill(`title:${tag}`);
  await dialog.getByRole("button", { name: "Als Sammlung speichern" }).click();
  const editor = page.getByRole("dialog", { name: "Neue Sammlung", exact: true });
  await editor.getByLabel("Name", { exact: true }).fill(`Sammlung ${tag}`);
  await expect(editor.getByText(`title:${tag}`)).toBeVisible();
  await editor.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Sammlung ${tag}` })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`Gespeichert ${tag}`) })).toBeVisible();
  const nav = page.getByRole("region", { name: "Sammlungen" });
  await expect(nav.getByRole("button", { name: `Sammlung ${tag}` })).toBeVisible();

  // A new matching page appears by itself.
  await create(`Neu ${tag}`);
  await expect(page.getByRole("link", { name: new RegExp(`Neu ${tag}`) })).toBeVisible({ timeout: 20000 });

  // Deleted, then back with undo.
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await expect(nav.getByRole("button", { name: `Sammlung ${tag}` })).toHaveCount(0);
  await page.getByRole("button", { name: "Rückgängig" }).click();
  await expect(nav.getByRole("button", { name: `Sammlung ${tag}` })).toBeVisible();
  expect(errors).toEqual([]);
});
