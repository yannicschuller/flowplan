import { test, expect } from "@playwright/test";

// A line keeps its text when its type changes (heading → text → list → heading).
test("turn a line into another block type from the text menu", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The right-click menu is a desktop action.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Umwandeln ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("# Wichtiger Abschnitt");
  await expect(editor.locator("h1")).toHaveText("Wichtiger Abschnitt");
  const turn = async (name: string) => {
    await editor.getByText("Wichtiger Abschnitt").click({ button: "right" });
    await page.getByRole("group", { name: "Umwandeln in" }).getByRole("menuitemradio", { name: `Umwandeln in ${name}` }).click();
  };
  await turn("Text");
  await expect(editor.locator("h1")).toHaveCount(0);
  await expect(editor.locator("p", { hasText: "Wichtiger Abschnitt" })).toHaveCount(1);
  await turn("Aufzählung");
  await expect(editor.locator("ul li")).toHaveText("Wichtiger Abschnitt");
  await turn("Überschrift 2");
  await expect(editor.locator("ul")).toHaveCount(0);
  await expect(editor.locator("h2")).toHaveText("Wichtiger Abschnitt");
  await editor.getByText("Wichtiger Abschnitt").click({ button: "right" });
  await expect(page.getByRole("menuitemradio", { name: "Umwandeln in Überschrift 2" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${pageId}`)).json()).html, { timeout: 20_000 })
    .toContain("<h2>Wichtiger Abschnitt</h2>");
  expect(errors).toEqual([]);
});
