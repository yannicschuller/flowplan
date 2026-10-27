import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// Journal days that do not flood lists (#49): today as a draft that is
// created by the first keystroke ("Seite des Tages anlegen: beim ersten
// Schreiben"), the search filter "Ohne Journaltage", the graph option and
// "Leere Tage entfernen".
const localDay = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data: { workspaceId: boot.workspace.id, ...data } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const read = async (id: string) => (await page.request.get(`/api/pages/${id}`)).json();
  // Stored HTML without a Yjs state: the server builds the state from it.
  const write = async (id: string, html: string) => {
    const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
    d.exec("PRAGMA busy_timeout=5000;");
    d.prepare("UPDATE documents SET html=?,state=NULL,generation=? WHERE page_id=?").run(html, randomUUID(), id);
    d.close();
  };
  return { boot, command, read, write };
}

test("today is a draft until the first keystroke creates exactly one page", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command, read, write } = await setup(page);
  const journal = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: `Entwurf ${info.project.name} ${Date.now()}`, kind: "journal" });
  await command({ action: "journal.settings", pageId: journal.id, template: "<h3>Dankbar für</h3><p></p>" });
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const { dayId: before } = await command({ action: "journal.roll", pageId: journal.id, date: localDay(yesterday) });
  await write(before, '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Angebot schicken</p></li></ul>');
  await command({ action: "journal.settings", pageId: journal.id, options: { create: "write" } });

  await page.goto(`/#page=${journal.id}`);
  const today = page.locator(".journal-today");
  await expect(today).toBeEnabled();
  await expect(today).toContainText("Noch nichts geschrieben");
  await today.click();
  // The draft: template and the carried task, not saved.
  await expect(page.locator(".journal-draft-hint")).toBeVisible();
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator("li p", { hasText: "Angebot schicken" })).toBeVisible();
  await expect(editor.locator("h3", { hasText: "Dankbar für" })).toBeVisible();
  // Opening it creates nothing: no day in the tree, the task still yesterday.
  await page.waitForTimeout(2500);
  const days = async () =>
    (await (await page.request.get("/api/bootstrap")).json()).pages.filter(
      (p: { parent_id: string; journal_date: string | null; deleted_at: string | null }) => p.parent_id === journal.id && p.journal_date === localDay(new Date()) && !p.deleted_at,
    );
  expect(await days()).toHaveLength(0);
  expect((await read(before)).html).toContain("Angebot schicken");
  await info.attach("draft", { body: await page.screenshot(), contentType: "image/png" });

  // The first keystroke creates the day, under the same id, with the text.
  await editor.locator("p").last().click();
  await page.keyboard.type("Sonne am Morgen");
  await expect(page.locator(".journal-draft-hint")).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await days()).length, { timeout: 15_000 }).toBe(1);
  const [day] = await days();
  await expect.poll(async () => (await read(day.id)).html, { timeout: 15_000 }).toContain("Sonne am Morgen");
  const html = (await read(day.id)).html as string;
  expect(html.match(/Dankbar für/g)).toHaveLength(1);
  expect(html.match(/Angebot schicken/g)).toHaveLength(1);
  // The carried task moved now.
  expect((await read(before)).html).not.toContain("Angebot schicken");
  // Typing on stays in the same editor.
  await page.keyboard.type(" und Tee");
  await expect.poll(async () => (await read(day.id)).html, { timeout: 15_000 }).toContain("Sonne am Morgen und Tee");
  expect(await days()).toHaveLength(1);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: journal.id });
});

