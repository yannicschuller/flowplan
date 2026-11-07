import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

// Confirmations are not errors. In the journal settings (a dialog) they show
// as a neutral notice inside the dialog, where errors show too (ca150f57): a
// toast would sit above the modal without taking clicks, which went through to
// the dialog. In the workspace settings ("Einladungslink kopiert", "…
// importiert") they are info toasts, not error toasts.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data: { workspaceId: boot.workspace.id, ...data } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const confirmation = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
  return { boot, command, confirmation, errors };
}

test("journal settings confirmations show as a neutral notice in the dialog", async ({ page }, info) => {
  const { boot, command, errors } = await setup(page);
  const journal = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: `Journal ${info.project.name} ${Date.now()}`, kind: "journal" });
  const template = async () => (await (await page.request.get(`/api/pages/${journal.id}`)).json()).journal.settings.template || "";
  await page.goto(`/#page=${journal.id}`);
  await page.getByRole("button", { name: "Journal einrichten" }).click();
  const dialog = page.getByRole("dialog", { name: "Journal einrichten" });
  const notice = (text: string | RegExp) => dialog.getByRole("status").filter({ hasText: text });
  await dialog.getByRole("tab", { name: "Vorlage", exact: true }).click();
  await dialog.getByRole("button", { name: /Dankbarkeit & Fokus/ }).click();
  await expect(notice("Vorlage „Dankbarkeit & Fokus“ gesetzt.")).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect.poll(template).toContain("Dankbar für");
  // Dismissing it, with a real click or tap where it shows, closes only the
  // notice: the dialog stays open and the template stays (a toast above the
  // modal let the click through – the dialog closed, or the template card
  // below was picked on phones).
  const close = notice("gesetzt").getByRole("button", { name: "Meldung schließen" });
  await expect(close).toBeVisible();
  const box = (await close.boundingBox())!;
  if (info.project.name === "mobile") await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(notice("gesetzt")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(500);
  expect(await template()).toContain("Dankbar für");
  // The PIN notice ("… Freigaben … widerrufen") stays until it is dismissed
  // or the dialog closes, not 5 seconds.
  await dialog.getByRole("tab", { name: "Sperre" }).click();
  await dialog.getByLabel("Neue PIN").fill("246813");
  await dialog.getByLabel("PIN wiederholen").fill("246813");
  await dialog.getByRole("button", { name: "Sperren" }).click();
  await expect(notice("Journal ist mit PIN geschützt.")).toBeVisible();
  await page.waitForTimeout(6000);
  await expect(notice("Journal ist mit PIN geschützt.")).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Journal einrichten" }).click();
  await expect(dialog).toBeVisible();
  await expect(notice("Journal ist mit PIN geschützt.")).toHaveCount(0);
  await command({ action: "page.delete", pageId: journal.id });
  expect(errors).toEqual([]);
});

test("workspace settings confirmations show as info toasts, not as errors", async ({ page }, info) => {
  test.setTimeout(120_000);
  const { boot, confirmation, errors } = await setup(page);
  // A pending invitation (the demo may not invite; the settings give it its link).
  const email = `einladung-${info.project.name}-${Date.now()}@example.com`;
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  d.prepare("INSERT INTO invites(id,workspace_id,email,role,created_by,created_at) VALUES(?,?,?,?,?,?)").run(
    randomUUID(), boot.workspace.id, email, "editor", boot.user.id, Date.now(),
  );
  d.close();

  // "Link kopieren" of a pending invitation.
  await page.goto("/#settings/members");
  const invitation = page.locator(".ws-invite", { hasText: email });
  await invitation.getByRole("button", { name: "Link kopieren" }).click();
  await expect(confirmation("Einladungslink kopiert.")).toBeVisible();
  await expect(page.locator(".toast-error")).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`^${origin.replace(/[.]/g, "\\.")}/\\?invite=.+`));

  // A Trello import: the new database opens and the confirmation goes with it.
  const name = `Trello ${info.project.name} ${Date.now()}`;
  const board = { name, lists: [{ id: "l1", name: "Ideen" }], cards: [{ id: "c1", name: "Erste Karte", idList: "l1", labels: [] }] };
  await page.goto("/#settings/data");
  await page.getByLabel("Jira- oder Trello-Export importieren").setInputFiles({ name: "board.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(board)) });
  await expect(confirmation(/1 Einträge und 0 Kommentare importiert\./)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".toast-error")).toHaveCount(0);
  await expect(page.getByText("Erste Karte").first()).toBeVisible();
  expect(errors).toEqual([]);
});
