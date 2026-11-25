import { test, expect, type Locator, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const database = () => new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR || join(process.cwd(), "data"), "flowplan.sqlite"));

async function demo(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  await page.request.post("/api/command", { headers: { origin }, data: { action: "notification.read" } });
  return boot as { user: { id: string } };
}
// A notification's own tools: on hover with a mouse, in its ⋯ menu by touch.
async function tool(page: Page, item: Locator, name: string | RegExp, mobile: boolean) {
  if (mobile) {
    await item.getByRole("button", { name: /^Aktionen: / }).click();
    await page.getByRole("menu").getByRole("menuitem", { name }).click();
  } else {
    await item.hover();
    await item.getByRole("button", { name }).click();
  }
}

test("the inbox filters unread items and marks or removes single ones", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mobile = testInfo.project.name === "mobile";
  const boot = await demo(page);
  const tag = `${testInfo.project.name}${Date.now()}`;
  const db = database();
  for (const body of [`Erste ${tag}`, `Zweite ${tag}`])
    db.prepare("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)").run(randomUUID(), boot.user.id, body);
  db.close();
  await page.goto("/#inbox");
  const inbox = page.locator(".inbox");
  const item = (text: string) => inbox.locator(".notification-item").filter({ hasText: text });
  await expect(item(`Erste ${tag}`)).toHaveClass(/unread/);
  // Opening the inbox no longer marks everything as read.
  await page.reload();
  await expect(item(`Zweite ${tag}`)).toHaveClass(/unread/);
  await tool(page, item(`Erste ${tag}`), "Als gelesen markieren", mobile);
  await expect(item(`Erste ${tag}`)).not.toHaveClass(/unread/);
  await inbox.getByRole("radio", { name: /Ungelesen/ }).click();
  await expect(item(`Erste ${tag}`)).toHaveCount(0);
  await expect(item(`Zweite ${tag}`)).toBeVisible();
  await tool(page, item(`Zweite ${tag}`), mobile ? "Entfernen" : `Benachrichtigung entfernen: Zweite ${tag}`, mobile);
  await expect(item(`Zweite ${tag}`)).toHaveCount(0);
  await inbox.getByRole("radio", { name: "Alle" }).click();
  await tool(page, item(`Erste ${tag}`), "Als ungelesen markieren", mobile);
  await expect(item(`Erste ${tag}`)).toHaveClass(/unread/);
  await inbox.getByRole("button", { name: "Alle als gelesen markieren" }).click();
  await expect(item(`Erste ${tag}`)).not.toHaveClass(/unread/);
  expect(errors).toEqual([]);
});

test("the inbox shows who and what, collapses similar ones, acts on them together and loads older ones", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const boot = await demo(page);
  const tag = `${testInfo.project.name}${Date.now()}`;
  const db = database();
  db.prepare("DELETE FROM notifications WHERE user_id=?").run(boot.user.id);
  const insert = db.prepare(
    "INSERT INTO notifications(id,user_id,body,kind,link,created_at,actor_id,subtype,severity,params,excerpt) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  );
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
  // 120 older ones: the bootstrap brings 100, the rest come with "Ältere laden".
  for (let i = 0; i < 120; i++) insert.run(randomUUID(), boot.user.id, `Alt ${i} ${tag}`, null, null, at(20 * 24 * 60 + i), null, null, null, null, null);
  const incident = (minutes: number, detail: string) =>
    insert.run(randomUUID(), boot.user.id, "Sicherheitsvorfall: Abtasten von Adressen und IDs.", "incident", `#settings/instance/threats/incident/${randomUUID()}`, at(minutes), null, "incident", "warn", JSON.stringify({ rule: "probing", detail }), null);
  incident(5, `60 × 404 ${tag}`);
  incident(9, `41 × 403 ${tag}`);
  insert.run(randomUUID(), boot.user.id, "Jonas kommentiert „Plan“", "comment", null, at(3), null, "comment", null, JSON.stringify({ actor: `Jonas ${tag}`, page: "Plan" }), "Bitte bis Freitag prüfen");
  db.close();
  await page.goto("/#inbox");
  const inbox = page.locator(".inbox");
  // A comment: the person, what they did, where, and the first words.
  const comment = inbox.locator(".notification-item").filter({ hasText: `Jonas ${tag}` });
  await expect(comment).toContainText("hat kommentiert");
  await expect(comment).toContainText("Plan");
  await expect(comment).toContainText("Bitte bis Freitag prüfen");
  // The action that fits: beside it with a mouse, in its ⋯ menu on a phone.
  if (testInfo.project.name === "desktop") await expect(comment.getByRole("button", { name: /^Antworten: / })).toBeVisible();
  else {
    await comment.getByRole("button", { name: /^Aktionen: / }).click();
    await expect(page.getByRole("menuitem", { name: "Antworten" })).toBeVisible();
    await page.keyboard.press("Escape");
  }
  // Two incidents of one rule: one row, with the severity; it opens.
  const similar = inbox.getByRole("button", { name: /2 Sicherheitsvorfälle: Abtasten von Adressen und IDs/ });
  await expect(similar).toHaveAttribute("aria-expanded", "false");
  await expect(similar).toContainText("Warnung");
  await similar.click();
  await expect(similar).toHaveAttribute("aria-expanded", "true");
  await expect(inbox.getByRole("button", { name: /^Zum Vorfall: / })).toHaveCount(2);
  // Both read with one command.
  const commands: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/command")) commands.push(String(r.postDataJSON()?.action));
  });
  const cluster = inbox.locator(".inbox-cluster");
  await cluster.hover();
  await cluster.getByRole("button", { name: "Alle davon als gelesen markieren" }).click();
  await expect(cluster).not.toHaveClass(/unread/);
  expect(commands).toEqual(["notification.bulk"]);
  // Older ones page by page.
  await expect(inbox.getByText(`Alt 99 ${tag}`)).toHaveCount(0);
  await inbox.getByRole("button", { name: "Ältere laden" }).click();
  await expect(inbox.getByText(`Alt 119 ${tag}`)).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Ältere laden" })).toHaveCount(0);
  // The badge counts every unread one, also beyond the first page.
  if (testInfo.project.name === "desktop") await expect(page.locator(".notification-count").first()).toHaveText("121");
  expect(errors).toEqual([]);
});
