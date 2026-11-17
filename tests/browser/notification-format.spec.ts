import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// Formatted notification messages (#330): a database rule's message gets
// bold, a link, a mention of a member and a formula in the small editor;
// a new record triggers it, and the inbox shows the notification formatted
// – the link in a new tab, the person as a chip, the formula with KaTeX.
// SHOTS_DIR: screenshots of the editor and the inbox entry (light, dark).
const press = async (page: Page, key: string, times = 1) => {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(60);
  }
};

async function select(editor: Locator, word: string) {
  await editor.focus();
  await editor.page().waitForTimeout(100);
  await editor.evaluate((root, word) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(word);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`"${word}" not found`);
  }, word);
  await expect(editor.page().getByRole("toolbar", { name: "Formatieren" })).toBeVisible();
  await editor.page().waitForTimeout(200);
}

async function shots(page: Page, target: Locator, name: string, project: string) {
  const dir = process.env.SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await target.screenshot({ path: join(dir, `${name}-${project}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("a rule's message with bold, a link, a mention and a formula shows formatted in the inbox", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
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
  await command({ action: "profile.onboarded" });
  // A second member to mention.
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const mia = randomUUID();
  // The projects share the demo workspace: a name of its own each.
  const name = info.project.name === "mobile" ? "Mia Moll" : "Mia Dahl";
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(mia, `mia:${mia}`, name, `${mia}@example.test`, Date.now());
  db.prepare("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')").run(boot.workspace.id, mia);
  db.close();

  const base = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Benachrichtigt ${info.project.name} ${Date.now()}`, kind: "database" });
  const read = async () => (await page.request.get(`/api/pages/${base.id}`)).json();
  const first = await read();
  await command({ action: "database.update", pageId: base.id, version: first.database.version, fields: [{ id: "title", name: "Name", type: "text" }], views: first.database.views });

  await page.goto(`/#page=${base.id}`);
  await page.getByRole("button", { name: "Weitere Werkzeuge" }).click();
  await page.getByRole("menuitem", { name: /Automationen/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Eigene Regel" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Neu gemeldet");
  const message = dialog.getByRole("textbox", { name: "Nachricht", exact: true });
  await message.click();
  await page.keyboard.type("Bitte Handbuch lesen, ");
  // "@Mia D" opens the list of members; Enter takes Mia.
  await page.keyboard.type(`@${name.slice(0, 5)}`);
  const list = dialog.getByRole("listbox", { name: "Mitglieder" });
  await expect(list.getByRole("option", { name: new RegExp(name) })).toBeVisible();
  await press(page, "Enter");
  await expect(message.locator(".mention")).toHaveText(`@${name}`);
  await page.keyboard.type("rechnet $E=mc^2$ nach.");
  await expect(message.locator(".math-inline .katex")).toBeVisible();
  // "Bitte" bold, "Handbuch" a link.
  await select(message, "Bitte");
  const bar = dialog.getByRole("toolbar", { name: "Formatieren" });
  await expect(bar.getByRole("button", { name: /^Unterstrichen/ })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Als Formel" })).toBeVisible();
  await press(page, "ControlOrMeta+b");
  await expect(message.locator("strong")).toHaveText("Bitte");
  await select(message, "Handbuch");
  await press(page, "ControlOrMeta+k");
  const address = dialog.getByRole("textbox", { name: "Link-Adresse" });
  await address.fill("example.com/handbuch");
  await address.press("Enter");
  await expect(message.locator("a")).toHaveText("Handbuch");
  // (A click on the formula would turn it back into its text to change it.)
  await message.focus();
  await expect(message.locator(".math-inline .katex")).toBeVisible();
  await shots(page, dialog.locator(".automation-editor"), "editor", info.project.name);
  await dialog.getByRole("button", { name: "Regel speichern" }).click();
  await expect(dialog.getByText("Neu gemeldet")).toBeVisible();
  const stored = JSON.stringify((await read()).database.settings);
  expect(stored).toContain(`**Bitte** [Handbuch](https://example.com/handbuch) lesen, [@${name}]{data-mention=${mia}} rechnet $E=mc^2$ nach.`);
  await page.keyboard.press("Escape");

  // A new record notifies its creator (the demo account).
  await command({ action: "row.create", pageId: base.id, cells: { title: "Vertrag **A**" } });
  await page.goto("/#inbox");
  await page.reload();
  const entry = page.locator("[data-notification-formatted]").first();
  await expect(entry).toBeVisible();
  await expect(entry.locator("strong")).toHaveText("Bitte");
  const link = entry.getByRole("link", { name: "Handbuch" });
  await expect(link).toHaveAttribute("href", "https://example.com/handbuch");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(entry.locator(`.mention[data-mention="${mia}"]`)).toHaveText(`@${name}`);
  await expect(entry.locator(".math-inline .katex")).toBeVisible();
  // The record's title stays literal.
  await expect(entry).toContainText("„Vertrag **A**“");
  // No style attributes from the text (KaTeX's own markup sizes itself, as in documents).
  expect(await entry.locator("[style]:not(.katex, .katex *)").count()).toBe(0);
  await shots(page, page.locator(".notification-item").first(), "inbox", info.project.name);
  // The arrow opens the record.
  await entry.getByRole("button", { name: /^Öffnen:/ }).click();
  await expect(page).toHaveURL(new RegExp(`page=${base.id}`));

  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: base.id });
});

