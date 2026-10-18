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

// Records take part like pages: mentions of their title, a dot in the graph,
// and link texts that follow a rename (issue #22).
test("records have unlinked mentions, a dot in the graph and link texts that follow renames", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers it.");
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
  const stamp = String(Date.now());
  const page_ = (title: string, kind: string) =>
    command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind });
  const database = (await page_(`Kunden ${stamp}`, "database")).id;
  const source = (await page_(`Besuche ${stamp}`, "document")).id;
  const title = `Kundin ${stamp}`;
  const record = (await command({ action: "row.create", pageId: database, cells: { title } })).id;
  const html = async () => (await (await page.request.get(`/api/pages/${source}`)).json()).html as string;
  await page.goto(`/#page=${source}`);
  await page.locator(".ProseMirror").first().click();
  await page.keyboard.type(`Besuch bei ${title} am Montag.`);
  await expect.poll(html, { timeout: 15000 }).toContain(title);

  await page.goto("about:blank");
  await page.goto(`/#page=${database}&row=${record}`);
  const section = page.locator(".unlinked-mentions");
  await section.getByRole("button", { name: /Nicht verlinkte Erwähnungen/ }).click();
  await expect(section).toContainText(`Besuche ${stamp}`);
  await section.getByRole("button", { name: "Verlinken" }).click();
  await expect(section).toHaveCount(0);
  expect(await html()).toContain(`row=${record}`);

  await page.goto("about:blank");
  await page.goto("/#graph");
  const node = page.getByRole("img", { name: /Graph mit/ }).getByRole("link", { name: `${title} · Kunden ${stamp}` });
  await expect(node).toBeAttached();
  await node.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`row=${record}`));

  const rows = (await (await page.request.get(`/api/pages/${database}`)).json()).rows as { id: string; version: number }[];
  await command({ action: "row.update", pageId: database, rowId: record, version: rows.find((r) => r.id === record)!.version, cells: { title: `Kundin ${stamp} GmbH` } });
  expect(await html()).toContain(`>Kundin ${stamp} GmbH</a>`);
  expect(errors).toEqual([]);
});
