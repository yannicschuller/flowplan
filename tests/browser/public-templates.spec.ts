import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

test("visitors browse the public template gallery and use a template after signing in", async ({
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
  const name = `Retro ${testInfo.project.name} ${Date.now()}`;
  const source = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: name,
  });
  const { htmlState } = await import("../../lib/document-server");
  const generation = (
    await (await page.request.get(`/api/pages/${source.id}`)).json()
  ).generation;
  await command({
    action: "document.sync",
    pageId: source.id,
    generation,
    update: Buffer.from(htmlState("<p>Was lief gut?</p>")).toString("base64"),
  });
  const template = await command({
    action: "template.save",
    pageId: source.id,
    name,
    category: "meetings",
  });
  // Publishing is an admin action; the test sets it directly.
  const db = new DatabaseSync(
    join(
      process.env.FLOWPLAN_DATA_DIR || join(process.cwd(), "data"),
      "flowplan.sqlite",
    ),
  );
  db.prepare("UPDATE templates SET visibility='public' WHERE id=?").run(
    template.id,
  );
  db.close();

  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(`${origin}/templates?category=meetings`);
  const card = visitor.getByRole("link", { name: new RegExp(name) });
  await expect(card).toBeVisible();
  await card.click();
  await expect(visitor.getByRole("heading", { name })).toBeVisible();
  await expect(visitor.locator(".document-editor")).toContainText(
    "Was lief gut?",
  );
  await visitorContext.close();

  // Signed in, the same link creates the page in the workspace.
  await page.goto(`/?useTemplate=${template.id}`);
  await expect(
    page.getByLabel("Dokumentinhalt", { exact: true }),
  ).toContainText("Was lief gut?");
  await expect(page).toHaveURL(/#page=/);
  expect(page.url()).not.toContain("useTemplate");
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: source.id });
});
