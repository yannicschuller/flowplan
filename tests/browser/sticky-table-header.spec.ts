import { test, expect, type Page } from "@playwright/test";

// #287: the header row of a table view stays at the top while the page (or
// the document the database sits in) scrolls down, aligned with the columns
// below it – also scrolled sideways – and leaves together with the table.
// The table scrolls sideways in its own scroller, so the header cells are
// moved down (components/sticky-table-head.ts) instead of `position: sticky`.
const shots = process.env.STICKY_SHOTS;
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

// The pages a test created, deleted afterwards: the demo workspace is
// shared with the other specs.
let created: string[] = [];
test.afterEach(async ({ page }) => {
  for (const pageId of created.reverse())
    await page.request.post("/api/command", { headers: { origin }, data: { action: "page.delete", pageId } });
  created = [];
});

async function fixture(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
  });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const read = async (id: string) => (await page.request.get(`/api/pages/${id}`)).json();
  const create = async (kind: string, title: string) => {
    const id = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `${title} ${Date.now()}`, kind })).id as string;
    created.push(id);
    return id;
  };
  // A database of 80 rows, wider than the screen.
  const database = async (rows = 80) => {
    const id = await create("database", "Sticky-Kopf Daten");
    const letters = ["a", "b", "c", "d", "e", "f", "g", "h"];
    await command({
      action: "database.update",
      pageId: id,
      version: (await read(id)).database.version,
      fields: [{ id: "title", name: "Name", type: "text" }, ...letters.map((l) => ({ id: l, name: `Spalte ${l.toUpperCase()}`, type: "text" }))],
      views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [], columnWidths: { title: 260 } }],
    });
    for (let i = 1; i <= rows; i++)
      await command({
        action: "row.create",
        pageId: id,
        cells: Object.fromEntries([["title", `Eintrag ${i}`], ...letters.map((l) => [l, `${l.toUpperCase()}${i}`])]),
      });
    return id;
  };
  return { command, read, create, database };
}

// Where the header sits against the body: the column "Spalte C" in the
// header and in a row in view, the pinned title, the table and the line
// it should stick to (the pane's top, below a stuck formatting toolbar).
async function measure(page: Page, root: string) {
  // Two frames: the scroll event, then the frame that moves the header.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate((root) => {
    const scope = document.querySelector(root)!;
    const table = scope.querySelector<HTMLTableElement>("table.configurable-table")!;
    const main = document.querySelector<HTMLElement>(".main-scroll")!.getBoundingClientRect();
    const head = table.querySelector<HTMLElement>('thead th[data-field-id="c"]')!.getBoundingClientRect();
    const title = table.querySelector<HTMLElement>('thead th[data-field-id="title"]')!.getBoundingClientRect();
    const rows = [...table.querySelectorAll<HTMLElement>("tbody tr")];
    const below = rows.find((tr) => tr.getBoundingClientRect().top > head.bottom + 4) ?? rows[rows.length - 1];
    const columns = [...table.querySelector("thead tr")!.children].map((th) => th.getAttribute("data-field-id"));
    const index = columns.indexOf("c");
    const cell = below.children[index].getBoundingClientRect();
    let line = main.top;
    for (const bar of document.querySelectorAll<HTMLElement>(".editor-toolbar")) {
      const r = bar.getBoundingClientRect();
      if (r.height && r.top <= line + 12 && r.bottom > line) line = r.bottom;
    }
    const box = table.getBoundingClientRect();
    const foot = table.tFoot!.getBoundingClientRect();
    return {
      line,
      head: { top: head.top, bottom: head.bottom, left: head.left, width: head.width },
      cell: { left: cell.left, width: cell.width },
      title: title.left,
      // The pinned title in the row below, and the scroller's left edge.
      titleCell: below.children[columns.indexOf("title")].getBoundingClientRect().left,
      scrollerLeft: table.parentElement!.getBoundingClientRect().left,
      table: { top: box.top, bottom: box.bottom },
      footTop: foot.top,
      stuck: table.tHead!.hasAttribute("data-stuck"),
      // What a click on the pinned title in the header reaches: the header
      // itself, not a row scrolled under it.
      onTop:
        document.elementFromPoint(title.left + 40, title.top + title.height / 2)?.closest("th") ===
        table.querySelector('thead th[data-field-id="title"]'),
    };
  }, root);
}

