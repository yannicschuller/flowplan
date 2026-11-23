import { test, expect, type Page } from "@playwright/test";
import { keepInstanceAi } from "./instance-ai";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

keepInstanceAi();

// "KI fragen" with an instruction (#462) against a stub OpenAI-compatible
// provider: the AI reads the overview page (read-only), then proposes a plan
// – create a page, link it from the overview, move a page into the archive,
// rename a page. One step is deselected (and the link step waits while the
// page it links to is deselected), the rest runs, and "Alles rückgängig"
// takes it all back. Desktop and phone (the panel is a sheet there).

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.AI_PLAN_SCREENSHOTS || "";
test.setTimeout(180_000);

type Mock = { base: string; systems: string[]; close: () => Promise<void> };
async function startMock(): Promise<Mock> {
  const mock: Mock = { base: "", systems: [], close: async () => {} };
  let round = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const messages = (body.messages || []) as { role: string; content: string }[];
      const system = messages.find((m) => m.role === "system")?.content || "";
      const prompt = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n");
      mock.systems.push(system.slice(0, 40));
      const handle = (title: string) => new RegExp(`(p\\d+) \\w+ „${title}[^“]*“`).exec(prompt)?.[1] || "";
      let answer = "Dazu habe ich nichts gefunden.";
      if (system.startsWith("You plan changes in Flowplan")) {
        round = prompt.includes('<daten tool="read_page"') ? 2 : 1;
        answer =
          round === 1
            ? JSON.stringify({ kind: "read", calls: [{ tool: "read_page", page: handle("Projektübersicht") }, { tool: "search", query: /Projektübersicht (\d+)/.exec(prompt)?.[1] || "" }] })
            : JSON.stringify({
                kind: "plan",
                summary: "Gamma anlegen, verlinken und das Meeting ins Archiv verschieben.",
                steps: [
                  { tool: "create_page", ref: "$gamma", space: "s1", parent: null, title: "Gamma Plan", markdown: "Neues Projekt Gamma." },
                  { tool: "insert_link", page: handle("Projektübersicht"), to: "$gamma", heading: null },
                  { tool: "move_page", page: handle("Meeting Oktober"), parent: handle("Archiv") },
                  { tool: "rename_page", page: handle("Notizblock"), title: "Notizblock (alt)" },
                ],
              });
      }
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

async function setup(page: Page, mock: Mock, tag: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data: { workspaceId: boot.workspace.id, ...data } });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  await command({ action: "profile.onboarded" });
  await command({ action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: mock.base, model: "mock-model", embeddingModel: "" }, features: { actions: true } } });
  await command({ action: "ai.settings", enabled: true });
  const spaceId = boot.spaces[0].id;
  const { htmlState } = await import("../../lib/document-server");
  const create = async (title: string, html: string) => {
    const created = await command({ action: "page.create", spaceId, title: `${title} ${tag}`, kind: "document" });
    const generation = (await (await page.request.get(`/api/pages/${created.id}`)).json()).generation;
    await command({ action: "document.sync", pageId: created.id, generation, update: Buffer.from(htmlState(html)).toString("base64") });
    return created.id as string;
  };
  const overview = await create("Projektübersicht", "<h2>Projekte</h2><p>Alpha und Beta.</p>");
  const meeting = await create("Meeting Oktober", "<p>Protokoll.</p>");
  const archive = await create("Archiv", "<p>Altes.</p>");
  const notes = await create("Notizblock", "<p>Lose Gedanken.</p>");
  const read = async (id: string) => (await (await page.request.get(`/api/pages/${id}`)).json()) as { page: { title: string; parent_id: string | null } };
  return { overview, meeting, archive, notes, read, spaceId };
}