test("a workflow's message: placeholders as chips, the picker, and values that stay text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Editing workflows is for tablets and computers.");
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
  const node = (id: string, type: string, label: string, config: Record<string, unknown>, x = 0) => ({ id, type, typeVersion: 1, label, note: "", position: { x, y: 0 }, disabled: false, config });
  const workflow = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Formatiert melden ${Date.now()}`, kind: "workflow" })).id as string;
  await command({
    action: "workflow.draft",
    pageId: workflow,
    graph: {
      nodes: [
        node("n_start001", "trigger.manual", "Start", { inputs: [{ name: "name", type: "text", required: true }] }),
        node("n_tell0001", "notify.person", "Melden", { to: [boot.user.id], title: "", message: "**Hallo** {{n_start001.inputs.name}} – $x^2$", channels: ["inbox"] }, 300),
      ],
      edges: [{ id: "e_1", from: { node: "n_start001", port: "out" }, to: { node: "n_tell0001", port: "in" } }],
    },
  });
  await page.goto(`/#page=${workflow}`);
  await page.locator(".react-flow__node", { hasText: "Melden" }).click();
  const panel = page.locator(".wf-panel");
  const message = panel.getByRole("textbox", { name: "Nachricht", exact: true });
  await expect(message.locator("strong")).toHaveText("Hallo");
  await expect(message.locator(".rich-text-placeholder")).toHaveText("Start.inputs.name");
  await expect(message.locator(".math-inline .katex")).toBeVisible();
  // The picker inserts a chip at the cursor.
  await message.focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" von ");
  await panel.getByRole("button", { name: "Platzhalter einfügen in „Nachricht“" }).click();
  await page.getByRole("dialog", { name: "Platzhalter wählen" }).getByRole("option", { name: /^\$Heute/ }).click();
  await expect(message.locator(".rich-text-placeholder")).toHaveCount(2);
  await shots(page, panel, "workflow-editor", info.project.name);
  await expect.poll(async () => JSON.stringify((await command({ action: "workflow.validate", pageId: workflow })).issues)).not.toContain('"error"');

  expect((await command({ action: "workflow.activate", pageId: workflow })).ok).toBe(true);
  await command({ action: "workflow.run", pageId: workflow, inputs: { name: "**fett** $y$ [x](https://evil.example)" } });
  await page.goto("/#inbox");
  await page.reload();
  const entry = page.locator("[data-notification-formatted]", { hasText: "fett" }).first();
  await expect(entry.locator("strong")).toHaveText("Hallo");
  await expect(entry).toContainText("**fett** $y$ [x](https://evil.example)");
  await expect(entry.locator(".math-inline")).toHaveCount(1);
  expect(await entry.getByRole("link").count()).toBe(0);
  expect(errors).toEqual([]);
  await command({ action: "workflow.pause", pageId: workflow });
});
