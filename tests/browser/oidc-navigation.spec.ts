import { test, expect } from "@playwright/test";
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
test("OIDC callback preserves an internal row thread and rejects external return paths", async ({
  page,
}) => {
  test.skip(
    process.env.FLOWPLAN_TEST_OIDC !== "true",
    "Requires the local oidc-navigation-provider fixture and its configured dev server.",
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("link", { name: "Mit SSO anmelden" }).click();
  await expect(page.locator(".workspace-switch")).toContainText(
    "Mein Arbeitsbereich",
  );
  await expect(
    page.getByRole("button", { name: /Eine Idee festhalten/ }),
  ).toBeEnabled();
  const boot = await (await page.request.get("/api/bootstrap")).json();
  expect(boot.user.isAdmin).toBe(true);
  async function command(data: Record<string, unknown>) {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  const database = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: "OIDC return database",
    kind: "database",
  });
  const row = await command({
    action: "row.create",
    pageId: database.id,
    cells: { title: "OIDC return entry" },
  });
  await page.goto(`/#page=${database.id}&row=${row.id}`);
  await expect(page).toHaveURL(`${origin}/#page=${database.id}&row=${row.id}`);
  await expect(page.locator(".tiptap")).toBeVisible();
  await page.locator(".tiptap").click();
  await page.keyboard.type("Return to this text after SSO");
  await page
    .getByRole("button", { name: "Text kommentieren", exact: true })
    .click();
  await page
    .getByLabel("Kommentar zur Textstelle", { exact: true })
    .fill("Preserved OIDC destination");
  await page
    .getByRole("button", { name: "Kommentar senden", exact: true })
    .click();
  await expect(page.locator(".inline-comment-message")).toContainText(
    "Preserved OIDC destination",
  );
  const [thread] = await (
    await page.request.get(`/api/threads?page=${database.id}&row=${row.id}`)
  ).json();
  const target = `/#page=${database.id}&row=${row.id}&thread=${thread.id}`;
  await page.request.post("/api/auth/logout", { headers: { origin } });
  await page.goto("about:blank");
  await page.goto(target);
  const link = page.getByRole("link", { name: "Mit SSO anmelden" });
  await expect(link).toHaveAttribute(
    "href",
    `/api/auth/login?returnTo=${encodeURIComponent(target)}`,
  );
  await link.click();
  await expect(page).toHaveURL(`${origin}${target}`);
  await expect(page.locator(".inline-comment-message")).toContainText(
    "Preserved OIDC destination",
  );
  await page.request.post("/api/auth/logout", { headers: { origin } });
  await page.goto(
    `/api/auth/login?returnTo=${encodeURIComponent("https://evil.test/steal")}`,
  );
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.locator(".workspace-switch")).toContainText(
    "Mein Arbeitsbereich",
  );
  expect(errors).toEqual([]);
});
