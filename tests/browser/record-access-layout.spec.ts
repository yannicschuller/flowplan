import { test, expect } from "@playwright/test";

test("record pages get their own permissions and layout options", async ({
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
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const tag = `${testInfo.project.name}${Date.now()}`;
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Akten ${tag}`,
    kind: "database",
  });
  await command({
    action: "database.update",
    pageId: p.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "note", name: "Notiz", type: "text" },
      { id: "intern", name: "Intern", type: "text" },
    ],
    views: (await read()).database.views,
  });
  const row = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: `Akte ${tag}`, intern: "Nur intern" },
  });
  const other = boot.members.find((m: { id: string }) => m.id !== boot.user.id);
  await page.goto(`/#page=${p.id}&row=${row.id}`);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });

  // Permissions: private with a grant for another member.
  await entry.getByRole("button", { name: /Rechte des Eintrags/ }).click();
  const access = entry.getByRole("group", { name: "Eintragsrechte" });
  await access.getByLabel("Zugriff").selectOption("private");
  await access
    .getByLabel("Person oder Gruppe freigeben")
    .selectOption(`u:${other.id}`);
  await access.getByLabel(`Recht für ${other.name}`).selectOption("editor");
  await access.getByRole("button", { name: "Rechte speichern" }).click();
  await expect(access.getByRole("status")).toHaveText("Rechte gespeichert");
  await expect
    .poll(async () => {
      const r = (await read()).rows.find(
        (x: { id: string }) => x.id === row.id,
      );
      return [r.access, r.grants?.[0]?.user_id, r.grants?.[0]?.role];
    })
    .toEqual(["private", other.id, "editor"]);
  await expect(
    entry.getByRole("button", { name: /Privater Eintrag/ }),
  ).toBeVisible();

  // Layout: properties beside the content, hidden and collapsed empty ones.
  await entry.getByRole("button", { name: "Layout anpassen" }).click();
  const layout = entry.getByRole("group", { name: "Layout der Einträge" });
  await layout.getByLabel("Position der Eigenschaften").selectOption("side");
  await expect(entry.locator(".row-columns")).toHaveClass(/properties-side/);
  if (testInfo.project.name !== "mobile")
    await expect
      .poll(() =>
        entry
          .locator(".row-columns")
          .evaluate((el) => getComputedStyle(el).display),
      )
      .toBe("grid");
  await layout.getByRole("checkbox", { name: "Intern" }).uncheck();
  await expect(entry.locator(".row-properties")).not.toContainText("Intern");
  await layout
    .getByRole("checkbox", { name: "Leere Eigenschaften einklappen" })
    .check();
  await expect(entry.locator(".row-properties")).not.toContainText("Notiz");
  await entry
    .getByRole("button", { name: "1 leere Eigenschaft anzeigen" })
    .click();
  await expect(entry.locator(".row-properties")).toContainText("Notiz");
  await layout.getByLabel("Einträge öffnen als").selectOption("side");
  await expect(entry).toHaveClass(/modal-side/);
  await expect
    .poll(async () => (await read()).database.recordLayout)
    .toEqual({
      open: "side",
      properties: "side",
      hideEmpty: true,
      hidden: ["intern"],
    });
  // A personal choice overrides the database default.
  await entry.getByLabel("Eintrag öffnen als").selectOption("center");
  await expect(entry).not.toHaveClass(/modal-side/);
  await page.reload();
  await expect(entry).toBeVisible();
  await expect(entry).not.toHaveClass(/modal-side/);
  await entry.getByLabel("Eintrag öffnen als").selectOption("");
  await expect(entry).toHaveClass(/modal-side/);
  await expect(entry.locator(".row-properties")).not.toContainText("Intern");
  // Page width stays within the viewport.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/record-access-layout/${testInfo.project.name}.png`,
  });
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
