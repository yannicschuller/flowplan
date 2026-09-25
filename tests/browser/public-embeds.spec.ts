import { test, expect } from "@playwright/test";

test("published pages show linked views of published databases", async ({
  page,
  browser,
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
  const host = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Projektübersicht ${tag}`,
  });
  const tasks = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    parentId: host.id,
    title: `Aufgaben ${tag}`,
    kind: "database",
  });
  await command({
    action: "row.create",
    pageId: tasks.id,
    cells: { title: `Konzept ${tag}` },
  });
  await page.goto(`/#page=${host.id}`);
  await page.getByLabel("Dokumentinhalt", { exact: true }).click();
  await page
    .getByRole("button", { name: "Block hinzufügen", exact: true })
    .click();
  await page.getByRole("button", { name: /^Verknüpfte Datenbank/ }).click();
  const picker = page.getByRole("dialog", { name: "Datenbank verknüpfen" });
  await picker.getByLabel("Datenquelle suchen").fill(`Aufgaben ${tag}`);
  await picker
    .getByRole("button", { name: `Aufgaben ${tag}`, exact: true })
    .click();
  await expect(page.locator(".linked-database .data-table")).toContainText(
    `Konzept ${tag}`,
  );
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/pages/${host.id}`)).json()).html,
    )
    .toContain(`data-linked-source="${tasks.id}"`);
  await command({
    action: "page.publish",
    pageId: host.id,
    enabled: true,
    includeChildren: true,
  });
  const token = (await (await page.request.get(`/api/pages/${host.id}`)).json())
    .page.public_token;
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(`${origin}/share/${token}`);
  const embed = visitor.locator(".public-embed");
  await expect(embed).toContainText(`Aufgaben ${tag}`);
  await embed.getByRole("link", { name: `Konzept ${tag}` }).click();
  await expect(
    visitor.getByRole("heading", { name: `Konzept ${tag}` }),
  ).toBeVisible();
  await visitorContext.close();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: host.id });
});
