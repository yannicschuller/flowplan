import { test, expect, type Browser } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

// #134: "Liste alle Docker-Compose-Seiten mit Links auf" in the writing
// assistant, against a stub provider that writes every page as a plain
// list item with a preamble ("Sure!") – as models do. More pages than the
// eight offered by handle: the title index goes with the prompt, every item
// naming a page becomes a page link once the answer is complete, and the
// preamble never reaches the document.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.AI_LIST_SCREENSHOTS || "";
test.setTimeout(180_000);

type Mock = { base: string; prompts: string[]; close: () => Promise<void> };
async function startMock(): Promise<Mock> {
  const mock: Mock = { base: "", prompts: [], close: async () => {} };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const prompt = ((body.messages || []) as { role: string; content: string }[]).map((m) => m.content).join("\n");
      mock.prompts.push(prompt);
      // Every title the prompt names (handles and index), lower-cased and as plain text.
      const titles = [...prompt.matchAll(/^(?:P\d+: )?"([^"]+)"/gm)].map((m) => m[1]).filter((t) => t.includes("Stack"));
      const answer = ["Sure!", "", ...titles.map((t) => `- ${t.toLowerCase()}`)].join("\n");
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

async function person(browser: Browser, workspaceId: string) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `ai-list:${uid}`, "Ada", `${uid}@test.invalid`, Date.now());
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(workspaceId, uid, "editor");
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 3600_000);
  db.close();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "de-DE", extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" } });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return { context, page: await context.newPage() };
}

test("a list of all Docker Compose pages: every item a page link, no preamble", async ({ page: demo, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  test.skip(info.project.name === "mobile", "Desktop run (⌘J)");
  await demo.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await demo.request.get("/api/bootstrap")).json();
  const { context, page } = await person(browser, boot.workspace.id);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const mock = await startMock();
  try {
    await command({ action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: mock.base, model: "mock", embeddingModel: "" } } });
    const tag = Date.now().toString(36);
    const { htmlState } = await import("../../lib/document-server");
    const pages: { id: string; title: string }[] = [];
    for (const name of ["n8n", "Flowplan", "fredy", "openwebui", "it-tools", "Mailflow", "Pocketid", "Paperless", "Immich", "Gitea", "Vaultwarden"]) {
      const title = `🐳 ${name} Stack ${tag}`;
      const { id } = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" });
      const generation = (await (await page.request.get(`/api/pages/${id}`)).json()).generation;
      await command({ action: "document.sync", pageId: id, generation, update: Buffer.from(htmlState(`<p>Docker Compose ${tag} für ${name}.</p>`)).toString("base64") });
      pages.push({ id, title });
    }
    const notes = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Homelab ${tag}`, kind: "document" });

    await page.goto(`/#page=${notes.id}`);
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 60_000 });
    await editor.click();
    await page.keyboard.press("Control+j");
    const writer = page.getByRole("dialog", { name: "KI-Schreibassistent" });
    await expect(writer.getByRole("checkbox", { name: "Mit bestehenden Seiten verlinken" })).toBeChecked();
    await writer.getByRole("textbox").fill(`Liste alle Docker Compose ${tag} Seiten mit Links auf.`);
    await page.keyboard.press("Enter");
    // Every page a link in the preview – more than the eight offered by handle.
    for (const p of pages) await expect(writer.locator(`.ai-preview a[href="/#page=${p.id}"]`)).toHaveCount(1, { timeout: 30_000 });
    expect(mock.prompts[mock.prompts.length - 1]).toContain("<index>");
    await expect(writer.locator(".ai-preview")).not.toContainText("Sure");
    if (shots) await page.screenshot({ path: `${shots}/list-preview.png` });
    await writer.getByRole("button", { name: "Einfügen", exact: true }).click();
    for (const p of pages) await expect(editor.locator(`a[href="/#page=${p.id}"]`)).toHaveCount(1);
    await expect(editor).not.toContainText("Sure");
    // One item per page (the stub also lists stacks of earlier runs).
    expect(await editor.locator("li").count()).toBeGreaterThanOrEqual(pages.length);
    if (shots) await page.screenshot({ path: `${shots}/list-inserted.png` });
    expect(errors).toEqual([]);
  } finally {
    await mock.close();
    await context.close();
  }
});
