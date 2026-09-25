import { test, expect } from "@playwright/test";

test("text gets colours, highlight colours and super/subscript", async ({
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
    title: `Farben ${testInfo.project.name} ${Date.now()}`,
  });
  const html = async () =>
    (await (await page.request.get(`/api/pages/${p.id}`)).json())
      .html as string;
  await page.goto(`/#page=${p.id}`);
  const content = page.getByLabel("Dokumentinhalt", { exact: true });
  await content.click();
  await page.keyboard.type("Wichtig");
  await page.keyboard.press("ControlOrMeta+a");
  const toolbar = page.getByRole("toolbar", { name: "Textformatierung" });
  await toolbar
    .getByRole("button", { name: "Text- und Hintergrundfarbe" })
    .click();
  await page.getByRole("menuitem", { name: "Textfarbe Rot" }).click();
  await expect.poll(html).toMatch(/color: ?#d44c47/);
  // The text stays selected after applying a colour.
  await toolbar
    .getByRole("button", { name: "Text- und Hintergrundfarbe" })
    .click();
  await page.getByRole("menuitem", { name: "Hintergrund Blau" }).click();
  await expect.poll(html).toMatch(/background-color: ?#e7f3f8/);
  await expect(content.locator("span[style*='color']")).toHaveText("Wichtig");
  // Superscript on the last character.
  await content.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" m2");
  await page.keyboard.press("Shift+ArrowLeft");
  await toolbar.getByRole("button", { name: "Hochgestellt" }).click();
  await expect.poll(html).toContain("<sup>2</sup>");
  await page.reload();
  await expect(
    page.getByLabel("Dokumentinhalt", { exact: true }).locator("sup"),
  ).toHaveText("2");
  // Removing colours clears both.
  await page.getByLabel("Dokumentinhalt", { exact: true }).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page
    .getByRole("toolbar", { name: "Textformatierung" })
    .getByRole("button", { name: "Text- und Hintergrundfarbe" })
    .click();
  await page.getByRole("menuitem", { name: "Farben entfernen" }).click();
  await expect.poll(html).not.toMatch(/color/);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
