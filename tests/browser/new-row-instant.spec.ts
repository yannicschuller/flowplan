import { test, expect, type Page } from "@playwright/test";

// #608: "Neue Zeile" opens the new record at once – with the id the browser
// chose – instead of after the server's answer (1–2 s on a slow line).
// What is typed meanwhile waits behind the creation and is saved; a refused
// creation closes the record again with the server's message.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page, name: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const db = (await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `${name} ${Date.now()}`,
    kind: "database",
    databaseKind: "empty",
  })) as { id: string };
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  const titleId = (await read()).database.fields[0].id as string;
  const titles = async () => (await read()).rows.map((r: { cells: Record<string, unknown> }) => r.cells[titleId] ?? null);
  await page.goto(`/#page=${db.id}`);
  const skip = page.getByRole("dialog").getByRole("button", { name: "Überspringen" });
  if (await skip.waitFor({ timeout: 5000 }).then(() => true, () => false)) await skip.click();
  await expect(page.getByRole("button", { name: "Neue Zeile" })).toBeVisible({ timeout: 30_000 });
  return { titles };
}

// row.create answered only once `release()` is called (or refused).
async function holdCreate(page: Page, refuse = false) {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let seen = 0;
  await page.route("**/api/command", async (route) => {
    const body = route.request().postDataJSON() as { action?: string } | null;
    if (body?.action !== "row.create") return route.continue();
    seen++;
    await released;
    if (refuse) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Keine Berechtigung." }) });
    return route.continue();
  });
  return { release, sent: () => seen };
}

test("#608: the new record opens before the server answered, typing is kept", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { titles } = await setup(page, "Sofort 608");
  const create = await holdCreate(page);
  await page.getByRole("button", { name: "Neue Zeile" }).click();
  const record = page.getByRole("dialog").filter({ has: page.getByLabel("Titel des Eintrags") });
  const title = record.getByLabel("Titel des Eintrags");
  // Open and ready for typing while the creation still waits.
  await expect(title).toBeFocused({ timeout: 2000 });
  expect(create.sent()).toBe(1);
  expect(await titles()).toEqual([]);
  // The document waits for the record; the rest of it is there.
  await expect(record.getByRole("heading", { name: "Inhalt" })).toBeVisible();
  await title.fill("Angebot schreiben");
  await title.press("Enter");
  // The row shows in the table behind the dialog as well.
  await expect(page.locator(".data-table tbody tr[data-row-id]")).toHaveCount(1);
  expect(await titles()).toEqual([]);
  create.release();
  // The title waited behind the creation and is saved.
  await expect.poll(titles, { timeout: 15_000 }).toEqual(["Angebot schreiben"]);
  await expect(title).toHaveValue("Angebot schreiben");
  // The document is there once the record is.
  await expect(record.getByLabel("Dokumentinhalt").or(record.locator(".ProseMirror")).first()).toBeVisible({ timeout: 15_000 });
  await page.unroute("**/api/command");
  expect(errors).toEqual([]);
});

test("#608: a refused creation closes the record with the server's message", async ({ page }) => {
  test.setTimeout(120_000);
  const { titles } = await setup(page, "Abgelehnt 608");
  const create = await holdCreate(page, true);
  await page.getByRole("button", { name: "Neue Zeile" }).click();
  const record = page.getByRole("dialog").filter({ has: page.getByLabel("Titel des Eintrags") });
  await expect(record).toBeVisible({ timeout: 2000 });
  await record.getByLabel("Titel des Eintrags").fill("Geht nicht");
  create.release();
  // The message stays after the dialog closed: a toast, not in the dialog.
  await expect(page.getByText(/Berechtigung/).first()).toBeVisible({ timeout: 15_000 });
  await expect(record).toHaveCount(0);
  await expect(page.getByText(/Berechtigung/).first()).toBeVisible();
  await expect(page.locator(".data-table tbody tr[data-row-id]")).toHaveCount(0);
  await page.unroute("**/api/command");
  await page.waitForTimeout(500);
  expect(await titles()).toEqual([]);
});
