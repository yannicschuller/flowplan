import { test, expect, type Browser } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

// The writing assistant links existing pages (lib/ai/links.ts) against a
// mock OpenAI-compatible provider: the prompt lists pages by handle, the
// answer's handles show as links in the preview with "Verlinkt: …", and
// "Einfügen" puts real page links into the document. Invented handles and
// addresses the model writes itself stay text. "Mit bestehenden Seiten
// verlinken" switched off is remembered and sends no pages.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.AI_LINKS_SCREENSHOTS || "";
test.setTimeout(120_000);

type Mock = { base: string; prompts: string[]; title: string; close: () => Promise<void> };
async function startMock(foreign: string): Promise<Mock> {
  const mock: Mock = { base: "", prompts: [], title: "", close: async () => {} };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const prompt = ((body.messages || []) as { role: string; content: string }[]).map((m) => m.content).join("\n");
      mock.prompts.push(prompt);
      // Links the budget page by its handle – and tries an invented handle
      // and an address of its own.
      const handle = prompt.split("\n").find((line) => line.includes(`: "${mock.title}"`))?.split(":")[0];
      const answer = handle
        ? `Für den Umzug ins neue Büro planen wir mit dem [[${handle}]]. Mehr steht [hier](flowplan:P9) und [dort](/#page=${foreign}).`
        : "Für den Umzug ins neue Büro planen wir gründlich.";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  mock.close = () => new Promise((resolve) => server.close(() => resolve()));
  return mock;
}

// A signed-in instance administrator, member of the workspace.
async function person(browser: Browser, workspaceId: string, viewport: { width: number; height: number }) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `ai-links:${uid}`, "Ada", `${uid}@test.invalid`, Date.now());
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(workspaceId, uid, "editor");
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 3600_000);
  db.close();
  const context = await browser.newContext({ viewport, locale: "de-DE", extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" } });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return { context, page: await context.newPage() };
}

test("the writing assistant links existing pages: preview, list, real links; switch remembered", async ({ page: demo, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  test.skip(info.project.name === "mobile", "Desktop run (⌘J)");
  const errors: string[] = [];
  await demo.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await demo.request.get("/api/bootstrap")).json();
  const { context, page } = await person(browser, boot.workspace.id, { width: 1280, height: 900 });
  page.on("pageerror", (e) => errors.push(e.message));
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const foreign = randomUUID();
  const mock = await startMock(foreign);
  try {
    await command({ action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: mock.base, model: "mock", embeddingModel: "" } } });
    const tag = Date.now();
    const create = async (title: string) =>
      (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" })).id as string;
    const budget = await create(`Umzugsbudget ${tag}`);
    mock.title = `Umzugsbudget ${tag}`;
    const notes = await create(`Umzugsnotizen ${tag}`);

    await page.goto(`/#page=${notes}`);
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await editor.click();
    await page.keyboard.press("Control+j");
    const writer = page.getByRole("dialog", { name: "KI-Schreibassistent" });
    await expect(writer).toBeVisible();
    const toggle = writer.getByRole("checkbox", { name: "Mit bestehenden Seiten verlinken" });
    await expect(toggle).toBeChecked();
    await writer.getByRole("textbox").fill(`Schreib über den Umzug und das Umzugsbudget ${tag}.`);
    if (shots) await page.screenshot({ path: `${shots}/choose.png` });
    await page.keyboard.press("Enter");
    const link = writer.locator(`.ai-preview a[href="/#page=${budget}"]`);
    await expect(link).toHaveText(`Umzugsbudget ${tag}`);
    await expect(writer.locator(".ai-writer-linked")).toHaveText(`Verlinkt: Umzugsbudget ${tag}`);
    // Only the offered page is a link; the rest stays text.
    await expect(writer.locator(".ai-preview a")).toHaveCount(1);
    await expect(writer.locator(".ai-preview")).toContainText("Mehr steht hier und dort.");
    // The model saw handles and titles, no ids.
    const prompt = mock.prompts[mock.prompts.length - 1];
    expect(prompt).toContain(`"Umzugsbudget ${tag}"`);
    expect(prompt).not.toContain(budget);
    expect(prompt).not.toContain(`: "Umzugsnotizen ${tag}"`);
    if (shots) await page.screenshot({ path: `${shots}/preview.png` });
    await writer.getByRole("button", { name: "Einfügen", exact: true }).click();
    await expect(editor.locator(`a[href="/#page=${budget}"]`)).toHaveText(`Umzugsbudget ${tag}`);
    await expect(editor.locator("a")).toHaveCount(1);
    if (shots) await page.screenshot({ path: `${shots}/inserted.png` });

    // An action on a selection links as well.
    await editor.locator("p").first().click({ clickCount: 3 });
    await page.keyboard.press("Control+j");
    await expect(toggle).toBeChecked();
    if (shots) await page.screenshot({ path: `${shots}/selection.png` });
    await writer.getByRole("menuitem", { name: /Umformulieren/ }).click();
    await expect(writer.locator(`.ai-preview a[href="/#page=${budget}"]`)).toHaveText(`Umzugsbudget ${tag}`);
    await expect(writer.locator(".ai-writer-linked")).toContainText(`Umzugsbudget ${tag}`);
    await writer.getByRole("button", { name: "Verwerfen" }).click();
    await expect(writer).toHaveCount(0);
    await editor.locator("p").first().click();

    // Switched off: remembered, and no pages go with the request.
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+j");
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await writer.getByRole("textbox").fill(`Noch ein Satz zum Umzugsbudget ${tag}.`);
    const request = page.waitForRequest((r) => r.url().endsWith("/api/ai/write"));
    await page.keyboard.press("Enter");
    expect((await request).postDataJSON().links).toBeUndefined();
    await expect(writer.locator(".ai-preview")).toContainText("planen wir gründlich");
    await expect(writer.locator(".ai-writer-linked")).toHaveCount(0);
    await writer.getByRole("button", { name: "Verwerfen" }).click();
    await page.reload();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+j");
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    expect(errors).toEqual([]);
  } finally {
    await mock.close();
    await context.close();
  }
});