test("full page: the header row sticks to the top, stays aligned sideways and opens its menu", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { database } = await fixture(page);
  const id = await database();
  await page.goto(`/#page=${id}`);
  await expect(page.locator("tbody tr")).toHaveCount(80);
  const main = page.locator(".main-scroll");
  const scroller = page.locator(".data-table-scroll");

  // Unscrolled nothing moves (the visual baselines).
  let m = await measure(page, "body");
  expect(m.stuck).toBe(false);
  expect(await page.locator("thead th").first().evaluate((el) => getComputedStyle(el).transform)).toBe("none");
  const restingTop = m.head.top;

  await main.evaluate((el) => el.scrollBy(0, 1200));
  m = await measure(page, "body");
  expect(m.stuck).toBe(true);
  expect(Math.abs(m.head.top - m.line)).toBeLessThan(1.5);
  expect(Math.abs(m.head.left - m.cell.left)).toBeLessThan(1);
  expect(Math.abs(m.head.width - m.cell.width)).toBeLessThan(1);
  expect(m.onTop).toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/${info.project.name}-full-page.png` });

  // Sideways: header and body move together, the pinned title stays at the
  // scroller's left edge – in the header too.
  await scroller.evaluate((el) => (el.scrollLeft = 260));
  m = await measure(page, "body");
  expect(Math.abs(m.head.top - m.line)).toBeLessThan(1.5);
  expect(Math.abs(m.head.left - m.cell.left)).toBeLessThan(1);
  expect(Math.abs(m.title - m.titleCell)).toBeLessThan(1);
  // Pinned: at the left edge, after the selection column where that is pinned too.
  expect(m.title - m.scrollerLeft).toBeGreaterThan(-1);
  expect(m.title - m.scrollerLeft).toBeLessThan(80);
  if (shots) await page.screenshot({ path: `${shots}/${info.project.name}-full-page-sideways.png` });

  // The header's menu (property settings) opens while it is stuck.
  await page.locator('thead th[data-field-id="c"] > button').click();
  const dialog = page.getByRole("dialog", { name: "Eigenschaft bearbeiten", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Eigenschaftsname", { exact: true })).toHaveValue("Spalte C");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // At the end of the page the header stops above the calculation row.
  await main.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  m = await measure(page, "body");
  expect(m.head.bottom).toBeLessThanOrEqual(m.footTop + 1);
  expect(m.head.top).toBeGreaterThanOrEqual(m.table.top - 1);

  // Back at the top: in place again.
  await main.evaluate((el) => el.scrollTo(0, 0));
  m = await measure(page, "body");
  expect(m.stuck).toBe(false);
  expect(Math.abs(m.head.top - restingTop)).toBeLessThan(1);
  expect(errors).toEqual([]);
});

test("inline in a document: the header sticks while the table is in view and leaves with it", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, read, create, database } = await fixture(page);
  const source = await database();
  const host = await create("document", "Übersicht");
  const { htmlState, escaped } = await import("../../lib/document-server");
  const views = (await read(source)).database.views;
  const filler = Array.from({ length: 12 }, (_, i) => `<p>Absatz ${i + 1} vor der Tabelle.</p>`).join("");
  const after = Array.from({ length: 30 }, (_, i) => `<p>Absatz ${i + 1} nach der Tabelle.</p>`).join("");
  await command({
    action: "document.sync",
    pageId: host,
    generation: (await read(host)).generation,
    update: Buffer.from(
      htmlState(
        `${filler}<div data-linked-database="${crypto.randomUUID()}" data-linked-source="${source}" data-linked-version="1" data-linked-views="${escaped(JSON.stringify(views))}">Linked</div>${after}`,
      ),
    ).toString("base64"),
  });
  await page.goto(`/#page=${host}`);
  const embed = page.locator(".linked-database");
  await expect(embed.locator("tbody tr")).toHaveCount(80);
  const main = page.locator(".main-scroll");

  let m = await measure(page, ".linked-database");
  expect(m.stuck).toBe(false);
  // The table's top scrolled 600 px past the top of the pane.
  await main.evaluate((el, y) => el.scrollBy(0, y), m.table.top - m.line + 600);
  m = await measure(page, ".linked-database");
  expect(m.stuck).toBe(true);
  expect(Math.abs(m.head.top - m.line)).toBeLessThan(1.5);
  expect(Math.abs(m.head.left - m.cell.left)).toBeLessThan(1);
  expect(m.onTop).toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/${info.project.name}-inline.png` });
  await page.locator('.linked-database thead th[data-field-id="title"]').evaluate((el) => el.closest<HTMLElement>(".data-table-scroll")!.scrollLeft = 300);
  m = await measure(page, ".linked-database");
  expect(Math.abs(m.head.left - m.cell.left)).toBeLessThan(1);
  expect(Math.abs(m.title - m.titleCell)).toBeLessThan(1);
  // Pinned: at the left edge, after the selection column where that is pinned too.
  expect(m.title - m.scrollerLeft).toBeGreaterThan(-1);
  expect(m.title - m.scrollerLeft).toBeLessThan(80);

  // The table's end passes the top: the header goes with it.
  await main.evaluate((el, y) => el.scrollBy(0, y), m.table.bottom - m.line + 40);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const gone = await page.evaluate(() => {
    const table = document.querySelector<HTMLTableElement>(".linked-database table.configurable-table")!;
    return { head: table.querySelector("thead th")!.getBoundingClientRect().bottom, rows: table.tFoot!.getBoundingClientRect().top, main: document.querySelector(".main-scroll")!.getBoundingClientRect().top };
  });
  expect(gone.head).toBeLessThanOrEqual(gone.rows + 1);
  expect(gone.head).toBeLessThan(gone.main);
  expect(errors).toEqual([]);
});

test("split view: the header sticks to the top of the right frame", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Frames are for tablets and computers.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { database, create } = await fixture(page);
  const id = await database(40);
  const doc = await create("document", "Links");
  await page.goto(`/#page=${doc}`);
  await page.locator(`.page-nav[data-page-id="${id}"] .page-nav-title`).first().click({ modifiers: ["ControlOrMeta", "Shift"] });
  const pane = page.locator(".split-pane-scroll");
  await expect(pane.locator("tbody tr")).toHaveCount(40);
  await pane.evaluate((el) => el.scrollBy(0, 700));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const top = (await pane.boundingBox())!.y;
  const head = (await pane.locator('thead th[data-field-id="title"]').boundingBox())!;
  expect(Math.abs(head.y - top)).toBeLessThan(1.5);
  if (shots) await page.screenshot({ path: `${shots}/${info.project.name}-split.png` });
  expect(errors).toEqual([]);
});

