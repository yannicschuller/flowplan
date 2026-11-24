import { test, expect, type Page } from "@playwright/test";

// Moving tasks with ⌘⇧↑ / ⌘⇧↓ (on phones: "Nach oben" / "Nach unten" in
// the block menu): #467 – a task in a journal's "Backlog" moves with its
// subtasks past the heading into "Today Work"; #468 – a subtask moves to
// another parent with its own subtasks.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const localDay = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const task = (text: string, checked = false, sub = "") =>
  `<li data-type="taskItem" data-checked="${checked}"><p>${text}</p>${sub ? `<ul data-type="taskList">${sub}</ul>` : ""}</li>`;
const list = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;

// The page as an outline: headings and paragraphs by their text, tasks
// indented by level with their state.
const outline = (page: Page) =>
  page.getByLabel("Dokumentinhalt", { exact: true }).evaluate((root) => {
    const out: string[] = [];
    const walk = (el: Element, level: number) => {
      for (const child of el.children) {
        if (child.matches("ul[data-type='taskList']")) walk(child, level);
        else if (child.matches("li[data-checked]")) {
          const li = child as HTMLElement;
          const own = li.querySelector(":scope > div > p")?.textContent || "";
          out.push(`${"  ".repeat(level)}[${li.dataset.checked === "true" ? "x" : " "}] ${own}`);
          for (const sub of li.querySelectorAll(":scope > div > ul[data-type='taskList']")) walk(sub, level + 1);
        } else if (child.matches("h1, h2, h3, p") && child.textContent) out.push(child.textContent);
      }
    };
    walk(root, 0);
    return out;
  });

async function move(page: Page, text: string, direction: "up" | "down", mobile: boolean) {
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const line = editor.locator("li p").filter({ hasText: new RegExp(`^${text}$`) });
  if (!mobile) {
    await line.click();
    await page.keyboard.press(`ControlOrMeta+Shift+${direction === "up" ? "ArrowUp" : "ArrowDown"}`);
    return;
  }
  await line.tap();
  await page.getByRole("button", { name: new RegExp(`^Blockaktionen: .* · ${text}`) }).tap();
  await page.getByRole("menuitem", { name: direction === "up" ? "Nach oben" : "Nach unten", exact: true }).tap();
}

async function openDay(page: Page, html: string, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const journal = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "journal" });
  const { dayId } = await command({ action: "journal.roll", workspaceId: boot.workspace.id, pageId: journal.id, date: localDay(new Date()) });
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${dayId}`)).json()).generation;
  await command({ action: "document.sync", workspaceId: boot.workspace.id, pageId: dayId, generation, update: Buffer.from(htmlState(html)).toString("base64") });
  await page.goto(`/#page=${journal.id}`);
  await page.locator(".journal-today").click();
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende", { exact: true })).toBeVisible({ timeout: 30_000 });
  return { dayId, journalId: journal.id, command };
}

test("#467: a task with its subtasks moves from Backlog into Today Work", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { dayId, journalId, command } = await openDay(
    page,
    `<h2>Today Work</h2>${list(task("Task 1"))}<h2>Backlog</h2>${list(task("Task 2", false, task("Sub A", true) + task("Sub B")), task("Task 3"))}<p>Ende</p>`,
    `Journal 467 ${info.project.name} ${Date.now()}`,
  );
  await move(page, "Task 2", "up", mobile);
  await expect
    .poll(() => outline(page))
    .toEqual(["Today Work", "[ ] Task 1", "[ ] Task 2", "  [x] Sub A", "  [ ] Sub B", "Backlog", "[ ] Task 3", "Ende"]);
  // Pressed again: past Task 1.
  await move(page, "Task 2", "up", mobile);
  await expect
    .poll(() => outline(page))
    .toEqual(["Today Work", "[ ] Task 2", "  [x] Sub A", "  [ ] Sub B", "[ ] Task 1", "Backlog", "[ ] Task 3", "Ende"]);
  // And back down into the Backlog, at its top.
  await move(page, "Task 2", "down", mobile);
  await move(page, "Task 2", "down", mobile);
  await expect
    .poll(() => outline(page))
    .toEqual(["Today Work", "[ ] Task 1", "Backlog", "[ ] Task 2", "  [x] Sub A", "  [ ] Sub B", "[ ] Task 3", "Ende"]);
  // Saved: the subtasks still below Task 2.
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${dayId}`)).json()).html as string)
    .toMatch(/Backlog<\/h2><ul[^>]*><li[^>]*>.*Task 2.*Sub A.*Sub B.*Task 3/);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: journalId });
});

test("#468: a subtask moves to another parent with its own subtasks, the caret stays", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const { journalId, command } = await openDay(
    page,
    `${list(task("Parent A", false, task("Child", true, task("Grandchild"))), task("Parent B", false, task("Other")))}<p>Ende</p>`,
    `Journal 468 ${info.project.name} ${Date.now()}`,
  );
  await move(page, "Child", "down", mobile);
  await expect
    .poll(() => outline(page))
    .toEqual(["[ ] Parent A", "[ ] Parent B", "  [x] Child", "    [ ] Grandchild", "  [ ] Other", "Ende"]);
  if (!mobile) {
    // The caret is still in "Child": the next press moves it on, typing goes there.
    await page.keyboard.press("ControlOrMeta+Shift+ArrowDown");
    await expect
      .poll(() => outline(page))
      .toEqual(["[ ] Parent A", "[ ] Parent B", "  [ ] Other", "  [x] Child", "    [ ] Grandchild", "Ende"]);
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await expect.poll(() => outline(page)).toContain("  [x] Child!");
    // One undo per step: the typing, then the last move.
    await page.keyboard.press("ControlOrMeta+z");
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(() => outline(page))
      .toEqual(["[ ] Parent A", "[ ] Parent B", "  [x] Child", "    [ ] Grandchild", "  [ ] Other", "Ende"]);
  }
  // Back up into Parent A.
  await move(page, "Child", "up", mobile);
  await expect
    .poll(() => outline(page))
    .toEqual(["[ ] Parent A", "  [x] Child", "    [ ] Grandchild", "[ ] Parent B", "  [ ] Other", "Ende"]);
  await command({ action: "page.delete", pageId: journalId });
});
