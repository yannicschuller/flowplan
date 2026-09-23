import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { readExportZip } from "../helpers/read-export-zip";
async function fixture(page: Page, title: string, kind = "document") {
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
  const create = (title: string, kind = "document", parentId?: string) =>
    command({
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      title,
      kind,
      parentId,
    });
  const host = await create(title, kind);
  const read = async () =>
    (await page.request.get(`/api/pages/${host.id}`)).json();
  return { origin, command, create, host, read };
}
async function openExport(page: Page) {
  await page
    .getByRole("button", { name: "Seitenaktionen", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Exportieren", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Seite exportieren", exact: true });
}
async function download(page: Page, dialog: Locator) {
  const waiting = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Herunterladen", exact: true })
    .click();
  const result = await waiting;
  const path = await result.path();
  expect(path).toBeTruthy();
  return { name: result.suggestedFilename(), bytes: await readFile(path!) };
}
test("Markdown downloads flush pending edits and ZIP exports include children and local attachments", async ({
  page,
}, info) => {
  const f = await fixture(
    page,
    `Markdown editor ${info.project.name} ${Date.now()}`,
  );
  const child = await f.create("Child export", "document", f.host.id);
  const bytes = Buffer.from("Local export attachment\nü");
  const upload = await page.request.post("/api/upload", {
    headers: { origin: f.origin },
    multipart: {
      pageId: child.id,
      file: { name: "notes.txt", mimeType: "text/plain", buffer: bytes },
    },
  });
  expect(upload.ok()).toBe(true);
  const file = await upload.json(),
    childData = await (await page.request.get(`/api/pages/${child.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await f.command({
    action: "document.sync",
    pageId: child.id,
    generation: childData.generation,
    update: Buffer.from(
      htmlState(
        `<h2>Child body</h2><p><a href="${file.url}">Attachment</a><a href="/#page=${f.host.id}">Parent</a></p>`,
      ),
    ).toString("base64"),
  });
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/command", async (route) => {
    const data = route.request().postDataJSON();
    if (data.action === "document.sync" && data.html !== undefined) await gate;
    await route.continue();
  });
  try {
    const pending = page.waitForRequest(
      (req) =>
        req.url().endsWith("/api/command") &&
        req.postDataJSON()?.action === "document.sync" &&
        req.postDataJSON()?.html?.includes("Unsaved export text"),
    );
    await editor.click();
    await page.keyboard.insertText("Unsaved export text");
    await pending;
    expect((await f.read()).html).not.toContain("Unsaved export text");
    const dialog = await openExport(page),
      md = await download(page, dialog);
    expect(md.name).toMatch(/\.md$/);
    expect(md.bytes.toString()).toContain("Unsaved export text");
    expect(md.bytes.toString()).toContain(`/#page=${child.id}`);
    expect((await f.read()).html).toContain("Unsaved export text");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  const dialog = await openExport(page);
  await dialog.getByLabel("Exportformat").selectOption("zip");
  await dialog.getByLabel("Zugängliche Unterseiten einschließen").check();
  await page.screenshot({
    path: `test-results/${info.project.name}-markdown-export.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  const zip = await readExportZip((await download(page, dialog)).bytes);
  const childPath = [...zip.keys()].find((k) => k.startsWith("pages/"))!;
  expect(decodeURIComponent(zip.get("index.md")!.toString())).toContain(
    childPath,
  );
  expect(zip.get(childPath)!.toString()).toContain("../index.md");
  const asset = [...zip.keys()].find((k) => k.startsWith("assets/"))!;
  expect(zip.get(asset)).toEqual(bytes);
  const legacy = await openExport(page);
  await legacy.getByLabel("Exportformat").selectOption("legacy");
  const html = await download(page, legacy);
  expect(html.name).toMatch(/\.html$/);
  expect(html.bytes.toString()).toContain("Unsaved export text");
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});

test("database exports contain records and CSV, report failures, and enforce authenticated same-origin requests", async ({
  page,
  browser,
}, info) => {
  const f = await fixture(
    page,
    `Markdown database ${info.project.name} ${Date.now()}`,
    "database",
  );
  const row = await f.command({
    action: "row.create",
    pageId: f.host.id,
    cells: { title: "Portable record" },
  });
  const record = await (
    await page.request.get(`/api/pages/${f.host.id}/rows/${row.id}`)
  ).json();
  const { htmlState } = await import("../../lib/document-server");
  await f.command({
    action: "row.document.sync",
    pageId: f.host.id,
    rowId: row.id,
    generation: record.generation,
    update: Buffer.from(
      htmlState("<h2>Portable body</h2><p>Record details</p>"),
    ).toString("base64"),
  });
  await page.goto(`/#page=${f.host.id}`);
  let dialog = await openExport(page);
  await expect(dialog).toContainText("unabhängig von Ansichtfiltern");
  await page.route("**/api/markdown-export", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "Eine referenzierte Datei fehlt." }),
    }),
  );
  await dialog
    .getByRole("button", { name: "Herunterladen", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Datei fehlt");
  await expect(
    dialog.getByRole("button", { name: "Herunterladen", exact: true }),
  ).toBeEnabled();
  await page.unrouteAll({ behavior: "wait" });
  await dialog.getByLabel("Exportformat").selectOption("zip");
  const result = await download(page, dialog),
    zip = await readExportZip(result.bytes);
  expect(zip.get(`tables/${f.host.id}.csv`)!.toString()).toContain(
    "Portable record",
  );
  const recordPath = [...zip.keys()].find((k) => k.startsWith("records/"))!;
  expect(zip.get(recordPath)!.toString()).toContain("## Portable body");
  expect(decodeURIComponent(zip.get("index.md")!.toString())).toContain(
    recordPath,
  );
  dialog = await openExport(page);
  const md = await download(page, dialog);
  expect(md.bytes.toString()).toContain("Record details");
  const data = { pageId: f.host.id, format: "markdown" };
  const valid = await page.request.post("/api/markdown-export", {
    headers: { origin: f.origin },
    data,
  });
  expect(valid.headers()["content-type"]).toContain("text/markdown");
  expect(valid.headers()["cache-control"]).toContain("no-store");
  expect(valid.headers()["content-disposition"]).toContain("filename*=UTF-8");
  expect(
    (
      await page.request.post("/api/markdown-export", {
        headers: { origin: "https://untrusted.example" },
        data,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await page.request.post("/api/markdown-export", {
        headers: { origin: f.origin },
        data: { ...data, includeSubpages: true },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await page.request.post("/api/markdown-export", {
        headers: { origin: f.origin },
        data: "x".repeat(17000),
      })
    ).status(),
  ).toBe(413);
  const anonymous = await browser.newContext();
  try {
    expect(
      (
        await anonymous.request.post(`${f.origin}/api/markdown-export`, {
          headers: { origin: f.origin },
          data,
        })
      ).status(),
    ).toBe(401);
  } finally {
    await anonymous.close();
  }
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});
