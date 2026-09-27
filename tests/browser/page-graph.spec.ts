import { test, expect } from "@playwright/test";

test("the graph shows linked pages; unlinked mentions become links", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const stamp = `${info.project.name} ${Date.now()}`;
  const create = async (title: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" })).id;
  const target = await create(`Zielseite ${stamp}`);
  const source = await create(`Quelle ${stamp}`);
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${source}`)).json()).generation;
  await command({
    action: "document.sync",
    pageId: source,
    generation,
    update: Buffer.from(htmlState(`<p>Mehr dazu auf der zielseite ${stamp.toLowerCase()} demnächst.</p>`)).toString("base64"),
  });

  await page.goto(`/#page=${target}`);
  const section = page.locator(".unlinked-mentions");
  await section.getByRole("button", { name: /Nicht verlinkte Erwähnungen/ }).click();
  await expect(section).toContainText(`Quelle ${stamp}`);
  await section.getByRole("button", { name: "Verlinken" }).click();
  await expect(section).toHaveCount(0);
  await expect(page.locator(".backlinks")).toContainText(`Quelle ${stamp}`);

  await page.goto("/#graph");
  const canvas = page.getByRole("img", { name: /Graph mit/ });
  await expect(canvas).toBeVisible();
  const node = canvas.getByRole("link", { name: `Zielseite ${stamp}` });
  await expect(node).toBeAttached();
  await page.getByLabel("Seiten im Graph hervorheben").fill(`Zielseite ${stamp}`);
  await expect(node).toHaveClass(/match/);
  await node.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".page-title")).toHaveValue(`Zielseite ${stamp}`);
  expect(errors).toEqual([]);
});
