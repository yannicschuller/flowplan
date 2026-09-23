import { test, expect, type Page } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
async function session(page: Page) {
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
  return { origin, boot, command };
}
async function nav(page: Page, name: string, mobile: boolean) {
  if (
    mobile &&
    !(await page.locator(".app-shell").getAttribute("class"))?.includes(
      "nav-open",
    )
  )
    await page
      .getByRole("button", { name: "Navigation öffnen", exact: true })
      .click();
  await page
    .locator("aside.sidebar")
    .getByRole("button", { name, exact: true })
    .click();
}
async function switchWorkspace(page: Page, name: string, mobile: boolean) {
  if (mobile)
    await page
      .getByRole("button", { name: "Navigation öffnen", exact: true })
      .click();
  await page.locator(".workspace-switch").click();
  await page.getByRole("menuitem").filter({ hasText: name }).click();
  await expect(page.locator(".workspace-switch")).toContainText(name);
}
test("space owners rename, trash, restore and purge with stale-draft protection and mobile confirmation", async ({
  page,
}, info) => {
  let release = () => {};
  try {
    const f = await session(page),
      mobile = info.project.name === "mobile",
      name = `Lifecycle area ${info.project.name} ${Date.now()}`;
    const area = await f.command({
      action: "space.create",
      workspaceId: f.boot.workspace.id,
      name,
      private: false,
    });
    const root = await f.command({
      action: "page.create",
      workspaceId: f.boot.workspace.id,
      spaceId: area.id,
      title: "Lifecycle page",
    });
    const child = await f.command({
      action: "page.create",
      workspaceId: f.boot.workspace.id,
      spaceId: area.id,
      parentId: root.id,
      title: "Lifecycle child",
    });
    const old = await f.command({
      action: "page.create",
      workspaceId: f.boot.workspace.id,
      spaceId: area.id,
      title: "Previously trashed",
    });
    await f.command({ action: "page.delete", pageId: old.id });
    const share = await f.command({
      action: "share.create",
      pageId: root.id,
      name: "Lifecycle visitor",
      role: "viewer",
      includeChildren: true,
    });
    await page.goto(`/#page=${root.id}`);
    if (mobile)
      await page
        .getByRole("button", { name: "Navigation öffnen", exact: true })
        .click();
    await page
      .getByRole("button", { name: `Bereich ${name} verwalten`, exact: true })
      .click();
    let dialog = page.getByRole("dialog", {
      name: "Bereich verwalten",
      exact: true,
    });
    await dialog.getByLabel("Name", { exact: true }).fill(name + " draft");
    await f.command({
      action: "space.update",
      spaceId: area.id,
      name: name + " remote",
      private: false,
      version: 1,
    });
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "inzwischen geändert",
    );
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
      name + " draft",
    );
    await dialog
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    await page.reload();
    if (mobile)
      await page
        .getByRole("button", { name: "Navigation öffnen", exact: true })
        .click();
    await page
      .getByRole("button", {
        name: `Bereich ${name} remote verwalten`,
        exact: true,
      })
      .click();
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    if (mobile)
      await page
        .locator(".mobile-scrim")
        .click({ position: { x: page.viewportSize()!.width - 10, y: 10 } });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/command", async (route) => {
      const data = route.request().postDataJSON();
      if (
        data.action === "document.sync" &&
        data.html?.includes("Draft before area deletion")
      )
        await gate;
      await route.continue();
    });
    const pending = page.waitForRequest(
      (req) =>
        req.url().endsWith("/api/command") &&
        req.postDataJSON()?.html?.includes("Draft before area deletion"),
    );
    await page.getByLabel("Dokumentinhalt", { exact: true }).click();
    await page.keyboard.insertText("Draft before area deletion");
    await pending;
    expect(
      (await (await page.request.get(`/api/pages/${root.id}`)).json()).html,
    ).not.toContain("Draft before area deletion");
    if (mobile)
      await page
        .getByRole("button", { name: "Navigation öffnen", exact: true })
        .click();
    await page
      .getByRole("button", { name: `Bereich ${name} verwalten`, exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Bereich löschen", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Bereich in den Papierkorb verschieben",
      exact: true,
    });
    await expect(
      dialog.getByRole("button", { name: "In den Papierkorb", exact: true }),
    ).toBeDisabled();
    await dialog.getByLabel("Bereichsname zur Bestätigung").fill(name);
    await expect(dialog).toHaveCSS("opacity", "1");
    await expect(page.locator(".modal-overlay")).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: `test-results/${info.project.name}-space-delete.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await dialog
      .getByRole("button", { name: "In den Papierkorb", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    release();
    await page.unrouteAll({ behavior: "wait" });
    expect((await page.request.get(`/api/pages/${root.id}`)).status()).toBe(
      404,
    );
    expect((await page.request.get(`/api/share/${share.token}`)).status()).toBe(
      404,
    );
    await nav(page, "Papierkorb", mobile);
    let row = page.locator(".trash-space").filter({ hasText: name });
    await row
      .getByRole("button", { name: "Bereich wiederherstellen", exact: true })
      .click();
    await expect(row).toHaveCount(0);
    expect((await page.request.get(`/api/pages/${child.id}`)).ok()).toBe(true);
    expect(
      (await (await page.request.get(`/api/pages/${root.id}`)).json()).html,
    ).toContain("Draft before area deletion");
    expect((await page.request.get(`/api/pages/${old.id}`)).status()).toBe(404);
    expect((await page.request.get(`/api/share/${share.token}`)).status()).toBe(
      404,
    );
    await nav(page, "Einstellungen", mobile);
    await page.getByRole("button", { name: "Bereiche", exact: true }).click();
    await page
      .locator(".utility-row")
      .filter({ hasText: name })
      .getByRole("button", { name: "Verwalten", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Bereich verwalten", exact: true })
      .getByRole("button", { name: "Bereich löschen", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Bereich in den Papierkorb verschieben",
      exact: true,
    });
    await dialog.getByLabel("Bereichsname zur Bestätigung").fill(name);
    await dialog
      .getByRole("button", { name: "In den Papierkorb", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await nav(page, "Papierkorb", mobile);
    row = page.locator(".trash-space").filter({ hasText: name });
    await row
      .getByRole("button", { name: "Endgültig löschen", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Bereich endgültig löschen",
      exact: true,
    });
    await dialog.getByLabel("Bereichsname zur Bestätigung").fill(name);
    await dialog
      .getByRole("button", { name: "Endgültig löschen", exact: true })
      .click();
    await expect(row).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" }).catch(() => {});
  }
});

test("workspace owners delete a confirmed workspace with uploads and revoke its public links", async ({
  page,
  browser,
}, info) => {
  const f = await session(page),
    mobile = info.project.name === "mobile",
    name = `Lifecycle workspace ${info.project.name} ${Date.now()}`;
  const workspace = await f.command({ action: "workspace.create", name });
  const boot = await (
      await page.request.get(`/api/bootstrap?workspace=${workspace.id}`)
    ).json(),
    root = boot.pages[0];
  const upload = await page.request.post("/api/upload", {
    headers: { origin: f.origin },
    multipart: {
      pageId: root.id,
      file: {
        name: "lifecycle.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("temporary fixture"),
      },
    },
  });
  expect(upload.ok()).toBe(true);
  const file = await upload.json();
  const share = await f.command({
    action: "share.create",
    pageId: root.id,
    role: "viewer",
    name: "Delete visitor",
  });
  await page.goto("/");
  await switchWorkspace(page, name, mobile);
  await nav(page, "Einstellungen", mobile);
  await expect(
    page.getByRole("button", { name: "Arbeitsbereich verlassen", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Arbeitsbereich löschen", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Arbeitsbereich endgültig löschen",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Endgültig löschen", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Arbeitsbereichsname zur Bestätigung").fill("wrong");
  await expect(
    dialog.getByRole("button", { name: "Endgültig löschen", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Arbeitsbereichsname zur Bestätigung").fill(name);
  await expect(dialog).toHaveCSS("opacity", "1");
  await expect(page.locator(".modal-overlay")).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: `test-results/${info.project.name}-workspace-delete.png`,
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await dialog
    .getByRole("button", { name: "Endgültig löschen", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".workspace-switch")).not.toContainText(name);
  expect((await page.request.get(file.url)).status()).toBe(404);
  const visitor = await browser.newContext();
  try {
    expect(
      (
        await visitor.request.get(`${f.origin}/api/share/${share.token}`)
      ).status(),
    ).toBe(404);
  } finally {
    await visitor.close();
  }
  expect(
    (await (await page.request.get("/api/bootstrap")).json()).workspaces.some(
      (w: { id: string }) => w.id === workspace.id,
    ),
  ).toBe(false);
});

test("leaving a workspace transfers private areas and removes the leaving member without signing out", async ({
  page,
  browser,
}, info) => {
  const f = await session(page),
    mobile = info.project.name === "mobile",
    name = `Lifecycle leave ${info.project.name} ${Date.now()}`;
  const workspace = await f.command({ action: "workspace.create", name });
  const db = new DatabaseSync(
    join(
      process.env.FLOWPLAN_DATA_DIR || join(process.cwd(), "data"),
      "flowplan.sqlite",
    ),
  );
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const run = (sql: string, ...args: (string | number)[]) =>
    db.prepare(sql).run(...args);
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex"),
    subject = `lifecycle-test:${uid}`;
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    subject,
    "Lifecycle member",
    `${uid}@example.test`,
  );
  run("INSERT INTO members VALUES(?,?,?)", workspace.id, uid, "editor");
  run(
    "INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)",
    createHash("sha256").update(token).digest("hex"),
    uid,
    "[]",
    Date.now() + 300000,
  );
  const member = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: mobile,
  });
  try {
    await member.addCookies([
      {
        name: "flowplan_session",
        value: token,
        url: f.origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const own = await member.request.post(`${f.origin}/api/command`, {
      headers: { origin: f.origin },
      data: {
        action: "space.create",
        workspaceId: workspace.id,
        name: "Member private area",
        private: true,
      },
    });
    expect(own.ok()).toBe(true);
    const area = await own.json();
    const tab = await member.newPage();
    await tab.goto(f.origin + "/");
    await nav(tab, "Einstellungen", mobile);
    await expect(
      tab.getByRole("button", { name: "Arbeitsbereich löschen", exact: true }),
    ).toHaveCount(0);
    await tab
      .getByRole("button", { name: "Arbeitsbereich verlassen", exact: true })
      .click();
    const dialog = tab.getByRole("dialog", {
      name: "Arbeitsbereich verlassen",
      exact: true,
    });
    await expect(
      dialog.getByLabel("Eigene Bereiche übertragen an"),
    ).toHaveValue(f.boot.user.id);
    await dialog.getByLabel("Arbeitsbereichsname zur Bestätigung").fill(name);
    await dialog
      .getByRole("button", { name: "Verlassen", exact: true })
      .click();
    await expect(tab.locator(".workspace-switch")).not.toContainText(name);
    const current = await (
      await member.request.get(`${f.origin}/api/bootstrap`)
    ).json();
    expect(current.user.id).toBe(uid);
    expect(
      current.workspaces.some((w: { id: string }) => w.id === workspace.id),
    ).toBe(false);
    const remaining = await (
      await page.request.get(`/api/bootstrap?workspace=${workspace.id}`)
    ).json();
    expect(
      remaining.spaces.find((s: { id: string }) => s.id === area.id).owner_id,
    ).toBe(f.boot.user.id);
  } finally {
    await member.close();
    await f.command({
      action: "workspace.delete",
      workspaceId: workspace.id,
      confirmName: name,
    });
    // Only this test-created account's automatically seeded workspace and account are removed.
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const w of db
        .prepare("SELECT id FROM workspaces WHERE created_by=?")
        .all(uid) as { id: string }[]) {
        run("DELETE FROM templates WHERE workspace_id=?", w.id);
        run("DELETE FROM invites WHERE workspace_id=?", w.id);
        run("DELETE FROM workspaces WHERE id=?", w.id);
      }
      run("DELETE FROM users WHERE id=? AND subject=?", uid, subject);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }
});
