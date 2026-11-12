import { test, expect } from "@playwright/test";

test("⌘K runs commands; focus mode counts words towards a goal", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const pageId = (
    await (
      await page.request.post("/api/command", {
        headers: { origin },
        data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Fokus ${info.project.name} ${Date.now()}`, kind: "document" },
      })
    ).json()
  ).id;
  await page.goto("/#home");
  // The shortcut works once the app is running.
  await expect(page.locator(".recent-section")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByLabel("Suchen oder Befehl");
  await input.fill("> aufgaben");
  await expect(page.locator(".command-actions")).toContainText("Meine Aufgaben");
  await input.press("Enter");
  await expect(page.getByRole("heading", { name: "Meine Aufgaben" })).toBeVisible();

  // Page commands only while a page is open.
  await page.goto(`/#page=${pageId}`);
  await page.getByLabel("Dokumentinhalt", { exact: true }).click();
  await page.keyboard.type("Eins zwei drei vier fünf");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Suchen oder Befehl").fill(">fokus");
  await page.getByLabel("Suchen oder Befehl").press("Enter");
  const bar = page.getByRole("status", { name: "Fokusmodus" });
  await expect(bar).toContainText("5 Wörter");
  await expect(page.locator(".sidebar")).toBeHidden();
  await bar.getByLabel("Wortziel").fill("10");
  await page.getByLabel("Dokumentinhalt", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" sechs sieben acht neun zehn");
  await expect(bar).toContainText("Ziel erreicht");
  await bar.getByRole("button", { name: "Fokusmodus beenden" }).click();
  await expect(bar).toHaveCount(0);
  if (info.project.name === "desktop") await expect(page.locator(".sidebar")).toBeVisible();
  expect(errors).toEqual([]);
});

// An emoji icon keeps its icon slot (#227): `.palette-option > span` (the
// title) also matched PageIcon's span.page-emoji, so the emoji took half of
// the row and pushed its title to the right – in the hits and in "Recently
// viewed" alike.
test("⌘K: hits with an emoji icon line their title up with the others", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same list on phones.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const stamp = `Zebrafisch${Date.now()}`;
  const create = (title: string) =>
    command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" });
  const rocket = await create(`${stamp} Rakete`);
  await command({ action: "page.update", pageId: rocket.id, patch: { icon: "🚀" } });
  const plain = await create(`${stamp} Ohne`);
  const titleLefts = () =>
    page.locator(".palette-option").evaluateAll((options, stamp) =>
      options
        .filter((o) => o.textContent?.includes(stamp))
        .map((o) => {
          const icon = o.firstElementChild!.getBoundingClientRect();
          const title = [...o.children].find((c) => c.tagName === "SPAN" && !c.classList.contains("page-emoji"))!;
          return { icon: Math.round(icon.width), title: Math.round(title.getBoundingClientRect().left) };
        }),
    stamp);
  // Hits.
  await page.goto("/#home");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Suchen oder Befehl").fill(stamp);
  // Both icons 18 px wide, both titles at the same x (polled: the palette
  // scales in when it opens).
  const lined = { icons: [18, 18], same: true };
  const lineup = async () => {
    const rows = await titleLefts();
    return { icons: rows.map((r) => r.icon), same: rows.length === 2 && rows[0].title === rows[1].title };
  };
  await expect.poll(lineup, { timeout: 15_000 }).toEqual(lined);
  // Recently viewed (an empty query).
  await page.keyboard.press("Escape");
  await page.goto(`/#page=${rocket.id}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.goto(`/#page=${plain.id}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("#palette-recent-title")).toBeVisible();
  await expect.poll(lineup).toEqual(lined);
  await page.keyboard.press("Escape");
  for (const p of [rocket, plain]) await command({ action: "page.delete", pageId: p.id });
});