test("An instruction becomes a plan: deselect a step, run it, undo all", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  const phone = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mock = await startMock();
  const tag = `${Date.now()}`;
  try {
    const { overview, meeting, archive, notes, read } = await setup(page, mock, tag);
    await page.goto(`/#page=${overview}`);
    await expect(page.locator(".page-content .ProseMirror").first()).toBeVisible({ timeout: 60_000 });
    if (phone) await page.locator(".mobile-tab-bar").getByRole("button", { name: /Navigation öffnen|Menü/ }).click();
    await page.locator(".main-nav").getByRole("button", { name: "KI fragen" }).click();
    const panel = page.getByRole("complementary", { name: "KI fragen" });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: "Nur antworten" })).toHaveAttribute("aria-pressed", "false");
    const field = panel.getByLabel("Deine Frage");
    await field.fill(`Lege eine Seite Gamma an, verlinke sie in der Projektübersicht ${tag} und verschiebe Meeting Oktober ${tag} ins Archiv.`);
    const planned = page.waitForRequest((r) => r.url().endsWith("/api/ai/plan"));
    await field.press("Enter");
    await planned;

    const card = panel.getByRole("region", { name: "Plan der KI" });
    await expect(card).toBeVisible({ timeout: 45_000 });
    const steps = card.locator(".ai-plan-step");
    await expect(steps).toHaveCount(4);
    await expect(steps.nth(0)).toContainText("Seite anlegen");
    await expect(steps.nth(0)).toContainText("Gamma Plan");
    await expect(steps.nth(1)).toContainText("Link einfügen");
    await expect(steps.nth(1)).toContainText("am Ende");
    await expect(steps.nth(2)).toContainText("Verschieben");
    await expect(steps.nth(2)).toContainText(`Archiv ${tag}`);
    // The rename touches a page the instruction did not name.
    await expect(steps.nth(3).locator(".ai-plan-flag")).toBeVisible();
    await expect(card).toContainText("Tokens");
    if (phone) await field.blur();
    const box = (i: number) => steps.nth(i).getByRole("checkbox");
    for (let i = 0; i < 4; i++) await expect(box(i)).toBeChecked();

    // Deselecting the new page takes the link to it along – with the reason.
    await box(0).uncheck();
    await expect(box(1)).not.toBeChecked();
    await expect(box(1)).toBeDisabled();
    await expect(steps.nth(1)).toContainText("Hängt von Schritt 1 ab");
    await box(0).check();
    await expect(box(1)).toBeChecked();
    // Keyboard: ↓ moves to the next step, Space unticks it.
    await box(2).focus();
    await page.keyboard.press("ArrowDown");
    await expect(box(3)).toBeFocused();
    await page.keyboard.press("Space");
    await expect(box(3)).not.toBeChecked();
    const run = card.getByRole("button", { name: "Ausführen (3)" });
    await expect(run).toBeEnabled();
    if (shots) await page.screenshot({ path: `${shots}/${phone ? "phone" : "desktop"}-plan.png` });

    await run.click();
    await expect(card.locator(".ai-plan-done")).toContainText("3 von 3 Schritten ausgeführt.", { timeout: 30_000 });
    await expect(steps.nth(0).locator(".ai-plan-result")).toContainText("Erledigt");
    await expect(steps.nth(3).locator(".ai-plan-result")).toHaveCount(0);
    const moved = await read(meeting);
    expect(moved.page.parent_id).toBe(archive);
    expect((await read(notes)).page.title).toBe(`Notizblock ${tag}`);
    // The link arrives in the open document like an edit by the person.
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    await expect(editor.locator("a", { hasText: "Gamma Plan" })).toHaveCount(1, { timeout: 15_000 });
    if (shots) await page.screenshot({ path: `${shots}/${phone ? "phone" : "desktop"}-plan-done.png` });

    await card.getByRole("button", { name: "Alles rückgängig" }).click();
    await expect(card.locator(".ai-plan-done")).toContainText("Der Plan ist zurückgenommen.", { timeout: 30_000 });
    await expect(steps.nth(0).locator(".ai-plan-result")).toContainText("Zurückgenommen");
    expect((await read(meeting)).page.parent_id).toBeNull();
    await expect(editor.locator("a", { hasText: "Gamma Plan" })).toHaveCount(0, { timeout: 15_000 });
    expect(errors).toEqual([]);
  } finally {
    await mock.close();
  }
});

test("“Only answer” sends an instruction as a question", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  test.skip(info.project.name === "mobile", "Desktop run");
  const mock = await startMock();
  try {
    const { overview } = await setup(page, mock, `${Date.now()}`);
    await page.goto(`/#page=${overview}`);
    await expect(page.locator(".page-content .ProseMirror").first()).toBeVisible({ timeout: 60_000 });
    await page.locator(".main-nav").getByRole("button", { name: "KI fragen" }).click();
    const panel = page.getByRole("complementary", { name: "KI fragen" });
    const only = panel.getByRole("button", { name: "Nur antworten" });
    await only.click();
    await expect(only).toHaveAttribute("aria-pressed", "true");
    const asked = page.waitForRequest((r) => r.url().endsWith("/api/ai/ask"));
    await panel.getByLabel("Deine Frage").fill("Lege eine Seite Gamma an.");
    await panel.getByLabel("Deine Frage").press("Enter");
    await asked;
    await expect(panel.locator(".ai-ask-answer").last()).not.toHaveClass(/streaming/, { timeout: 30_000 });
    expect(mock.systems.some((s) => s.startsWith("You plan changes"))).toBe(false);
    await expect(panel.locator(".ai-plan")).toHaveCount(0);
  } finally {
    await mock.close();
  }
});
