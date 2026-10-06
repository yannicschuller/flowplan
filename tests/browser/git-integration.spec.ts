import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";

// Set up the Git connection, send a signed GitHub webhook, see the commit.
test("Git connection links commits to records", async ({ page }, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const prefix = `G${Date.now().toString(36).toUpperCase().slice(-5)}`;
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Dev ${info.project.name}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
      { id: "key", name: "ID", type: "id", prefix },
    ],
    views: first.database.views,
  });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Suche", status: "Offen" } });
  await page.goto(`/#page=${db.id}`);
  await page.getByRole("button", { name: "Weitere Werkzeuge" }).click();
  await page.getByRole("menuitem", { name: /Git-Anbindung/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Git-Anbindung einrichten" }).click();
  const url = await dialog.getByLabel(/Webhook-Adresse/).inputValue();
  const secret = await dialog.getByLabel(/Secret/).inputValue();
  expect(url).toMatch(/\/api\/git\/[A-Za-z0-9_-]{20,}$/);
  await page.keyboard.press("Escape");

  const payload = JSON.stringify({
    ref: "refs/heads/main",
    repository: { default_branch: "main" },
    commits: [{ id: "0123456789abcdef", message: `Suche schneller, fixes ${prefix}-1`, url: "https://github.com/example/app/commit/0123456", author: { name: "Ada" } }],
  });
  const hook = await page.request.post(new URL(url).pathname, {
    headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}` },
    data: payload,
  });
  expect(await hook.json()).toEqual({ ok: true, linked: 1, closed: 1 });
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const dev = page.getByRole("region", { name: "Entwicklung" });
  await expect(dev.getByRole("link", { name: /Suche schneller/ })).toBeVisible({ timeout: 30_000 });
  await expect(dev).toContainText("0123456 · Ada");
  expect(errors).toEqual([]);
});
