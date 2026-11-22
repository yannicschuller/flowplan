import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { keepInstanceAi } from "./instance-ai";

keepInstanceAi();

// #431: a bulleted list selected, "ändern zu aufgaben zum abhaken" – the
// preview showed the same list and "Ersetzen" put back bullets. Now the
// prompt names the Markdown tasks ("- [ ] …") and allows another block type,
// and the answer's tasks become task items: with the server's AI (a mock
// OpenAI-compatible provider), with the on-device AI (a stubbed
// window.FlowplanApp.ai writing checkboxes as "☐ …"), and "Umwandeln in →
// Aufgaben" without any AI request.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
test.setTimeout(120_000);

type Mock = { base: string; prompts: string[]; close: () => Promise<void> };
async function startMock(answer: string): Promise<Mock> {
  const mock: Mock = { base: "", prompts: [], close: async () => {} };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      mock.prompts.push(((body.messages || []) as { content: string }[]).map((m) => m.content).join("\n"));
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

async function stubDevice(page: Page, answer: string) {
  await page.addInitScript((answer: string) => {
    (window as unknown as Record<string, unknown>).__devicePrompts = [];
    (window as unknown as Record<string, unknown>).FlowplanApp = {
      platform: "ios",
      version: "test",
      ai: {
        version: 1,
        availability: async () => ({ available: true, languages: ["de", "en", "fr"] }),
        generate: async () => ({ text: answer }),
        stream: async (request: { instructions?: string; prompt: string }, onChunk: (text: string) => void) => {
          ((window as unknown as Record<string, unknown>).__devicePrompts as unknown[]).push(request);
          onChunk(answer);
          return { text: answer };
        },
        cancel: () => {},
      },
    };
  }, answer);
}

// A page with a bulleted list "Milch, Brot", the list selected; the AI on
// the server set up as given (or off).
async function setup(page: Page, ai: Record<string, unknown>) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  await command({ action: "admin.ai", settings: ai });
  const id = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Einkauf ${Date.now()}`, kind: "document" })).id as string;
  const aiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/ai/") && request.method() === "POST") aiRequests.push(new URL(request.url()).pathname);
  });
  await page.goto(`/#page=${id}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await editor.click();
  await page.keyboard.type("Vorher");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- Milch");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Brot");
  await expect(editor.locator("ul:not([data-type]) > li")).toHaveCount(2);
  // From the end of "Brot" back to the start of "Milch".
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Control+j");
  const writer = page.getByRole("dialog", { name: "KI-Schreibassistent" });
  await expect(writer).toBeVisible();
  return { editor, writer, aiRequests };
}

async function expectTasks(editor: ReturnType<Page["locator"]>) {
  const items = editor.locator('ul[data-type="taskList"] > li');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Milch");
  await expect(items.nth(1)).toContainText("Brot");
  await expect(items.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(editor.locator("ul:not([data-type]) > li")).toHaveCount(0);
  await expect(editor).toContainText("Vorher");
}

test("server AI: “ändern zu aufgaben zum abhaken” on a list – preview and Ersetzen give task items", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  test.skip(info.project.name === "mobile", "Desktop run (⌘J)");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mock = await startMock("- [ ] Milch\n- [ ] Brot");
  try {
    const { editor, writer } = await setup(page, { enabled: true, provider: { kind: "openai", baseUrl: mock.base, model: "mock", embeddingModel: "" } });
    await writer.getByRole("textbox").fill("ändern zu aufgaben zum abhaken");
    await page.keyboard.press("Enter");
    const preview = writer.locator(".ai-preview");
    await expect(preview.locator('ul[data-type="taskList"] > li[data-type="taskItem"]')).toHaveCount(2);
    // The model saw the list as a list, and that it may change the block type.
    const prompt = mock.prompts.at(-1)!;
    expect(prompt).toContain("<text>\n- Milch\n- Brot\n</text>");
    expect(prompt).toContain('"- [ ] " tasks to tick off');
    expect(prompt).toContain("change the block type itself");
    await writer.getByRole("button", { name: "Ersetzen" }).click();
    await expect(writer).toHaveCount(0);
    await expectTasks(editor);
    expect(errors).toEqual([]);
  } finally {
    await mock.close();
  }
});

test("on-device AI: checkboxes written as “☐ …” become task items", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Desktop run (⌘J)");
  await stubDevice(page, "☐ Milch\n☐ Brot");
  const { editor, writer, aiRequests } = await setup(page, { enabled: false });
  await writer.getByRole("textbox").fill("ändern zu aufgaben zum abhaken");
  await page.keyboard.press("Enter");
  await expect(writer.locator(".ai-device-chip")).toHaveText("Auf diesem Gerät");
  await expect(writer.locator('.ai-preview ul[data-type="taskList"] > li')).toHaveCount(2);
  const [request] = await page.evaluate(() => (window as unknown as { __devicePrompts: { instructions: string; prompt: string }[] }).__devicePrompts);
  expect(request.prompt).toContain("Text:\n- Milch\n- Brot");
  expect(request.instructions).toContain("„- [ ] Aufgabe“");
  await writer.getByRole("button", { name: "Ersetzen" }).click();
  await expectTasks(editor);
  expect(aiRequests).toEqual([]);
});

test("Umwandeln in → Aufgaben, then → Nummerierte Liste: locally, no AI request", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Desktop run (⌘J)");
  await stubDevice(page, "nicht benutzt");
  const { editor, writer, aiRequests } = await setup(page, { enabled: false });
  await writer.getByRole("menuitem", { name: /Umwandeln in/ }).click();
  await writer.getByRole("group", { name: "Umwandeln in" }).getByRole("button", { name: "Aufgaben" }).click();
  await expect(writer).toHaveCount(0);
  await expectTasks(editor);
  // Back: select the tasks again, as a numbered list.
  await editor.locator('ul[data-type="taskList"] > li').nth(1).locator("p").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Control+j");
  await writer.getByRole("menuitem", { name: /Umwandeln in/ }).click();
  await writer.getByRole("group", { name: "Umwandeln in" }).getByRole("button", { name: "Nummerierte Liste" }).click();
  await expect(editor.locator("ol > li")).toHaveCount(2);
  await expect(editor.locator('ul[data-type="taskList"]')).toHaveCount(0);
  expect(aiRequests).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __devicePrompts: unknown[] }).__devicePrompts.length)).toBe(0);
});
