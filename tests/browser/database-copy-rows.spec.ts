import { test, expect, type Page } from "@playwright/test";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const readClipboard = (page: Page) =>
  page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const text = item.types.includes("text/plain") ? await (await item.getType("text/plain")).text() : "";
    const html = item.types.includes("text/html") ? await (await item.getType("text/html")).text() : "";
    return { text, html };
  });

// Issue #119: selected records go to the clipboard as a table (TSV + HTML)
// for Excel, Numbers or a document.
test("selected records are copied to the clipboard as a table", async ({ page }, info) => {
  test.setTimeout(120_000);
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
  const db = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Kopieren ${info.project.name} ${Date.now()}`,
    kind: "database",
  });
  const initial = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "secret", name: "Versteckt", type: "text" },
      { id: "amount", name: "Betrag", type: "number", format: "eur" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
      { id: "done", name: "Fertig", type: "checkbox" },
      { id: "owner", name: "Person", type: "person" },
    ],
    views: [
      {
        id: "table",
        name: "Tabelle",
        type: "table",
        filters: [],
        sorts: [{ field: "amount", direction: "desc" }],
        hiddenFields: ["secret"],
        fieldOrder: ["title", "status", "amount", "done", "owner", "secret"],
      },
    ],
  });
  const me = boot.user.id;
  await command({ action: "row.create", pageId: db.id, cells: { title: "Miete", secret: "x", amount: 1200, status: "Offen", done: true, owner: me } });
  await command({ action: "row.create", pageId: db.id, cells: { title: "Strom <b> & Gas", secret: "y", amount: 80.5, status: "Erledigt" } });
  await command({ action: "row.create", pageId: db.id, cells: { title: "Nicht ausgewählt", amount: 5 } });

  await page.goto(`/#page=${db.id}`);
  const table = page.locator(".data-table");
  await expect(table).toBeVisible();
  // Selected bottom-up: the clipboard keeps the order of the view.
  await page.getByRole("checkbox", { name: "Strom <b> & Gas auswählen" }).check();
  await page.getByRole("checkbox", { name: "Miete auswählen" }).check();
  const bar = page.getByRole("toolbar", { name: "Ausgewählte Einträge", exact: true });
  await expect(bar).toContainText("2 ausgewählt");
  await bar.getByRole("button", { name: "Kopieren", exact: true }).click();
  await expect(page.getByText("2 Einträge kopiert")).toBeVisible();

  const nbsp = (s: string) => s.replace(/[  ]/g, " ");
  const copied = await readClipboard(page);
  expect(nbsp(copied.text).split("\r\n")).toEqual([
    "Name\tStatus\tBetrag\tFertig\tPerson",
    `Miete\tOffen\t1.200,00 €\tJa\t${boot.user.name}`,
    "Strom <b> & Gas\tErledigt\t80,50 €\tNein\t",
    "",
  ]);
  expect(copied.html).toContain("<thead><tr><th>Name</th><th>Status</th><th>Betrag</th><th>Fertig</th><th>Person</th></tr></thead>");
  expect(copied.html).toContain("<td>Strom &lt;b&gt; &amp; Gas</td>");
  expect(copied.html).not.toContain("Versteckt");
  expect(copied.text).not.toContain("Nicht ausgewählt");

  // ⌘C / Ctrl+C with the selection (the focus on a checkbox) copies too.
  await page.evaluate(() => navigator.clipboard.writeText("leer"));
  await page.getByRole("checkbox", { name: "Miete auswählen" }).uncheck();
  await expect(bar).toContainText("1 ausgewählt");
  await page.keyboard.press("ControlOrMeta+c");
  await expect(page.getByText("1 Eintrag kopiert")).toBeVisible();
  const single = await readClipboard(page);
  expect(nbsp(single.text)).toBe("Name\tStatus\tBetrag\tFertig\tPerson\r\nStrom <b> & Gas\tErledigt\t80,50 €\tNein\t\r\n");

  // Pasted into a document, the HTML becomes a table.
  const doc = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Eingefügt ${Date.now()}`,
    kind: "document",
  });
  await page.goto(`/#page=${doc.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await editor.evaluate((el, c) => {
    const data = new DataTransfer();
    data.setData("text/plain", c.text);
    data.setData("text/html", c.html);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, copied);
  await expect(editor.locator("table th").first()).toHaveText("Name");
  await expect(editor.locator("table tr")).toHaveCount(3);
  await expect(editor.locator("table")).toContainText("Strom <b> & Gas");
  expect(errors).toEqual([]);
});
