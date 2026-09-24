import { test, expect } from "@playwright/test";

test("feed entries edit properties and documents inline and accept quick comments", async ({
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Feed ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      {
        id: "mood",
        name: "Stimmung",
        type: "select",
        options: ["gut", "super"],
      },
    ],
    views: [
      {
        id: "feed",
        name: "Feed",
        type: "feed",
        filters: [],
        sorts: [],
        feed: {
          content: "full",
          showAuthor: true,
          showDate: true,
          showComments: true,
        },
      },
    ],
  });
  const row = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Montag", mood: "gut" },
  });
  await page.goto(`/#page=${p.id}`);
  const entry = page.getByRole("article", { name: "Montag" });
  await expect(entry).toBeVisible();
  await entry.getByRole("button", { name: "Bearbeiten" }).click();
  const editor = entry.getByLabel("Montag bearbeiten");
  await editor
    .getByRole("combobox", { name: "Stimmung" })
    .selectOption("super");
  await expect
    .poll(async () => (await read()).rows[0].cells.mood)
    .toBe("super");
  const doc = editor.locator(".tiptap");
  await expect(doc).toBeVisible();
  await doc.click();
  await page.keyboard.type("Heute war produktiv.");
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/pages/${p.id}/rows/${row.id}`)
          ).json()
        ).html,
      { timeout: 15000 },
    )
    .toContain("Heute war produktiv.");
  await page.screenshot({
    path: `test-results/feed-inline-verification/${testInfo.project.name}-editing.png`,
  });
  await entry.getByRole("button", { name: "Fertig" }).click();
  await entry.getByLabel("Kommentar zu Montag").fill("Schöner Eintrag");
  await entry.getByRole("button", { name: "Senden" }).click();
  await expect
    .poll(async () =>
      (await read()).comments.map((c: { body: string }) => c.body),
    )
    .toContain("Schöner Eintrag");
  await expect(entry.getByLabel("Kommentar zu Montag")).toHaveValue("");
  await expect(entry).toContainText("1 Kommentar");
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
