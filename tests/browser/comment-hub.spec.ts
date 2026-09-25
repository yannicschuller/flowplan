import { test, expect } from "@playwright/test";

test("page, guest and text comments share one list with filters", async ({
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
    title: `Kommentare ${testInfo.project.name} ${Date.now()}`,
  });
  await command({
    action: "comment.create",
    pageId: p.id,
    body: "Allgemeine Rückmeldung",
  });
  const link = await command({
    action: "share.create",
    pageId: p.id,
    role: "commenter",
    name: "Feedback",
  });
  const shared = await page.request.post(`/api/share/${link.token}`, {
    headers: { origin },
    data: { action: "comment", pageId: p.id, name: "Gast", body: "Von außen" },
  });
  expect(shared.ok(), await shared.text()).toBe(true);

  await page.goto(`/#page=${p.id}`);
  const content = page.getByLabel("Dokumentinhalt", { exact: true });
  await content.click();
  await page.keyboard.type("Diese Zahl prüfen");
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Text kommentieren" }).click();
  await page.getByRole("textbox", { name: "Kommentar zur Textstelle" }).click();
  await page.keyboard.type("Stimmt das?");
  await page.getByRole("button", { name: "Kommentar senden" }).click();
  await page.getByRole("button", { name: "Textkommentare schließen" }).click();

  await page.getByTitle("Kommentare", { exact: true }).click();
  const panel = page.locator(".comments-panel");
  const kinds = panel.getByRole("group", { name: "Art der Kommentare" });
  await expect(kinds.getByRole("button", { name: "Alle (3)" })).toBeVisible();
  await expect(panel).toContainText("Allgemeine Rückmeldung");
  await expect(panel).toContainText("Von außen");
  const text = panel.getByRole("group", {
    name: "Textkommentar zu „Diese Zahl prüfen“",
  });
  await expect(text).toContainText("Stimmt das?");
  // Filter by kind.
  await kinds.getByRole("button", { name: "Textstellen (1)" }).click();
  await expect(panel).not.toContainText("Allgemeine Rückmeldung");
  await expect(text).toBeVisible();
  await kinds.getByRole("button", { name: "Seite (2)" }).click();
  await expect(text).toHaveCount(0);
  await kinds.getByRole("button", { name: "Alle (3)" }).click();
  // Opening the text comment shows its thread at the marked text.
  await text.getByRole("link", { name: /Zur Textstelle/ }).click();
  await expect(page).toHaveURL(/thread=/);
  await expect(
    page.getByRole("region", { name: "Textkommentare" }),
  ).toContainText("Stimmt das?");
  // Resolving a text comment moves it to the resolved filter.
  await text.getByRole("button", { name: "Als erledigt markieren" }).click();
  await expect(text).toHaveCount(0);
  await expect(kinds.getByRole("button", { name: "Alle (2)" })).toBeVisible();
  await panel.getByLabel("Status der Kommentare").selectOption("resolved");
  await expect(text).toBeVisible();
  await page.screenshot({
    path: `test-results/comment-hub/${testInfo.project.name}.png`,
  });
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
