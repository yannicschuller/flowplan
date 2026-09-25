import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

test("the inbox filters unread items and marks or removes single ones", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "notification.read" },
  });
  const tag = `${testInfo.project.name}${Date.now()}`;
  const db = new DatabaseSync(
    join(
      process.env.FLOWPLAN_DATA_DIR || join(process.cwd(), "data"),
      "flowplan.sqlite",
    ),
  );
  for (const body of [`Erste ${tag}`, `Zweite ${tag}`])
    db.prepare("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)").run(
      randomUUID(),
      boot.user.id,
      body,
    );
  db.close();
  await page.goto("/#inbox");
  const inbox = page.locator(".utility-content");
  const item = (text: string) =>
    inbox.locator(".notification-item").filter({ hasText: text });
  await expect(item(`Erste ${tag}`)).toHaveClass(/unread/);
  // Opening the inbox no longer marks everything as read.
  await page.reload();
  await expect(item(`Zweite ${tag}`)).toHaveClass(/unread/);
  await item(`Erste ${tag}`)
    .getByRole("button", { name: "Als gelesen markieren" })
    .click();
  await expect(item(`Erste ${tag}`)).not.toHaveClass(/unread/);
  await inbox.getByRole("radio", { name: /Ungelesen/ }).click();
  await expect(item(`Erste ${tag}`)).toHaveCount(0);
  await expect(item(`Zweite ${tag}`)).toBeVisible();
  await item(`Zweite ${tag}`)
    .getByRole("button", { name: `Benachrichtigung entfernen: Zweite ${tag}` })
    .click();
  await expect(item(`Zweite ${tag}`)).toHaveCount(0);
  await inbox.getByRole("radio", { name: "Alle" }).click();
  await item(`Erste ${tag}`)
    .getByRole("button", { name: "Als ungelesen markieren" })
    .click();
  await expect(item(`Erste ${tag}`)).toHaveClass(/unread/);
  await inbox
    .getByRole("button", { name: "Alle als gelesen markieren" })
    .click();
  await expect(item(`Erste ${tag}`)).not.toHaveClass(/unread/);
  expect(errors).toEqual([]);
});
