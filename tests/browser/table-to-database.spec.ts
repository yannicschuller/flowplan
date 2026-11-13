import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

// "In Datenbank umwandeln" (#118): a table of a document becomes a database
// below it, shown in the table's place; undo brings the table back.
const shots = process.env.TABLE_DB_SCREENSHOTS;

async function fixture(page: Page, suffix: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Tabellen ${suffix}`,
    kind: "document",
  });
  const read = async (pid: string) => (await page.request.get(`/api/pages/${pid}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  const html =
    "<h2>Projektliste</h2><p>Davor.</p>" +
    "<table><tbody>" +
    "<tr><th><p>Aufgabe</p></th><th><p>Stunden</p></th><th><p>Fällig</p></th><th><p>Erledigt</p></th><th><p>Link</p></th><th><p>Stunden</p></th></tr>" +
    '<tr><td><p><strong>Lesen</strong></p></td><td><p>1,5</p></td><td><p>04.11.2026</p></td><td><p>ja</p></td><td><p><a href="https://spec.example.test">Spec</a></p></td><td><p>eins</p></td></tr>' +
    "<tr><td><p>Schreiben</p></td><td><p>2</p></td><td><p>2026-12-01</p></td><td><p>nein</p></td><td><p>https://two.example.test</p></td><td><p></p></td></tr>" +
    "</tbody></table><p>Danach.</p>";
  await command({
    action: "document.sync",
    pageId: host.id,
    generation: (await read(host.id)).generation,
    update: Buffer.from(htmlState(html)).toString("base64"),
  });
  return { host, read, boot };
}

test("a table turns into a database below the document; undo brings the table back", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `${info.project.name} ${Date.now()}`);
  await page.goto(`/#page=${f.host.id}`);
  const skip = page.getByRole("button", { name: "Überspringen" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const table = editor.locator(".tableWrapper");
  await expect(table).toHaveCount(1);
  await editor.locator("td", { hasText: "Schreiben" }).click();
  // The row's handle (#240) opens its menu with the table's commands.
  const handle = page.locator(".table-handle.row");
  await expect(handle).toBeVisible();
  await handle.click();
  const item = page.getByRole("menuitem", { name: "In Datenbank umwandeln", exact: true });
  await expect(item).toBeVisible();
  if (shots) {
    mkdirSync(shots, { recursive: true });
    // The menu has faded in.
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/before-${info.project.name}.png` });
  }
  await item.click();

  // The embed takes the table's place, between the paragraphs around it.
  const embed = editor.locator(".linked-database");
  await expect(embed).toHaveCount(1);
  await expect(table).toHaveCount(0);
  await expect(embed.locator(".title-cell")).toHaveText(["Lesen", "Schreiben"]);
  await expect(embed.locator(".linked-database-header a")).toContainText("Projektliste");
  const toast = page.locator(".toast").filter({ hasText: "Tabelle in Datenbank umgewandelt" });
  await expect(toast).toBeVisible();
  await expect(toast.getByRole("button", { name: "Datenbank öffnen" })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/after-${info.project.name}.png` });

  // The database: a sub-page of the document with typed properties.
  const boot = await (await page.request.get(`/api/bootstrap?workspace=${f.boot.workspace.id}`)).json();
  const created = (boot.pages as { id: string; parent_id: string; kind: string; title: string; space_id: string }[]).filter(
    (p) => p.parent_id === f.host.id && p.kind === "database",
  );
  expect(created).toHaveLength(1);
  expect(created[0].title).toBe("Projektliste");
  expect(created[0].space_id).toBe(f.boot.spaces[0].id);
  const data = await f.read(created[0].id);
  expect(data.database.fields.map((x: { name: string; type: string }) => [x.name, x.type])).toEqual([
    ["Aufgabe", "text"],
    ["Stunden", "number"],
    ["Fällig", "date"],
    ["Erledigt", "checkbox"],
    ["Link", "url"],
    ["Stunden 2", "text"],
  ]);
  expect(data.database.views.map((v: { type: string }) => v.type)).toEqual(["table"]);
  const rows = (data.rows as { cells: Record<string, unknown> }[]).map((r) => r.cells);
  expect(rows).toEqual([
    { title: "Lesen", f1: 1.5, f2: "2026-11-04", f3: true, f4: "https://spec.example.test", f5: "eins" },
    { title: "Schreiben", f1: 2, f2: "2026-12-01", f3: false, f4: "https://two.example.test" },
  ]);
  // The document stores the embed (the server opens it by its block id).
  await expect
    .poll(async () => (await f.read(f.host.id)).html as string, { timeout: 10000 })
    .toContain(`data-linked-source="${created[0].id}"`);

  // Undo: the table is back, the database stays.
  await editor.locator("p", { hasText: "Danach." }).click();
  await page.keyboard.press("Control+z");
  await expect(table).toHaveCount(1);
  await expect(embed).toHaveCount(0);
  await expect(table.locator("td").first()).toHaveText("Lesen");
  expect((await f.read(created[0].id)).page.deleted_at).toBeNull();
  expect(errors).toEqual([]);
});
