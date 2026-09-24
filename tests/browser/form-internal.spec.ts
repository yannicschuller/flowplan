import { test, expect } from "@playwright/test";

test("internal forms offer members and related records as answers", async ({
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
  const db = async (title: string) =>
    (
      await command({
        action: "page.create",
        workspaceId: boot.workspace.id,
        spaceId: boot.spaces[0].id,
        title,
        kind: "database",
      })
    ).id as string;
  const people = await db(`Kontakte ${tag}`),
    requests = await db(`Anfragen ${tag}`);
  const read = async (id: string) =>
    (await page.request.get(`/api/pages/${id}`)).json();
  await command({
    action: "row.create",
    pageId: people,
    cells: { title: "Kim" },
  });
  const d = (await read(requests)).database;
  await command({
    action: "database.update",
    pageId: requests,
    version: d.version,
    fields: [
      { id: "title", name: "Titel", type: "text" },
      { id: "owner", name: "Zuständig", type: "person" },
      {
        id: "contact",
        name: "Kontakt",
        type: "relation",
        relationPage: people,
      },
    ],
    views: d.views,
  });
  await command({
    action: "form.update",
    pageId: requests,
    enabled: true,
    internal: true,
    anonymous: false,
  });
  const token = (await read(requests)).form.token;
  await page.goto(`/forms/${token}`);
  await page.getByRole("textbox", { name: "Titel" }).fill("Rückruf");
  await page
    .getByRole("combobox", { name: "Zuständig" })
    .selectOption({ label: boot.user.name });
  await page.getByLabel("Kontakt: Einträge suchen").fill("Ki");
  await page.getByRole("checkbox", { name: "Kim" }).check();
  await page.screenshot({
    path: `test-results/form-internal-verification/${testInfo.project.name}-form.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Antwort senden" }).click();
  await expect(
    page.getByRole("heading", { name: "Vielen Dank!" }),
  ).toBeVisible();
  const [saved] = (await read(requests)).rows;
  expect(saved.cells.owner).toBe(boot.user.id);
  expect(saved.cells.contact).toHaveLength(1);
  expect(errors).toEqual([]);
  for (const id of [requests, people])
    await command({ action: "page.delete", pageId: id });
});
