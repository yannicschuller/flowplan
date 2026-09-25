import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { htmlState } from "../../lib/document-server";

test("links and mentions in the editor can be clicked", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const dir = process.env.FLOWPLAN_DATA_DIR;
  test.skip(!dir || dir === "./data", "Braucht einen eigenen Datenordner.");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const tag = `${testInfo.project.name}${Date.now()}`;
  const target = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Ziel ${tag}`,
  });
  const doc = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Links ${tag}`,
  });
  const html = `<p><a href="#page=${target.id}">Zur Zielseite</a> und <a href="https://example.com/">Extern</a> und <span data-type="mention" data-mention="${boot.user.id}" data-label="${boot.user.name}" class="mention">@${boot.user.name}</span></p>`;
  const db = new DatabaseSync(join(dir!, "flowplan.sqlite"));
  db.prepare(
    "UPDATE documents SET state=?,html=?,generation=? WHERE page_id=?",
  ).run(htmlState(html), html, crypto.randomUUID(), doc.id);
  db.close();
  await page.goto(`/#page=${doc.id}`);
  const content = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(content).toContainText("Zur Zielseite");
  // External links open in a new tab.
  const popup = page.waitForEvent("popup");
  await content.getByText("Extern").click();
  expect((await popup).url()).toContain("example.com");
  // People show their card.
  await content.locator("[data-mention]").click();
  await expect(page.locator(".link-preview")).toContainText(boot.user.name);
  // Page links open the page.
  await content.getByText("Zur Zielseite").click();
  await expect(page).toHaveURL(new RegExp(`page=${target.id}`));
  await expect(page.getByRole("textbox", { name: "Seitentitel" })).toHaveValue(
    `Ziel ${tag}`,
  );
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: doc.id });
  await command({ action: "page.delete", pageId: target.id });
});
