import { test, expect } from "@playwright/test";

const localDay = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

test("a journal creates today's page, carries open tasks over and lists past days", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const journal = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Journal ${info.project.name} ${Date.now()}`,
    kind: "journal",
  });
  // Yesterday already has a page with an open and a done task.
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const { dayId } = await command({
    action: "journal.roll",
    workspaceId: boot.workspace.id,
    pageId: journal.id,
    date: localDay(yesterday),
  });
  const read = async (id: string) =>
    (await page.request.get(`/api/pages/${id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({
    action: "document.sync",
    workspaceId: boot.workspace.id,
    pageId: dayId,
    generation: (await read(dayId)).generation,
    update: Buffer.from(
      htmlState(
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Angebot schicken</p></li><li data-type="taskItem" data-checked="true"><p>Einkaufen</p></li></ul>',
      ),
    ).toString("base64"),
  });

  await page.goto(`/#page=${journal.id}`);
  const today = page.locator(".journal-today");
  await expect(today).toBeEnabled();
  await expect(today).toContainText("Heute");
  // Yesterday is listed below; it had its own entry, so it stays.
  await expect(page.locator(".journal-month li")).toHaveCount(1);
  await expect(page.locator(".journal-month li")).toContainText("Gestern");
  await today.click();
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator("li p", { hasText: "Angebot schicken" })).toBeVisible();
  await expect(
    editor.locator("li[data-journal-since]"),
  ).toHaveCount(1);
  await expect(editor.locator("li p", { hasText: "Einkaufen" })).toHaveCount(0);
  await expect(page.locator(".page-title")).toHaveValue(
    new Intl.DateTimeFormat("de-DE", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date()),
  );
  // The open task left yesterday's page; the done one stays there.
  const before = (await read(dayId)).html;
  expect(before).toContain("Einkaufen");
  expect(before).not.toContain("Angebot schicken");
  // The day pages sit below the journal in the sidebar, newest first.
  const tree = (await (await page.request.get("/api/bootstrap")).json()).pages
    .filter((p: { parent_id: string }) => p.parent_id === journal.id)
    .sort((a: { position: number }, b: { position: number }) => a.position - b.position)
    .map((p: { journal_date: string }) => p.journal_date);
  expect(tree).toEqual([localDay(new Date()), localDay(yesterday)]);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: journal.id });
});

test("the new page dialog offers the journal type", async ({ page }) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.goto("/");
  await page.getByRole("button", { name: /Neue Seite/ }).first().click();
  await expect(page.getByRole("button", { name: /Journal/ })).toBeVisible();
});
