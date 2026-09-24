import { test, expect } from "@playwright/test";

test("public forms accept file uploads, enforce limits and ignore injected file references", async ({
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Bewerbung ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "cv", name: "Lebenslauf", type: "files" },
    ],
    views: initial.database.views,
  });
  await command({
    action: "form.update",
    pageId: p.id,
    enabled: true,
    internal: false,
    anonymous: true,
  });
  const token = (await read()).form.token;

  // An anonymous visitor fills in the form.
  const visitor = await browser.newContext(
    testInfo.project.name === "mobile"
      ? {
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
        }
      : {},
  );
  const form = await visitor.newPage();
  await form.goto(`${origin}/forms/${token}`);
  await form.getByRole("textbox", { name: "Name" }).fill("Kim");
  const group = form.getByRole("group", { name: "Lebenslauf", exact: true });
  await group.getByLabel("Lebenslauf: Dateien auswählen").setInputFiles([
    {
      name: "cv.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 cv"),
    },
    {
      name: "zeugnis.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 z"),
    },
  ]);
  await expect(group.getByRole("listitem")).toHaveCount(2);
  await group.getByRole("button", { name: "zeugnis.pdf entfernen" }).click();
  await expect(group.getByRole("listitem")).toHaveCount(1);
  await form.screenshot({
    path: `test-results/form-files-verification/${testInfo.project.name}-form.png`,
    fullPage: true,
  });
  await form.getByRole("button", { name: "Antwort senden" }).click();
  await expect(
    form.getByRole("heading", { name: "Vielen Dank!" }),
  ).toBeVisible();

  const rows = (await read()).rows;
  expect(rows).toHaveLength(1);
  const urls = rows[0].cells.cv as string[];
  expect(urls).toHaveLength(1);
  const file = await page.request.get(urls[0]);
  expect(file.ok()).toBe(true);
  expect(await file.text()).toBe("%PDF-1.4 cv");
  // Visitors cannot read the upload afterwards.
  expect((await visitor.request.get(`${origin}${urls[0]}`)).ok()).toBe(false);

  // Injected references and oversized uploads are rejected or dropped.
  const injected = await visitor.request.post(`${origin}/api/forms/${token}`, {
    headers: { origin },
    data: { cells: { title: "Mallory", cv: urls } },
  });
  expect(injected.ok()).toBe(true);
  const mallory = (await read()).rows.find(
    (r: { cells: { title: string } }) => r.cells.title === "Mallory",
  );
  expect(mallory.cells.cv).toBeUndefined();
  const tooBig = await visitor.request.post(`${origin}/api/forms/${token}`, {
    headers: { origin },
    multipart: {
      payload: JSON.stringify({ cells: { title: "Big" } }),
      "file:cv": {
        name: "big.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
      },
    },
  });
  expect(tooBig.status()).toBe(413);
  expect(
    (await read()).rows.some(
      (r: { cells: { title: string } }) => r.cells.title === "Big",
    ),
  ).toBe(false);
  await visitor.close();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
