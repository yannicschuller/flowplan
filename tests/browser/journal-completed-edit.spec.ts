import { test, expect, type Page } from "@playwright/test";

// #249: a task ticked off and then reworded in the editor stays in
// "An diesem Tag erledigt" below the journal day – with its new text. The
// editor gives the task a block id; the done log follows it (lib/doc-tasks.ts).

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
async function open(page: Page, id: string) {
  await page.goto(`/#page=${id}`);
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await welcome.waitFor({ timeout: 3000 }).then(() => page.keyboard.press("Escape"), () => {});
}

test("a done task reworded in the editor stays under “An diesem Tag erledigt”", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const where = { workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id };
  const stamp = `${info.project.name} ${Date.now()}`;
  const journal = (await command({ action: "page.create", ...where, title: `Journal ${stamp}`, kind: "journal" })).id as string;
  const { dayId } = await command({ action: "journal.roll", workspaceId: boot.workspace.id, pageId: journal, date: localDay() });
  // A task in another page, ticked off in the editor.
  const doc = (await command({ action: "page.create", ...where, title: `Projekt ${stamp}`, kind: "document" })).id as string;
  await open(page, doc);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type(`[] Angebot ${stamp}`);
  const item = editor.locator("li[data-checked]");
  await expect(item).toHaveCount(1);
  await item.locator("> label input").click();
  await expect(item).toHaveAttribute("data-checked", "true");
  const completed = async () =>
    ((await (await page.request.get(`/api/journals/${dayId}/completed?zone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}&mine=0`)).json()) as { items: { title: string }[] }).items.map(
      (i) => i.title,
    );
  await expect.poll(completed, { timeout: 15_000 }).toContain(`Angebot ${stamp}`);
  // Reworded – more characters, as in the report.
  await editor.locator(`p:text-is("Angebot ${stamp}")`).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" und nachfassen");
  await expect.poll(completed, { timeout: 15_000 }).toContain(`Angebot ${stamp} und nachfassen`);
  expect(await completed()).not.toContain(`Angebot ${stamp}`);
  // The day shows it.
  await open(page, dayId);
  await expect(page.locator(".journal-completed")).toContainText(`Angebot ${stamp} und nachfassen`);
  expect(errors).toEqual([]);
});
