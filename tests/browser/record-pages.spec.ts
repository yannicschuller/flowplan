import { test, expect } from "@playwright/test";

test("records open as full pages, can be favourited and restored from the trash", async ({
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
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Datensätze ${tag}`,
    kind: "database",
  });
  const row = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: `Vertrag ${tag}` },
  });
  const mobile = testInfo.project.name === "mobile";
  await page.goto(`/#page=${p.id}&row=${row.id}`);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await entry.getByRole("button", { name: "Als ganze Seite anzeigen" }).click();
  await expect(entry).toHaveClass(/modal-full/);
  await entry.getByRole("button", { name: "Zu Favoriten" }).click();
  await expect(
    entry.getByRole("button", { name: "Aus Favoriten entfernen" }),
  ).toBeVisible();
  await entry.getByRole("button", { name: "Als Dialog anzeigen" }).click();
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  if (mobile)
    await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await expect(
    page
      .locator(".sidebar")
      .getByRole("button", { name: `Eintrag Vertrag ${tag}` }),
  ).toBeVisible();

  await page.goto(`/#page=${p.id}&row=${row.id}`);
  await entry.getByRole("button", { name: "Eintrag löschen" }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/pages/${p.id}`)).json()).rows
          .length,
    )
    .toBe(0);
  // Closing the record updates the address; navigate afterwards.
  await expect(page).not.toHaveURL(/row=/);
  await page.goto("/#trash");
  await expect(page.getByRole("heading", { name: "Papierkorb" })).toBeVisible();
  const trash = page.getByLabel("Gelöschte Einträge");
  await expect(trash).toContainText(`Vertrag ${tag}`);
  await page.screenshot({
    path: `test-results/record-pages-verification/${testInfo.project.name}-trash.png`,
    fullPage: true,
  });
  await trash
    .locator(".utility-row", { hasText: `Vertrag ${tag}` })
    .getByRole("button", { name: "Wiederherstellen" })
    .click();
  await expect(
    entry.getByRole("heading", { name: `Vertrag ${tag}`, exact: true }),
  ).toBeVisible();
  expect(
    (await (await page.request.get(`/api/pages/${p.id}`)).json()).rows[0].id,
  ).toBe(row.id);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
