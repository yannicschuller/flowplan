import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// #274: on a locked page (read-only editor) a page link opened a new tab –
// in the desktop app a new window – instead of the page in the same window.
test("page links on a locked page open in the same window, with history", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const dir = process.env.FLOWPLAN_DATA_DIR;
  test.skip(!dir || dir === "./data", "Braucht einen eigenen Datenordner.");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const tag = `${testInfo.project.name}${Date.now()}`;
  const b = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `B ${tag}` });
  const a = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `A ${tag}` });
  // As the @-menu inserts a page mention: a link mark to "/#page=…".
  const html = `<p>Siehe <a href="/#page=${b.id}">Seite B</a> und <a href="https://example.com/">Extern</a></p>`;
  const { htmlState } = await import("../../lib/document-server");
  const db = new DatabaseSync(join(dir!, "flowplan.sqlite"));
  db.prepare("UPDATE documents SET state=?,html=?,generation=? WHERE page_id=?").run(htmlState(html), html, crypto.randomUUID(), a.id);
  db.close();
  await command({ action: "page.update", pageId: a.id, patch: { locked: true } });

  await page.goto(`/#page=${a.id}`);
  await expect(page.getByText("Diese Seite ist gesperrt.")).toBeVisible();
  const content = page.getByLabel("Dokumentinhalt", { exact: true });
  const link = content.getByText("Seite B");
  await expect(link).toBeVisible();
  await expect(content.locator('[contenteditable="true"]')).toHaveCount(0);
  // The stored link still says target="_blank" – the cause of the new window.
  await expect(content.locator(`a[href="/#page=${b.id}"]`)).toHaveAttribute("target", "_blank");

  // A plain click: same tab, page B, and back returns to A.
  let popups = 0;
  page.context().on("page", () => popups++);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`#page=${b.id}$`));
  await expect(page.getByRole("textbox", { name: "Seitentitel" })).toHaveValue(`B ${tag}`);
  expect(popups).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#page=${a.id}$`));
  await expect(page.getByText("Diese Seite ist gesperrt.")).toBeVisible();

  // External links still open outside.
  const external = page.waitForEvent("popup");
  await content.getByText("Extern").click();
  // Opened outside the app (this test machine has no internet, so only the
  // new window is checked, not what it loaded).
  expect(await external).toBeTruthy();
  await expect(page).toHaveURL(new RegExp(`#page=${a.id}$`));

  expect(errors).toEqual([]);
  await command({ action: "page.update", pageId: a.id, patch: { locked: false } });
  await command({ action: "page.delete", pageId: a.id });
  await command({ action: "page.delete", pageId: b.id });
});