test("record dialog: the header of a database in the record sticks below the dialog's heading", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, read, create, database } = await fixture(page);
  const source = await database(60);
  const host = await create("database", "Projekte");
  const record = await command({ action: "row.create", pageId: host, cells: { title: "Relaunch" } });
  const readRow = async () => (await page.request.get(`/api/pages/${host}/rows/${record.id}`)).json();
  const { htmlState, escaped } = await import("../../lib/document-server");
  const views = (await read(source)).database.views;
  await command({
    action: "row.document.sync",
    pageId: host,
    rowId: record.id,
    generation: (await readRow()).generation,
    update: Buffer.from(
      htmlState(
        `<p>Vorher</p><div data-linked-database="${crypto.randomUUID()}" data-linked-source="${source}" data-linked-version="1" data-linked-views="${escaped(JSON.stringify(views))}">Linked</div><p>Nachher</p>`,
      ),
    ).toString("base64"),
  });
  await page.goto(`/#page=${host}&row=${record.id}`);
  const dialog = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const embed = dialog.locator(".linked-database");
  await expect(embed.locator("tbody tr")).toHaveCount(60);
  // The dialog's own scroller, and how far the table's top lies below it.
  const result = await embed.evaluate(async (el) => {
    let scroller = el.parentElement;
    while (scroller && !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1))
      scroller = scroller.parentElement;
    const table = el.querySelector("table")!;
    scroller!.scrollBy(0, table.getBoundingClientRect().top - scroller!.getBoundingClientRect().top + 500);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const head = table.querySelector('thead th[data-field-id="title"]')!.getBoundingClientRect();
    const heading = scroller!.querySelector(".modal-heading")?.getBoundingClientRect();
    return {
      inDialog: !!scroller!.closest('[role="dialog"]'),
      head: head.top,
      line: Math.max(scroller!.getBoundingClientRect().top, heading?.bottom ?? -Infinity),
      onTop: document.elementFromPoint(head.left + 40, head.top + head.height / 2)?.closest("th") === table.querySelector('thead th[data-field-id="title"]'),
    };
  });
  expect(result.inDialog).toBe(true);
  expect(Math.abs(result.head - result.line)).toBeLessThan(1.5);
  expect(result.onTop).toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/${info.project.name}-record.png` });
  expect(errors).toEqual([]);
});
