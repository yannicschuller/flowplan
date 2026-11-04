import { test, expect, type Page, type Route } from "@playwright/test";

// Issue #104: a new record, its title typed and right away the next fields
// changed – on a slow connection a later change carried the record's version
// from before the title was saved, the server refused it ("Datensatz wurde
// geändert") and only reopening the record helped. Here the app's regular
// reload (every 10 s) starts just before the title is saved and answers
// late, after the saves: it holds the record as it was before. Every change
// of one record now goes through one path that sends the newest version the
// server answered with, and late answers no longer replace newer state.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page, name: string) {
  // The introduction of a first account closes when it shows.
  await page.addLocatorHandler(page.getByRole("dialog", { name: "Willkommen bei Flowplan" }), (intro) =>
    intro.getByRole("button", { name: "Überspringen" }).click(),
  );
  // The app's 10-second reload runs when the test says so.
  await page.addInitScript(() => {
    const polls: (() => void)[] = [];
    (window as unknown as { __polls: typeof polls }).__polls = polls;
    const interval = window.setInterval.bind(window);
    window.setInterval = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
      if (ms === 10000 && typeof fn === "function") {
        polls.push(fn as () => void);
        return 0;
      }
      return interval(fn, ms, ...rest);
    }) as typeof window.setInterval;
  });
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: {
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      title: `${name} ${Date.now()}`,
      kind: "database",
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as { id: string };
}

// Answers of the server come late: the next change is made while the
// previous one is still on its way. `staleReload()` starts the app's reload
// now; its read of the database answers only once `release()` is called.
async function slowServer(page: Page, pageId: string) {
  let hold: { fetched: () => void; release: Promise<void> } | null = null;
  const late = async (route: Route, ms: number) => {
    try {
      const response = await route.fetch();
      await new Promise((r) => setTimeout(r, ms));
      await route.fulfill({ response });
    } catch {}
  };
  await page.route("**/api/command", (route) => late(route, 500));
  await page.route(
    (url) => url.pathname === `/api/pages/${pageId}`,
    async (route) => {
      const held = hold;
      if (!held || route.request().method() !== "GET") return late(route, 100);
      hold = null;
      try {
        const response = await route.fetch();
        held.fetched();
        await held.release;
        await route.fulfill({ response });
      } catch {}
    },
  );
  return {
    async staleReload() {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const fetched = new Promise<void>((r) => {
        hold = { fetched: r, release: released };
      });
      await page.evaluate(() => (window as unknown as { __polls: (() => void)[] }).__polls.forEach((poll) => poll()));
      await fetched;
      return release;
    },
  };
}

// The app's own reload after the change of `cell` was answered.
function reloadedAfter(page: Page, pageId: string, cell: string) {
  return page
    .waitForResponse((r) => r.url().endsWith("/api/command") && !!r.request().postData()?.includes(`"${cell}"`))
    .then(() =>
      page.waitForResponse((r) => new URL(r.url()).pathname === `/api/pages/${pageId}` && r.request().method() === "GET"),
    );
}

async function rowsOf(page: Page, pageId: string) {
  const data = await (await page.request.get(`/api/pages/${pageId}`)).json();
  return data.rows as { cells: Record<string, unknown> }[];
}
const saved = (page: Page, pageId: string) =>
  expect.poll(async () => (await rowsOf(page, pageId)).map((r) => [r.cells.title, r.cells.status, r.cells.priority]), {
    timeout: 15000,
  });

function watchRefusals(page: Page) {
  const refused: string[] = [];
  page.on("response", async (response) => {
    if (response.url().endsWith("/api/command") && response.status() >= 400)
      refused.push(`${response.status()} ${await response.text().catch(() => "")}`);
  });
  return refused;
}

test("a new record: title, then status and priority right away", async ({ page }, info) => {
  const db = await setup(page, `Schnell ${info.project.name}`);
  const refused = watchRefusals(page);
  await page.goto(`/#page=${db.id}`);
  await expect(page.locator(".database")).toBeVisible();
  const server = await slowServer(page, db.id);

  await page.getByRole("button", { name: "Neu", exact: true }).first().click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const title = entry.getByRole("textbox", { name: "Titel des Eintrags" });
  await expect(title).toBeFocused({ timeout: 15000 });
  await title.fill("test");
  const release = await server.staleReload();
  // Straight on to the status: the title saves on the way (blur).
  const status = entry.getByLabel("Status", { exact: true });
  const reloaded = reloadedAfter(page, db.id, "status");
  await status.focus();
  await status.selectOption("In Arbeit");
  await reloaded;
  await saved(page, db.id).toEqual([["test", "In Arbeit", undefined]]);
  // The late reload answers with the record from before the title.
  release();
  await page.waitForTimeout(300);
  const priority = entry.getByLabel("Priorität", { exact: true });
  await priority.focus();
  await priority.selectOption("Hoch");

  await saved(page, db.id).toEqual([["test", "In Arbeit", "Hoch"]]);
  await page.waitForTimeout(1000);
  expect(refused).toEqual([]);
  await expect(page.getByText("Datensatz wurde geändert")).toHaveCount(0);
  // What the dialog shows is what was saved.
  await expect(title).toHaveValue("test");
  await expect(status).toHaveValue("In Arbeit");
  await expect(priority).toHaveValue("Hoch");

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload();
  const reopened = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(page.locator(".database")).toBeVisible();
  if (!(await reopened.isVisible())) await page.getByRole("button", { name: "Eintrag öffnen: test" }).first().click();
  await expect(reopened.getByRole("textbox", { name: "Titel des Eintrags" })).toHaveValue("test");
  await expect(reopened.getByLabel("Status", { exact: true })).toHaveValue("In Arbeit");
  await expect(reopened.getByLabel("Priorität", { exact: true })).toHaveValue("Hoch");
});

test("a new record: title, then right away the table's cells", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "The table's cells are edited in place on wide screens.");
  const db = await setup(page, `Tabelle ${info.project.name}`);
  const refused = watchRefusals(page);
  await page.goto(`/#page=${db.id}`);
  const table = page.locator(".data-table");
  await expect(table).toBeVisible();
  const server = await slowServer(page, db.id);

  await page.getByRole("button", { name: "Neu", exact: true }).first().click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const title = entry.getByRole("textbox", { name: "Titel des Eintrags" });
  await expect(title).toBeFocused({ timeout: 15000 });
  await title.fill("Zeile");
  const release = await server.staleReload();
  // Enter saves the title; the dialog closes and the row's cells follow.
  await title.press("Enter");
  await page.keyboard.press("Escape");
  await expect(entry).toBeHidden();
  const row = table.locator("tbody tr[data-row-id]").first();
  // The selection, the title, then status and priority.
  const reloaded = reloadedAfter(page, db.id, "status");
  await row.locator("td").nth(2).click();
  await row.getByLabel("Status", { exact: true }).selectOption("Erledigt");
  await reloaded;
  await saved(page, db.id).toEqual([["Zeile", "Erledigt", undefined]]);
  release();
  await page.waitForTimeout(300);
  await row.locator("td").nth(3).click();
  await row.getByLabel("Priorität", { exact: true }).selectOption("Niedrig");

  await saved(page, db.id).toEqual([["Zeile", "Erledigt", "Niedrig"]]);
  await page.waitForTimeout(1000);
  expect(refused).toEqual([]);
  await expect(page.getByText("Datensatz wurde geändert")).toHaveCount(0);
});
