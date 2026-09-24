import { test, expect } from "@playwright/test";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

test("published databases show their board, gallery and list views", async ({
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
    title: `Öffentlich ${testInfo.project.name} ${Date.now()}`,
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
      {
        id: "status",
        name: "Status",
        type: "select",
        options: ["Offen", "Fertig"],
      },
      { id: "owner", name: "Zuständig", type: "person" },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
      {
        id: "board",
        name: "Board",
        type: "board",
        filters: [],
        sorts: [],
        groupBy: "status",
      },
      {
        id: "gallery",
        name: "Galerie",
        type: "gallery",
        filters: [],
        sorts: [],
        gallery: { cover: "record", fit: "cover", size: "medium" },
      },
      {
        id: "done",
        name: "Nur fertig",
        type: "list",
        filters: [{ field: "status", op: "eq", value: "Fertig" }],
        sorts: [],
      },
    ],
  });
  const a = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Planung", status: "Offen", owner: boot.user.id },
  });
  await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Umsetzung", status: "Fertig" },
  });
  const upload = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: {
      pageId: p.id,
      purpose: "cover",
      file: { name: "c.png", mimeType: "image/png", buffer: png },
    },
  });
  const cover = (await upload.json()).url;
  await command({
    action: "row.appearance",
    pageId: p.id,
    rowId: a.id,
    version: (await read()).rows.find((r: { id: string }) => r.id === a.id)
      .version,
    cover,
  });
  await command({ action: "page.publish", pageId: p.id, enabled: true });
  const token = (await read()).page.public_token;

  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(`${origin}/share/${token}`);
  const views = visitor.getByRole("navigation", { name: "Ansichten" });
  await expect(views.getByRole("link")).toHaveText([
    "Tabelle",
    "Board",
    "Galerie",
    "Nur fertig",
  ]);
  // People stay private in every layout.
  await expect(visitor.locator("body")).not.toContainText(boot.user.name);
  await views.getByRole("link", { name: "Board" }).click();
  await expect(
    visitor.getByRole("region", { name: "Gruppe Offen" }),
  ).toContainText("Planung");
  await expect(
    visitor.getByRole("region", { name: "Gruppe Fertig" }),
  ).toContainText("Umsetzung");
  await views.getByRole("link", { name: "Galerie" }).click();
  await expect(visitor.locator(".public-gallery img")).toHaveCount(1);
  await expect(visitor.locator(".public-gallery img")).toHaveAttribute(
    "src",
    new RegExp(`/api/share/${token}/files/`),
  );
  await visitor.screenshot({
    path: `test-results/public-layouts-verification/${testInfo.project.name}-gallery.png`,
    fullPage: true,
  });
  await views.getByRole("link", { name: "Nur fertig" }).click();
  await expect(visitor.locator(".public-list .record-list-item")).toHaveCount(
    1,
  );
  await visitor.locator(".public-list .record-list-item").click();
  await expect(
    visitor.getByRole("heading", { name: "Umsetzung" }),
  ).toBeVisible();
  await visitorContext.close();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
