import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// "KI fragen" with "Diese Seite" (#135) against a stub OpenAI-compatible
// provider: the chip is on with a page open and the page goes along with
// the question; "Als Änderungsvorschlag einfügen" puts the answer into the
// page as suggested changes – the code block's changed line struck through
// and the new one inserted – which are then accepted in the document. With
// the chip off, the page stays out of the request.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.AI_SUGGEST_SCREENSHOTS || "";
test.setTimeout(180_000);

const COMPOSE = "services:\n  db:\n    image: postgres:15\n  app:\n    image: flowplan";
const NEW_COMPOSE = COMPOSE.replace("postgres:15", "postgres:16");

type Mock = { base: string; prompts: { system: string; user: string }[]; close: () => Promise<void> };
async function startMock(): Promise<Mock> {
  const mock: Mock = { base: "", prompts: [], close: async () => {} };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const messages = (body.messages || []) as { role: string; content: string }[];
      const system = messages.find((m) => m.role === "system")?.content || "";
      const user = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n");
      mock.prompts.push({ system, user });
      // The edit request: the code block's handle from the numbered page.
      const block = /\[(B\d+)\] ```yaml/.exec(user)?.[1];
      const answer = system.startsWith("You propose changes to a page")
        ? `<edit op="replace" block="${block}">\n\`\`\`yaml\n${NEW_COMPOSE}\n\`\`\`\n</edit>`
        : user.includes("postgres:15")
          ? `Der Stack nutzt noch **postgres:15** [1]. So sieht der Codeblock mit Postgres 16 aus:\n\n\`\`\`yaml\n${NEW_COMPOSE}\n\`\`\``
          : "Dazu habe ich nichts gefunden.";
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

async function setup(page: Page, mock: Mock) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data: { workspaceId: boot.workspace.id, ...data } });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  await command({ action: "profile.onboarded" });
  await command({ action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: mock.base, model: "mock-model", embeddingModel: "" } } });
  await command({ action: "ai.settings", enabled: true });
  const stack = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: `Compose Stack ${Date.now()}`, kind: "document" });
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${stack.id}`)).json()).generation;
  const html = `<p>Unser Stack für die Datenbank.</p><pre><code class="language-yaml">${COMPOSE}</code></pre>`;
  await command({ action: "document.sync", pageId: stack.id, generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return { stack };
}

test("Ask AI with “This page”: the page goes along, the answer becomes suggested changes", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Desktop run");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mock = await startMock();
  try {
    const { stack } = await setup(page, mock);
    await page.goto(`/#page=${stack.id}`);
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    await expect(editor).toContainText("image: postgres:15", { timeout: 60_000 });
    await page.locator(".main-nav").getByRole("button", { name: "KI fragen" }).click();
    const panel = page.getByRole("complementary", { name: "KI fragen" });
    await expect(panel).toBeVisible();

    // On by default with a page open.
    const chip = panel.getByRole("button", { name: "Diese Seite", exact: true });
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    const field = panel.getByLabel("Deine Frage");
    await field.fill("Stell den Stack auf Postgres 16 um.");
    const asked = page.waitForRequest((r) => r.url().endsWith("/api/ai/ask"));
    await field.press("Enter");
    expect((await asked).postDataJSON().page).toEqual({ pageId: stack.id });
    const answer = panel.locator(".ai-ask-answer").last();
    await expect(answer).toContainText("postgres:16", { timeout: 30_000 });
    // The page is source 1, marked as this page.
    await expect(answer.locator(".ai-ask-sources")).toContainText("Diese Seite");
    expect(mock.prompts[mock.prompts.length - 1].user).toContain('art="aktuelle-seite"');
    if (shots) await page.screenshot({ path: `${shots}/ask-this-page.png` });

    // Suggested changes in the document – nothing overwritten.
    await answer.getByRole("button", { name: "Als Änderungsvorschlag einfügen" }).click();
    await expect(answer.locator(".ai-ask-suggest-result")).toContainText("1 Änderungsvorschlag ist in der Seite", { timeout: 30_000 });
    const code = editor.locator("pre");
    await expect(code.locator(".suggestion-delete")).toContainText("image: postgres:15", { timeout: 15_000 });
    await expect(code.locator(".suggestion-insert")).toContainText("image: postgres:16");
    await expect(code.locator(".suggestion-delete")).not.toContainText("services:");
    const bar = page.getByRole("region", { name: "Vorschläge" });
    await expect(bar).toContainText("1 Vorschlag");
    await bar.getByRole("button", { name: /Vorschlag/ }).first().click();
    await expect(bar.locator(".suggestion-item")).toHaveCount(2);
    await expect(bar.locator(".suggestion-item").first()).toContainText(/\(KI\)/);
    if (shots) await page.screenshot({ path: `${shots}/suggested-changes.png` });

    // Accepted in the document: only the new line remains.
    await bar.locator(".suggestion-item").first().getByRole("button", { name: "Annehmen" }).click();
    await expect(code).toContainText("image: postgres:16");
    await expect(code).not.toContainText("postgres:15");
    await expect(editor.locator(".suggestion-insert, .suggestion-delete")).toHaveCount(0);
    if (shots) await page.screenshot({ path: `${shots}/accepted.png` });

    // Switched off: the page stays out of the request.
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await field.fill("Und was steht sonst noch im Arbeitsbereich?");
    const second = page.waitForRequest((r) => r.url().endsWith("/api/ai/ask"));
    await field.press("Enter");
    expect((await second).postDataJSON().page).toBeUndefined();
    await expect(panel.locator(".ai-ask-answer").last()).not.toHaveClass(/streaming/, { timeout: 30_000 });
    await expect(panel.locator(".ai-ask-answer").last().getByRole("button", { name: "Als Änderungsvorschlag einfügen" })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await mock.close();
  }
});
