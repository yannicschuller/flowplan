import { test, expect } from "@playwright/test";

test("forms ask with long text, choice buttons and a linear scale", async ({
  page,
  browser,
}, testInfo) => {
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
    title: `Umfrage ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  await command({
    action: "database.update",
    pageId: p.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "note", name: "Nachricht", type: "text" },
      {
        id: "topic",
        name: "Thema",
        type: "select",
        options: ["Lob", "Kritik"],
      },
      { id: "score", name: "Zufriedenheit", type: "number" },
    ],
    views: (await read()).database.views,
  });
  // Question types as stored by the form editor.
  await page.goto(`/#page=${p.id}`);
  await command({
    action: "form.update",
    pageId: p.id,
    enabled: true,
    internal: false,
    anonymous: true,
    config: {
      questionStyles: { note: "long", topic: "buttons", score: "scale" },
    },
  });
  const token = (await read()).form.token;
  const visitor = await browser.newContext();
  const form = await visitor.newPage();
  await form.goto(`${origin}/forms/${token}`);
  await form.getByRole("textbox", { name: "Name" }).fill("Kim");
  const note = form.locator("textarea[aria-label='Nachricht']");
  await note.fill("Erste Zeile\nZweite Zeile");
  await form
    .getByRole("radiogroup", { name: "Thema" })
    .getByLabel("Kritik")
    .check();
  await form
    .getByRole("radiogroup", { name: "Zufriedenheit" })
    .getByRole("radio", { name: "Zufriedenheit: 8" })
    .click();
  await form.getByRole("button", { name: "Antwort senden" }).click();
  await expect(
    form.getByRole("heading", { name: "Vielen Dank!" }),
  ).toBeVisible();
  await visitor.close();
  const [row] = (await read()).rows;
  expect(row.cells).toMatchObject({
    title: "Kim",
    note: "Erste Zeile\nZweite Zeile",
    topic: "Kritik",
    score: 8,
  });
  await command({ action: "page.delete", pageId: p.id });
});
