import { test, expect } from "@playwright/test";

test("guests with edit links change relations and files and move calendar entries", async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
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
  const read = async (pageId: string) =>
    (await page.request.get(`/api/pages/${pageId}`)).json();
  const tag = `${testInfo.project.name}${Date.now()}`;
  const create = (title: string, extra = {}) =>
    command({
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      title,
      ...extra,
    });
  const host = await create(`Projekt ${tag}`);
  const people = await create(`Team ${tag}`, {
    parentId: host.id,
    kind: "database",
  });
  const tasks = await create(`Aufgaben ${tag}`, {
    parentId: host.id,
    kind: "database",
  });
  const month = new Date().toISOString().slice(0, 7);
  await command({
    action: "database.update",
    pageId: tasks.id,
    version: (await read(tasks.id)).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "start", name: "Beginn", type: "date" },
      {
        id: "who",
        name: "Beteiligte",
        type: "relation",
        relationPage: people.id,
      },
      { id: "docs", name: "Unterlagen", type: "files" },
    ],
    views: [
      {
        id: "calendar",
        name: "Kalender",
        type: "calendar",
        filters: [],
        sorts: [],
        dateField: "start",
      },
    ],
  });
  await command({
    action: "row.create",
    pageId: people.id,
    cells: { title: "Ada" },
  });
  const task = await command({
    action: "row.create",
    pageId: tasks.id,
    cells: { title: "Review", start: `${month}-10` },
  });
  const link = await command({
    action: "share.create",
    pageId: host.id,
    role: "editor",
    includeChildren: true,
    name: "Team",
  });
  const visitor = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: testInfo.project.name === "mobile",
  });
  try {
    const guest = await visitor.newPage();
    guest.on("pageerror", (e) => errors.push(e.message));
    await guest.goto(`${origin}/share/${link.token}/${tasks.id}`);
    const day = (d: string) =>
      guest.locator(`.public-calendar-day[data-day="${month}-${d}"]`);
    await expect(day("10")).toContainText("Review");
    await guest.getByRole("button", { name: "Review verschieben" }).click();
    const dialog = guest.getByRole("dialog", { name: "Review verschieben" });
    await dialog.getByLabel("Neuer Beginn").fill(`${month}-17`);
    await dialog.getByRole("button", { name: "Verschieben" }).click();
    await expect(day("17")).toContainText("Review");
    await expect(day("10")).not.toContainText("Review");
    // The record page edits the relation and attaches a file.
    await day("17").getByRole("link", { name: "Review" }).click();
    await expect(guest.getByRole("heading", { name: "Review" })).toBeVisible();
    await guest
      .getByRole("button", { name: "Inhalt bearbeiten", exact: true })
      .click();
    await guest.getByRole("checkbox", { name: "Ada" }).check();
    await guest.getByLabel("Unterlagen: Datei hochladen").setInputFiles({
      name: "protokoll.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Protokoll"),
    });
    await expect(
      guest.getByRole("group", { name: "Unterlagen" }),
    ).toContainText("protokoll.txt");
    await guest
      .getByRole("button", { name: "Änderungen speichern", exact: true })
      .click();
    await expect(guest.getByRole("status")).toHaveText(
      "Änderungen gespeichert",
    );
    await expect(guest.locator(".public-relations").first()).toContainText(
      "Ada",
    );
    const file = guest.getByRole("link", { name: "protokoll.txt" });
    await expect(file).toHaveAttribute(
      "href",
      new RegExp(`/api/share/${link.token}/files/`),
    );
    expect(
      await (
        await guest.request.get((await file.getAttribute("href")) as string)
      ).text(),
    ).toBe("Protokoll");
    await guest.screenshot({
      path: `test-results/public-guest-edits/${testInfo.project.name}.png`,
      fullPage: true,
    });
  } finally {
    await visitor.close();
  }
  const row = (await read(tasks.id)).rows.find(
    (r: { id: string }) => r.id === task.id,
  );
  expect(row.cells.start).toBe(`${month}-17`);
  expect(row.cells.who).toHaveLength(1);
  expect(row.cells.docs[0]).toMatch(/^\/api\/files\//);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: host.id });
});
