import { test, expect, type Page } from "@playwright/test";

// "Offene Aufgaben: kopieren" (#469): the original on the day before keeps
// its state – an empty or half-filled box – with a ➔ badge on its corner
// (#536), and keeps the badge when its state changes there.
const localDay = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

async function copiedDay(page: Page, title: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data: { workspaceId: boot.workspace.id, ...data } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const journal = await command({ action: "page.create", spaceId: boot.spaces[0].id, title, kind: "journal" });
  await command({ action: "journal.settings", pageId: journal.id, options: { carry: "copy" } });
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const { dayId } = await command({ action: "journal.roll", pageId: journal.id, date: localDay(yesterday) });
  const { htmlState } = await import("../../lib/document-server");
  const item = (text: string, attrs = "", checked = false) => `<li data-type="taskItem" data-checked="${checked}"${attrs}><p>${text}</p></li>`;
  await command({
    action: "document.sync",
    pageId: dayId,
    generation: (await (await page.request.get(`/api/pages/${dayId}`)).json()).generation,
    update: Buffer.from(
      htmlState(
        `<p>Stand-up</p><ul data-type="taskList">${item("Angebot schicken")}${item("Bericht schreiben", ' data-status="progress"')}${item("Einkaufen", "", true)}</ul>`,
      ),
    ).toString("base64"),
  });
  // Today's page is made: the open tasks are copied there.
  await command({ action: "journal.roll", pageId: journal.id, date: localDay(new Date()) });
  const continuedOn = new Date(`${localDay(new Date())}T00:00:00Z`).toLocaleDateString("de-DE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return { journal, dayId, command, continuedOn };
}

test("a continued task keeps its state and a ➔ badge on the day before", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "right click: desktop");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { journal, dayId, command, continuedOn } = await copiedDay(page, `Kopieren ${info.project.name} ${Date.now()}`);
  await page.goto(`/#page=${dayId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Stand-up");
  const task = (text: string) =>
    editor.locator("li[data-checked]", { has: page.locator(":scope > div > p", { hasText: new RegExp(`^${text}`) }) });
  const box = (text: string) => task(text).locator("> label input");
  const badge = (text: string) =>
    task(text).locator("> label").evaluate((label) => getComputedStyle(label, "::after").content);

  // Stored closed (cancelled), shown as it was: open and in progress.
  await expect(task("Angebot schicken")).toHaveAttribute("data-status", "cancelled");
  await expect(task("Angebot schicken")).toHaveAttribute("data-journal-was", "open");
  await expect(task("Bericht schreiben")).toHaveAttribute("data-journal-was", "progress");
  await expect(box("Angebot schicken")).toHaveAttribute("aria-label", `Offen, Weitergeführt am ${continuedOn}: Angebot schicken`);
  await expect(box("Bericht schreiben")).toHaveAttribute("aria-label", `In Arbeit, Weitergeführt am ${continuedOn}: Bericht schreiben`);
  await expect(box("Angebot schicken")).toHaveAttribute("title", `Weitergeführt am ${continuedOn}`);
  expect(await box("Angebot schicken").evaluate((input: HTMLInputElement) => input.checked)).toBe(false);
  expect(await box("Bericht schreiben").evaluate((input: HTMLInputElement) => input.indeterminate)).toBe(true);
  expect(await box("Bericht schreiben").evaluate((input) => getComputedStyle(input).backgroundImage)).toContain("linear-gradient");
  expect(await badge("Angebot schicken")).toBe('"➔"');
  expect(await badge("Bericht schreiben")).toBe('"➔"');
  // The done one has no badge.
  expect(await badge("Einkaufen")).toBe("none");

  // Ticked off there: done, the badge stays.
  await box("Angebot schicken").click();
  await expect(task("Angebot schicken")).toHaveAttribute("data-checked", "true");
  await expect(task("Angebot schicken")).not.toHaveAttribute("data-status", /.*/);
  await expect(task("Angebot schicken")).toHaveAttribute("data-journal-continued", localDay(new Date()));
  expect(await badge("Angebot schicken")).toBe('"➔"');
  // Unticked: open again, still closed and marked.
  await box("Angebot schicken").click();
  await expect(task("Angebot schicken")).toHaveAttribute("data-journal-was", "open");
  await expect(task("Angebot schicken")).toHaveAttribute("data-status", "cancelled");
  // Editing the text keeps it.
  await editor.locator('p:text-is("Angebot schicken")').click();
  await page.keyboard.press("End");
  await page.keyboard.type(" heute");
  await expect(task("Angebot schicken heute")).toHaveAttribute("data-journal-was", "open");

  // The menu: the state it shows is picked; the marker goes only on purpose.
  await box("Bericht schreiben").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Status der Aufgabe" });
  await expect(menu.getByRole("menuitemradio", { name: /In Arbeit/ })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitem", { name: "Nicht mehr als weitergeführt markieren" }).click();
  await expect(task("Bericht schreiben")).not.toHaveAttribute("data-journal-continued", /.*/);
  await expect(task("Bericht schreiben")).toHaveAttribute("data-status", "progress");
  await expect(task("Bericht schreiben")).toHaveAttribute("data-checked", "false");
  expect(await badge("Bericht schreiben")).toBe("none");

  // Saved: the server has the same.
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${dayId}`)).json()).html as string)
    .toMatch(/data-journal-continued="[\d-]+" data-journal-was="open" data-status="cancelled"[^>]*><label>.*?<p>Angebot schicken heute/);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: journal.id });
});

// Screenshots for the issue (light and dark, 2×): only with JOURNAL_SHOTS.
test("screenshots of a day with continued tasks", async ({ browser }, info) => {
  const dir = process.env.JOURNAL_SHOTS;
  test.skip(!dir || info.project.name !== "desktop", "only on request");
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ deviceScaleFactor: 2, colorScheme: scheme, viewport: { width: 900, height: 600 } });
    const page = await context.newPage();
    const { journal, dayId, command } = await copiedDay(page, `Screenshots ${scheme} ${Date.now()}`);
    await page.goto(`/#page=${dayId}`);
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    await expect(editor).toContainText("Einkaufen");
    await page.mouse.move(0, 0);
    await editor.locator("ul[data-type=taskList]").screenshot({ path: `${dir}/source-day-${scheme}.png` });
    await editor.locator("ul[data-type=taskList] li").first().locator("> label input").hover();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${dir}/source-day-page-${scheme}.png` });
    await command({ action: "page.delete", pageId: journal.id });
    await context.close();
  }
});
