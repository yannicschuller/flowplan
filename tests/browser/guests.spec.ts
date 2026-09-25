import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

test("owners turn members into guests who only see shared pages", async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const mobile = testInfo.project.name === "mobile";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const tag = `${testInfo.project.name}${Date.now()}`;
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const workspace = boot.workspace;
  const space = boot.spaces[0].id;
  const create = (title: string) =>
    command({
      action: "page.create",
      workspaceId: workspace.id,
      spaceId: space,
      title,
    });
  const shared = await create(`Abstimmung ${tag}`),
    internal = await create(`Intern ${tag}`);
  // A second person with their own session.
  const db = new DatabaseSync(
    join(
      process.env.FLOWPLAN_DATA_DIR || join(process.cwd(), "data"),
      "flowplan.sqlite",
    ),
  );
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(
    uid,
    `guest-test:${uid}`,
    `Gast ${tag}`,
    `${uid}@example.test`,
  );
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(
    workspace.id,
    uid,
    "editor",
  );
  db.prepare(
    "INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)",
  ).run(
    createHash("sha256").update(token).digest("hex"),
    uid,
    "[]",
    Date.now() + 300000,
  );
  db.close();

  // The owner shares one page and marks the person as guest.
  await command({
    action: "grant.set",
    resourceId: shared.id,
    userId: uid,
    role: "editor",
  });
  await page.goto("/#settings");
  await page.getByRole("button", { name: "Mitglieder", exact: true }).click();
  await page
    .getByRole("button", { name: `Gast ${tag} zum Gast machen` })
    .click();
  await expect(
    page
      .locator(".member-row")
      .filter({ hasText: `Gast ${tag}` })
      .locator(".tag-yellow"),
  ).toHaveText("Gast");

  const guest = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: mobile,
  });
  try {
    await guest.addCookies([
      {
        name: "flowplan_session",
        value: token,
        url: origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const view = await guest.newPage();
    await view.goto(`${origin}/#page=${shared.id}`);
    await expect(
      view.locator(".sidebar").getByText(`Abstimmung ${tag}`),
    ).toBeVisible();
    await expect(view.locator(".sidebar")).not.toContainText(`Intern ${tag}`);
    const pageList = await (
      await view.request.get(
        `${origin}/api/bootstrap?workspace=${workspace.id}`,
      )
    ).json();
    expect(pageList.pages.map((p: { title: string }) => p.title)).toEqual([
      `Abstimmung ${tag}`,
    ]);
    expect(pageList.members.map((m: { id: string }) => m.id)).toEqual([uid]);
    expect(pageList.workspace.guest).toBe(1);
    const hidden = await view.request.get(`${origin}/api/pages/${internal.id}`);
    expect(hidden.status()).toBe(403);
    const denied = await view.request.post(`${origin}/api/command`, {
      headers: { origin },
      data: {
        action: "page.create",
        workspaceId: workspace.id,
        spaceId: space,
        title: "x",
      },
    });
    expect(denied.status()).toBe(403);
  } finally {
    await guest.close();
  }
  expect(errors).toEqual([]);
});
