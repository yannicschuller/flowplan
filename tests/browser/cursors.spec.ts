import { test, expect, type Page, type Browser } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { htmlState } from "../../lib/document-server";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function fixture(page: Page, browser: Browser) {
  if (
    !/^\/tmp\/flowplan-(?:cursors|inline)-e2e\.[A-Za-z0-9]+$/.test(
      process.env.FLOWPLAN_DATA_DIR || "",
    )
  )
    throw new Error("Cursor tests require their isolated data directory.");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      data,
      headers: { origin },
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const area = await command({
    action: "space.create",
    workspaceId: boot.workspace.id,
    name: `Cursors ${randomUUID()}`,
    private: false,
  });
  const doc = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: area.id,
    title: "Cursor document",
  });
  const source = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: area.id,
    title: "Cursor records",
    kind: "database",
  });
  const data = await (await page.request.get(`/api/pages/${source.id}`)).json();
  const row = await command({
    action: "row.create",
    pageId: source.id,
    cells: { [data.database.fields[0].id]: "Cursor record" },
  });
  const secondRow = await command({
    action: "row.create",
    pageId: source.id,
    cells: { [data.database.fields[0].id]: "Other record" },
  });
  await page.request.get(`/api/pages/${source.id}/rows/${row.id}`);
  await page.request.get(`/api/pages/${source.id}/rows/${secondRow.id}`);
  const db = new DatabaseSync(
    join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"),
  );
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const html =
      "<p>Alpha Bravo Charlie Delta</p><ul><li><p>Nested example</p></li></ul>",
    state = htmlState(html);
  db.prepare("UPDATE documents SET html=?,state=? WHERE page_id=?").run(
    html,
    state,
    doc.id,
  );
  db.prepare("UPDATE row_documents SET html=?,state=? WHERE row_id=?").run(
    html,
    state,
    row.id,
  );
  db.prepare("UPDATE row_documents SET html=?,state=? WHERE row_id=?").run(
    html,
    state,
    secondRow.id,
  );
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(
    uid,
    uid,
    "Cursor Kollegin",
    `${uid}@test.invalid`,
  );
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(
    boot.workspace.id,
    uid,
    "editor",
  );
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    uid,
    "[]",
    Date.now() + 3600000,
  );
  const context = await browser.newContext({
    viewport: page.viewportSize(),
    isMobile: test.info().project.name === "mobile",
    hasTouch: test.info().project.name === "mobile",
  });
  await context.addCookies([
    { name: "flowplan_session", value: token, url: origin },
  ]);
  const other = await context.newPage();
  const errors: string[] = [];
  for (const p of [page, other])
    p.on("pageerror", (e) => errors.push(e.message));
  async function open(p: Page, pid = doc.id, rid?: string) {
    await p.goto("about:blank");
    await p.goto(`${origin}/#page=${pid}`);
    if (test.info().project.name === "mobile") {
      const shade = p.locator(".nav-shade");
      if (await shade.isVisible())
        await shade.click({ position: { x: 300, y: 600 } });
    }
    if (rid) await p.locator(`[data-row-id="${rid}"] .title-cell`).click();
    await expect(p.locator(".tiptap")).toBeVisible();
    await expect
      .poll(() =>
        p
          .locator(".tiptap")
          .evaluate((el) =>
            (el as HTMLElement & { editor: any }).editor.getText(),
          ),
      )
      .toContain("Alpha Bravo");
  }
  return {
    boot,
    area,
    doc,
    source,
    row,
    secondRow,
    db,
    uid,
    token,
    context,
    other,
    errors,
    command,
    open,
  };
}
async function select(page: Page, from: number, to = from) {
  await page.locator(".tiptap").evaluate(
    (el, range) => {
      const editor = (el as HTMLElement & { editor: any }).editor;
      editor.commands.focus();
      editor.commands.setTextSelection(range);
    },
    { from, to },
  );
}
async function selected(page: Page) {
  return page.locator(".collaborator-selection").allTextContents();
}
test("two users see relative cursors and selections through concurrent edits without exporting decorations", async ({
  page,
  browser,
}, info) => {
  const f = await fixture(page, browser);
  try {
    await f.open(page);
    await f.open(f.other);
    await select(f.other, 7, 12);
    await expect.poll(() => selected(page)).toEqual(["Bravo"]);
    await expect(page.locator(".collaborator-cursor")).toHaveAttribute(
      "aria-label",
      "Cursor Kollegin: Cursor",
    );
    await select(page, 1);
    await page.keyboard.insertText("New ");
    await expect.poll(() => selected(page)).toEqual(["Bravo"]);
    await expect
      .poll(() =>
        f.other
          .locator(".tiptap")
          .evaluate((el) =>
            (el as HTMLElement & { editor: any }).editor.getText(),
          ),
      )
      .toContain("New Alpha");
    await expect.poll(() => selected(page)).toEqual(["Bravo"]);
    // A selection in a nested list also resolves through the shared mapping.
    await f.other.locator(".tiptap").evaluate((el) => {
      const e = (el as HTMLElement & { editor: any }).editor;
      e.state.doc.descendants((n: any, pos: number) => {
        if (n.isText && n.text.startsWith("Nested"))
          e.commands.setTextSelection({ from: pos, to: pos + 6 });
      });
    });
    await expect.poll(() => selected(page)).toEqual(["Nested"]);
    await page.screenshot({
      path: `test-results/cursors-verification/cursors-${info.project.name}.png`,
      fullPage: true,
    });
    const html = await page
      .locator(".tiptap")
      .evaluate((el) => (el as HTMLElement & { editor: any }).editor.getHTML());
    expect(html).not.toContain("collaborator");
    expect(html).not.toContain("Cursor Kollegin");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // Blur withdraws the cursor without closing the document.
    await f.other
      .locator(".tiptap")
      .evaluate((el) => (el as HTMLElement).blur());
    await expect(page.locator(".collaborator-cursor")).toHaveCount(0);
    await select(f.other, 7);
    await expect(page.locator(".collaborator-cursor")).toHaveCount(1);
    await f.context.setOffline(true);
    await expect(f.other.locator(".collaborator-cursor")).toHaveCount(0);
    await expect(page.locator(".collaborator-cursor")).toHaveCount(0, {
      timeout: 20000,
    });
    await f.context.setOffline(false);
    await select(f.other, 7);
    await expect(page.locator(".collaborator-cursor")).toHaveCount(1);
    f.db
      .prepare("DELETE FROM sessions WHERE token=?")
      .run(createHash("sha256").update(f.token).digest("hex"));
    await expect(page.locator(".collaborator-cursor")).toHaveCount(0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.context.close();
    f.db.close();
  }
});
test("row documents isolate cursors per row and generation and remove revoked readers", async ({
  page,
  browser,
}) => {
  const f = await fixture(page, browser);
  try {
    await f.open(page, f.source.id, f.row.id);
    await f.open(f.other, f.source.id, f.row.id);
    await select(f.other, 7, 12);
    await expect.poll(() => selected(page)).toEqual(["Bravo"]);
    const current = await (
      await page.request.get(`/api/pages/${f.source.id}/rows/${f.row.id}`)
    ).json();
    f.db
      .prepare("UPDATE row_documents SET generation=? WHERE row_id=?")
      .run(randomUUID(), f.row.id);
    await expect(page.locator(".collaborator-cursor")).toHaveCount(0);
    const stale = await page.request.post("/api/presence", {
      headers: { origin },
      data: {
        pageId: f.source.id,
        rowId: f.row.id,
        generation: current.generation,
        clientId: randomUUID(),
        sequence: 1,
        cursor: null,
      },
    });
    expect(stale.status()).toBe(409);
    await f.open(page, f.source.id, f.row.id);
    await f.open(f.other, f.source.id, f.row.id);
    await select(f.other, 7);
    await expect(page.locator(".collaborator-cursor")).toHaveCount(1);
    await f.open(f.other);
    await select(f.other, 7);
    await expect(page.locator(".collaborator-cursor")).toHaveCount(0);
    await f.open(f.other, f.source.id, f.secondRow.id);
    await select(f.other, 7);
    await expect(page.locator(".collaborator-cursor")).toHaveCount(0);
    await f.open(f.other, f.source.id, f.row.id);
    await select(f.other, 7);
    await expect(page.locator(".collaborator-cursor")).toHaveCount(1);
    f.db
      .prepare("DELETE FROM members WHERE workspace_id=? AND user_id=?")
      .run(f.boot.workspace.id, f.uid);
    await expect(page.locator(".collaborator-cursor")).toHaveCount(0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.context.close();
    f.db.close();
  }
});
test("slow presence requests stay serial, tab departures clear markers, and endpoint enforces input boundaries", async ({
  page,
  browser,
}) => {
  const f = await fixture(page, browser);
  let release = () => {};
  try {
    await f.open(page);
    await f.open(f.other);
    let active = 0,
      max = 0,
      calls = 0;
    await f.other.route("**/api/presence", async (route) => {
      if (!route.request().postDataJSON().cursor) return route.continue();
      active++;
      max = Math.max(max, active);
      calls++;
      if (calls === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      await route.continue();
      active--;
    });
    await select(f.other, 2);
    await expect.poll(() => calls).toBe(1);
    for (let i = 3; i < 10; i++) await select(f.other, i);
    // Advance beyond the polling interval while the first request is deliberately held.
    await page.waitForTimeout(1300);
    expect(calls).toBe(1);
    expect(max).toBe(1);
    release();
    await expect(page.locator(".collaborator-cursor")).toHaveCount(1);
    await f.other.unrouteAll({ behavior: "wait" });
    const twin = await f.context.newPage();
    await f.open(twin);
    await select(twin, 13);
    await expect(page.locator(".collaborator-cursor")).toHaveCount(2);
    await twin.goto("about:blank");
    await expect(page.locator(".collaborator-cursor")).toHaveCount(1);
    await twin.close();
    // Exercise visibility lifecycle deterministically in headless Chromium.
    await f.other.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator(".collaborator-cursor")).toHaveCount(0);
    await f.other.evaluate(() => {
      Reflect.deleteProperty(document, "hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await select(f.other, 25);
    await expect(page.locator(".collaborator-cursor")).toHaveCount(1);
    const longName = "Cursor Kollegin mit einem sehr langen Anzeigenamen";
    f.db.prepare("UPDATE users SET name=? WHERE id=?").run(longName, f.uid);
    await expect(page.locator(".collaborator-name")).toHaveText(longName);
    await expect
      .poll(() =>
        page.locator(".collaborator-name").evaluate((el) => {
          const box = el.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth;
        }),
      )
      .toBe(true);
    const base = {
      pageId: f.doc.id,
      generation: "1",
      clientId: randomUUID(),
      sequence: 1,
      cursor: null,
    };
    const post = (data: unknown, header = origin) =>
      page.request.post("/api/presence", { headers: { origin: header }, data });
    expect((await post({ ...base, name: "Spoof" })).status()).toBe(400);
    expect((await post(base, "https://evil.invalid")).status()).toBe(403);
    expect((await post({ ...base, padding: "x".repeat(5000) })).status()).toBe(
      413,
    );
    const invalid = await page.request.post("/api/presence", {
      headers: { origin, "Content-Type": "application/json" },
      data: "{",
    });
    expect(invalid.status()).toBe(400);
    expect(f.errors).toEqual([]);
  } finally {
    release();
    await f.context.close();
    f.db.close();
  }
});
