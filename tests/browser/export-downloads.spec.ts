import { test, expect, type APIRequestContext } from "@playwright/test";
import { readExportZip } from "../helpers/read-export-zip";

// The download routes of the document exports (app/api/export/*) against
// the running server: Word, EPUB and the print view of a page with its
// sub-pages and of a whole space; wrong selections, other people and
// signed-out requests are refused.
test("Word, EPUB and print exports of a page, its sub-pages and a space; others are refused", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "desktop", "Downloads only; one run is enough.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const { htmlState } = await import("../../lib/document-server");
  const tag = `${Date.now()}`;
  // A space of its own: the demo account's first space collects the pages of
  // every spec and soon holds more than one export may take (413).
  const spaceId = (await command({ action: "space.create", workspaceId: boot.workspace.id, name: `Export ${tag}` })).id as string;
  const create = async (title: string, html: string, parentId?: string) => {
    const { id } = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId, title, parentId });
    const data = await (await page.request.get(`/api/pages/${id}`)).json();
    await command({ action: "document.sync", pageId: id, generation: data.generation, update: Buffer.from(htmlState(html)).toString("base64") });
    return id as string;
  };
  const title = `Exportbericht Ä ${tag}`;
  const root = await create(title, `<h2>Einleitung</h2><p>Hauptteil mit Okapi ${tag}</p><ul><li><p>Punkt eins</p></li></ul>`);
  await create(`Anhang ${tag}`, `<p>Unterseite mit Gürteltier ${tag}</p>`, root);
  const get = (request: APIRequestContext, path: string) => request.get(path, { headers: { "Accept-Language": "de-DE" } });

  // Word: one page.
  const docx = await get(page.request, `/api/export/docx?page=${root}`);
  expect(docx.status(), await docx.text()).toBe(200);
  expect(docx.headers()["content-type"]).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  expect(docx.headers()["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent(title).slice(0, 20)}`);
  const word = await readExportZip(Buffer.from(await docx.body()));
  const body = word.get("word/document.xml")!.toString();
  expect(body).toContain(`Hauptteil mit Okapi ${tag}`);
  expect(body).toContain("Punkt eins");

  // EPUB: the page with its sub-page, the mimetype first and stored.
  const epub = await get(page.request, `/api/export/epub?page=${root}&children=1`);
  expect(epub.status(), await epub.text()).toBe(200);
  expect(epub.headers()["content-type"]).toBe("application/epub+zip");
  const bytes = Buffer.from(await epub.body());
  expect(bytes.subarray(30, 38).toString()).toBe("mimetype");
  const book = await readExportZip(bytes);
  expect(book.get("mimetype")!.toString()).toBe("application/epub+zip");
  const chapters = [...book.entries()].filter(([name]) => name.endsWith(".xhtml")).map(([, b]) => b.toString()).join("\n");
  expect(chapters).toContain(`Hauptteil mit Okapi ${tag}`);
  expect(chapters).toContain(`Unterseite mit Gürteltier ${tag}`);

  // Print view: with sub-pages, without scripts; a whole space.
  const print = await get(page.request, `/api/export/pdf?page=${root}&children=1`);
  expect(print.status()).toBe(200);
  expect(print.headers()["content-type"]).toBe("text/html; charset=utf-8");
  expect(print.headers()["content-security-policy"]).toContain("default-src 'none'");
  const html = await print.text();
  expect(html).toContain(`Hauptteil mit Okapi ${tag}`);
  expect(html).toContain(`Unterseite mit Gürteltier ${tag}`);
  expect(html).not.toContain("<script");
  const withoutChildren = await (await get(page.request, `/api/export/pdf?page=${root}`)).text();
  expect(withoutChildren).not.toContain(`Unterseite mit Gürteltier ${tag}`);
  const space = await get(page.request, `/api/export/pdf?space=${spaceId}`);
  expect(space.status()).toBe(200);
  expect(await space.text()).toContain(`Hauptteil mit Okapi ${tag}`);

  // Wrong selections.
  for (const query of ["", `page=${root}&space=${spaceId}`, "page=kein-uuid"]) {
    const refused = await get(page.request, `/api/export/epub?${query}`);
    expect(refused.status(), query).toBe(400);
    expect((await refused.json()).error).toBeTruthy();
  }
  // Signed out, and someone without access.
  const anonymous = await browser.newContext();
  expect((await get(anonymous.request, `/api/export/docx?page=${root}`)).status()).toBe(401);
  await anonymous.close();
  if (process.env.TEST_OTHER_EMAIL) {
    const other = await browser.newContext();
    await other.request.post("/api/auth/password", { headers: { origin }, data: { email: process.env.TEST_OTHER_EMAIL, password: process.env.TEST_OTHER_PASSWORD } });
    for (const kind of ["docx", "epub", "pdf"]) expect([403, 404], kind).toContain((await get(other.request, `/api/export/${kind}?page=${root}`)).status());
    expect([403, 404]).toContain((await get(other.request, `/api/export/pdf?space=${spaceId}`)).status());
    await other.close();
  }
});
