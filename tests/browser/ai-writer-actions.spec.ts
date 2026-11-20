import { test, expect, type Browser } from "@playwright/test";
import { keepInstanceAi } from "./instance-ai";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

keepInstanceAi();

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
            const answer = "Der Werkstoff 42CrMo4 ist ein Vergütungsstahl. Bis Freitag prüfen wir die Lieferung.";
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

// #400: "Aktionen vorschlagen" in the writing assistant opens "KI-Aktionen";
// the assistant sat above the dialog and covered its buttons. It now steps
// aside while the dialog is open and comes back with its answer.
test("the writing assistant steps aside for its actions dialog (#400)", async ({ page: demo, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  test.skip(info.project.name === "mobile", "Desktop run (⌘J)");
  await demo.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await demo.request.get("/api/bootstrap")).json();
  const { context, page } = await person(browser, boot.workspace.id, { width: 1304, height: 821 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const mock = await startMock(randomUUID());
  try {
    await command({ action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: mock.base, model: "mock", embeddingModel: "" } } });
    const id = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Werkstoffe ${Date.now()}`, kind: "document" })).id as string;
    await page.goto(`/#page=${id}`);
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await editor.click();
    await page.keyboard.press("Control+j");
    const writer = page.getByRole("dialog", { name: "KI-Schreibassistent" });
    await writer.getByRole("textbox").fill("Schreibe eine Dokumentation von 42CrMo4");
    await page.keyboard.press("Enter");
    await expect(writer.locator(".ai-preview")).toContainText("Vergütungsstahl");
    await writer.getByRole("button", { name: "Aktionen vorschlagen" }).click();
    const dialog = page.getByRole("dialog", { name: "KI-Aktionen" });
    await expect(dialog).toBeVisible();
    // The assistant is out of the way: the dialog's own buttons take clicks.
    await expect(page.locator(".ai-writer")).toBeHidden();
    const cancel = dialog.getByRole("button", { name: "Abbrechen" });
    await cancel.click({ trial: true });
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    // Back with its answer.
    await expect(writer).toBeVisible();
    await expect(writer.locator(".ai-preview")).toContainText("Vergütungsstahl");
    expect(errors).toEqual([]);
  } finally {
    await mock.close();
    await context.close();
  }
});