test("the search leaves journal days out on request and ranks them last", async ({ page }, info) => {
  const { boot, command, write } = await setup(page);
  const word = `Sternfrucht${Date.now()}`;
  const journal = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: `Suche ${info.project.name}`, kind: "journal" });
  const { dayId } = await command({ action: "journal.roll", pageId: journal.id, date: localDay(new Date()) });
  await write(dayId, `<p>${word} im Tagebuch</p>`);
  const note = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: `Notiz ${word}` });
  await write(note.id, `<p>${word}</p>`);
  await page.goto("/");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  const input = page.getByRole("combobox").or(page.locator(".palette input")).first();
  await input.fill(word);
  const results = page.locator(".palette-list [role=option]");
  await expect(results.filter({ hasText: "Notiz" })).toHaveCount(1);
  await expect(results).toHaveCount(2);
  await expect(results.first()).toContainText("Notiz");
  const filter = page.getByRole("button", { name: "Ohne Journaltage" });
  await expect(filter).toHaveAttribute("aria-pressed", "false");
  await filter.click();
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(results).toHaveCount(1);
  await info.attach("search", { body: await page.screenshot(), contentType: "image/png" });
  // Remembered for the next search.
  await page.keyboard.press("Escape");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await expect(page.getByRole("button", { name: "Ohne Journaltage" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Ohne Journaltage" }).click();
  await command({ action: "page.delete", pageId: journal.id });
  await command({ action: "page.delete", pageId: note.id });
});

test("empty days are listed before they go to the trash", async ({ page }, info) => {
  const { boot, command, write } = await setup(page);
  const journal = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: `Leer ${info.project.name} ${Date.now()}`, kind: "journal" });
  // Yesterday with an entry, and a day last week that stayed empty (from
  // before empty days were removed by themselves).
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const { dayId: written } = await command({ action: "journal.roll", pageId: journal.id, date: localDay(yesterday) });
  await write(written, "<p>Ein guter Tag.</p>");
  const old = new Date();
  old.setDate(old.getDate() - 6);
  const dayId = randomUUID();
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  const title = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${localDay(old)}T00:00:00Z`));
  d.prepare("INSERT INTO pages(id,workspace_id,space_id,parent_id,title,kind,created_by,position,icon,journal_date) VALUES(?,?,?,?,?,'document',?,?,'day',?)").run(
    dayId, boot.workspace.id, boot.spaces[0].id, journal.id, title, boot.user.id, -Number(localDay(old).replaceAll("-", "")), localDay(old),
  );
  d.prepare("INSERT INTO documents(page_id,html) VALUES(?,'<p></p>')").run(dayId);
  d.close();
  await page.goto(`/#page=${journal.id}`);
  await page.getByRole("button", { name: "Journal einrichten" }).click();
  await page.getByRole("tab", { name: "Tage", exact: true }).click();
  await expect(page.getByRole("radio", { name: /Automatisch/ })).toBeChecked();
  await page.getByRole("button", { name: "Leere Tage suchen" }).click();
  const list = page.getByRole("list", { name: "Leere Tage" });
  await expect(list.locator("li")).toHaveCount(1);
  await info.attach("empty-days", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "1 Tag in den Papierkorb" }).click();
  await expect(page.getByText("1 leerer Tag liegt jetzt im Papierkorb.")).toBeVisible();
  const trashed = await (await page.request.get("/api/bootstrap")).json();
  expect(trashed.pages.find((p: { id: string }) => p.id === dayId)?.deleted_at).toBeTruthy();
  // The setting: "beim ersten Schreiben".
  await page.getByRole("radio", { name: /Beim ersten Schreiben/ }).check();
  await expect.poll(async () => (await (await page.request.get(`/api/pages/${journal.id}`)).json()).journal.settings.options.create).toBe("write");
  await command({ action: "page.delete", pageId: journal.id });
});

test("the graph offers journal days hidden, per month or each", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The graph is a desktop view.");
  const { boot, command, write } = await setup(page);
  const target = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: "Packliste" });
  const name = `Reisejournal ${Date.now()}`;
  const journal = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: name, kind: "journal" });
  const { dayId } = await command({ action: "journal.roll", pageId: journal.id, date: localDay(new Date()) });
  await write(dayId, `<p><a href="/#page=${target.id}">Packliste</a></p>`);
  await page.goto("/#graph");
  const select = page.getByLabel("Journaltage im Graph");
  await expect(select).toHaveValue("month");
  const month = page.locator(`.graph-node.kind-journal-month[aria-label*="${name}"]`);
  await expect(month).toHaveCount(1);
  await expect(month).toHaveAttribute("aria-label", /1 Journaltage/);
  await expect(page.locator(".graph-count")).toContainText("Journaltage");
  await info.attach("graph", { body: await page.screenshot(), contentType: "image/png" });
  await select.selectOption("hide");
  await expect(page.locator(".graph-node.kind-journal-month")).toHaveCount(0);
  await select.selectOption("show");
  await expect(page.locator(`.graph-node[aria-label*="${new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long" }).format(new Date())}"]`).first()).toBeVisible();
  await select.selectOption("month");
  await command({ action: "page.delete", pageId: journal.id });
  await command({ action: "page.delete", pageId: target.id });
});
