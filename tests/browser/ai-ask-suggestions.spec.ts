import { test, expect, type Locator, type Page } from "@playwright/test";
import { keepInstanceAi } from "./instance-ai";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

keepInstanceAi();

// "KI fragen" redesigned ("Chat mit Vorschlägen", components/ai-ask.tsx,
// lib/ai/ask-suggestions.ts): before the first question a greeting with the
// first name and questions that fit what is open; a suggestion is sent at
// once, looking where it belongs (the open page goes along for a summary,
// the help for the help question). The composer is one box: the page as an
// attachment, where to look and the model as small pills, a round send
// button; the privacy note is one line with the full text on demand. On
// phones the same in the bottom sheet, nothing wider than the screen.
// ASK_REDESIGN_SCREENSHOTS=<dir> writes the screenshots, light and dark.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.ASK_REDESIGN_SCREENSHOTS || "";
test.setTimeout(180_000);

type Mock = { base: string; answer: string[]; close: () => Promise<void> };
async function startMock(): Promise<Mock> {
  const mock: Mock = { base: "", answer: [], close: async () => {} };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      if (!req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of mock.answer) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 40));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  mock.close = () => new Promise((resolve) => server.close(() => resolve()));
  return mock;
}

const ANSWER = [
  "**Projektplan in Kürze:** ",
  "Der Relaunch startet am 3. März [1]. ",
  "Bis dahin stehen drei Meilensteine an:\n\n",
  "- Konzept und Inhalte bis Ende Januar\n",
  "- Design und Umsetzung im Februar\n",
  "- Test und Freigabe in der letzten Februarwoche [1]\n\n",
  "Verantwortlich ist das Web-Team, Budget und Termine stehen im Abschnitt „Rahmen“.",
];

function db() {
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  return d;
}

async function setup(page: Page, tag: string) {
  const mock = await startMock();
  mock.answer = ANSWER;
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data: { workspaceId: boot.workspace.id, ...data } });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  await command({ action: "profile.onboarded" });
  await command({ action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: mock.base, model: "gpt-4.1-mini", embeddingModel: "" } } });
  await command({ action: "ai.settings", enabled: true });
  const d = db();
  d.prepare("UPDATE users SET name=? WHERE id=?").run("Anna Berger", boot.user.id);
  const plan = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: `Projektplan ${tag}`, kind: "document" });
  const html = `<p>Der Relaunch startet am 3. März.</p><p>Konzept bis Januar, Design im Februar, Test Ende Februar.</p>`;
  d.prepare("UPDATE documents SET html=?,state=NULL,generation=? WHERE page_id=?").run(html, randomUUID(), plan.id);
  d.prepare("DELETE FROM search_index WHERE page_id=? AND row_id=''").run(plan.id);
  d.prepare("INSERT INTO search_index(page_id,row_id,title,body) VALUES(?,?,?,?)").run(plan.id, "", `Projektplan ${tag}`, html.replace(/<[^>]+>/g, " "));
  d.close();
  const notes = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: `Besprechung ${tag}`, kind: "document" });
  return { mock, boot, plan, notes };
}

async function openPanel(page: Page, phone: boolean) {
  if (phone) await page.locator(".mobile-tab-bar").getByRole("button", { name: /Navigation öffnen|Menü/ }).click();
  await page.locator(".main-nav").getByRole("button", { name: "KI fragen" }).click();
  const panel = page.getByRole("complementary", { name: "KI fragen" });
  await expect(panel).toBeVisible();
  return panel;
}
// Animations finished and the caret gone, for steady screenshots.
const settled = (el: Locator) => el.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));
async function shoot(page: Page, panel: Locator, name: string) {
  if (!shots) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await settled(panel);
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("Ask AI: greeting, suggestions that fit, the composer's pills and sending a suggestion", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  const phone = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tag = `${Date.now()}`;
  const { mock, plan, notes } = await setup(page, tag);
  try {
    if (!phone) await page.setViewportSize({ width: 1440, height: 900 });
    // Looked at the notes first: they come up as a recent page.
    await page.goto(`/#page=${notes.id}`);
    await expect(page.locator(".page-content .ProseMirror").first()).toBeVisible({ timeout: 60_000 });
    await page.goto(`/#page=${plan.id}`);
    await expect(page.locator(".page-content .ProseMirror").first()).toContainText("Relaunch", { timeout: 60_000 });
    const panel = await openPanel(page, phone);
    const field = panel.getByLabel("Deine Frage");

    // The greeting with the first name, then the suggestions.
    await expect(panel.getByRole("heading", { name: "Hallo Anna" })).toBeVisible();
    await expect(panel).toContainText("Was möchtest du wissen?");
    const suggestions = panel.getByRole("list", { name: "Vorschläge" }).getByRole("button");
    await expect(suggestions.first()).toHaveText(`Fasse „Projektplan ${tag}“ zusammen`);
    await expect(suggestions.filter({ hasText: `Was steht in „Besprechung ${tag}“?` })).toHaveCount(1);
    await expect(suggestions.last()).toHaveText("Wie teile ich eine Seite öffentlich?");
    expect(await suggestions.count()).toBeLessThanOrEqual(4);
    // No "Neu" before there is a conversation.
    await expect(panel.getByRole("button", { name: "Neues Gespräch" })).toHaveCount(0);

    // The composer: the page as an attachment, where to look, the model
    // with a readable name (its details on demand), a quiet send button.
    const box = panel.locator(".ai-ask-box");
    await expect(box.getByRole("button", { name: "Diese Seite", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(box.getByRole("combobox", { name: "Wo soll gesucht werden?" })).toHaveValue("workspace");
    const model = box.getByRole("button", { name: "Modell: GPT-4.1 mini" });
    await expect(model).toHaveText("GPT-4.1 mini");
    const send = box.getByRole("button", { name: "Fragen", exact: true });
    await expect(send).toBeDisabled();
    await model.click();
    await expect(model).toHaveAttribute("aria-expanded", "true");
    const details = panel.locator(`[id="${await model.getAttribute("aria-controls")}"]`);
    await expect(details).toBeVisible();
    await expect(details).toContainText("OpenAI-kompatibel");
    await expect(details).toContainText("gpt-4.1-mini");
    await expect(details).toContainText("Texte bleiben auf diesem Server.");
    await shoot(page, panel, `${phone ? "phone" : "desktop"}-model-details`);
    // Escape closes the details, not the panel.
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(model).toBeFocused();

    // The privacy note: one line, the full text behind it.
    const note = panel.getByRole("button", { name: /^Datenschutz: Liest nur, was du lesen darfst/ });
    await expect(note).toHaveAttribute("aria-expanded", "false");
    await note.click();
    await expect(panel).toContainText("wird nicht auf dem Server gespeichert");
    await shoot(page, panel, `${phone ? "phone" : "desktop"}-privacy`);
    await page.keyboard.press("Escape");
    await expect(note).toHaveAttribute("aria-expanded", "false");

    // The field grows with its text, up to a limit; Shift+Enter is a new line.
    await field.focus();
    const one = (await field.boundingBox())!.height;
    await page.keyboard.type("Erste Zeile");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Zweite Zeile");
    await expect(field).toHaveValue("Erste Zeile\nZweite Zeile");
    await expect.poll(async () => (await field.boundingBox())!.height).toBeGreaterThan(one + 10);
    await field.fill(Array.from({ length: 30 }, (_, i) => `Zeile ${i}`).join("\n"));
    expect((await field.boundingBox())!.height).toBeLessThanOrEqual(201);
    await expect(send).toBeEnabled();
    await field.fill("");
    if (phone) await field.blur();

    // Phones: nothing wider than the screen, the composer inside it.
    if (phone) {
      expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      const b = (await box.boundingBox())!;
      const p = (await panel.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(390);
      expect(p.y + p.height - (b.y + b.height)).toBeLessThan(64);
      const s = (await send.boundingBox())!;
      expect(s.x + s.width).toBeLessThanOrEqual(b.x + b.width);
    }
    await shoot(page, panel, `${phone ? "phone" : "desktop"}-empty`);

    // A suggestion is sent at once: the summary looks at this page, which goes along.
    const asked = page.waitForRequest((r) => r.url().endsWith("/api/ai/ask"));
    await suggestions.first().click();
    const body = (await asked).postDataJSON();
    expect(body.question).toBe(`Fasse „Projektplan ${tag}“ zusammen`);
    expect(body.scope).toEqual({ kind: "page", pageId: plan.id });
    expect(body.page).toEqual({ pageId: plan.id });
    await expect(panel.locator(".ai-ask-question")).toHaveText(`Fasse „Projektplan ${tag}“ zusammen`);
    const answer = panel.locator(".ai-ask-answer").last();
    await expect(answer).toContainText("Test und Freigabe", { timeout: 45_000 });
    await expect(answer).not.toHaveClass(/streaming/, { timeout: 30_000 });
    await expect(panel.getByRole("list", { name: "Vorschläge" })).toHaveCount(0);
    await expect(box.getByRole("combobox", { name: "Wo soll gesucht werden?" })).toHaveValue(`page:${plan.id}`);
    // Sources as cards, the tools as small icon buttons.
    await expect(answer.locator(".ai-ask-sources .ai-source-chip").first()).toContainText(`Projektplan ${tag}`);
    await expect(answer.getByRole("button", { name: "Kopieren" })).toBeVisible();
    await expect(answer.getByRole("button", { name: "Als Änderungsvorschlag einfügen" })).toBeVisible();
    if (phone) await field.blur();
    await shoot(page, panel, `${phone ? "phone" : "desktop"}-conversation`);

    // "+ Neu": the greeting and the suggestions are back; the help question
    // looks in the help only.
    await panel.getByRole("button", { name: "Neues Gespräch" }).click();
    await expect(panel.getByRole("heading", { name: "Hallo Anna" })).toBeVisible();
    mock.answer = ["Über „Teilen“ oben rechts."];
    const help = page.waitForRequest((r) => r.url().endsWith("/api/ai/ask"));
    await suggestions.last().click();
    const helpBody = (await help).postDataJSON();
    expect(helpBody.scope).toEqual({ kind: "help" });
    expect(helpBody.page).toBeUndefined();
    await expect(panel.locator(".ai-ask-answer").last()).toContainText("Teilen", { timeout: 45_000 });
    await expect(box.getByRole("combobox", { name: "Wo soll gesucht werden?" })).toHaveValue("help");
    await expect(box.getByRole("button", { name: "Diese Seite", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await mock.close();
  }
});

test("Ask AI: an error shows in the conversation with a retry", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  test.skip(info.project.name === "mobile", "The same on phones");
  const tag = `${Date.now()}`;
  const { mock, plan } = await setup(page, tag);
  try {
    await page.goto(`/#page=${plan.id}`);
    await expect(page.locator(".page-content .ProseMirror").first()).toBeVisible({ timeout: 60_000 });
    const panel = await openPanel(page, false);
    // The provider is gone: the answer fails.
    await mock.close();
    const field = panel.getByLabel("Deine Frage");
    await field.fill("Was steht hier?");
    await field.press("Enter");
    const error = panel.locator(".ai-ask-error");
    await expect(error).toBeVisible({ timeout: 45_000 });
    await expect(error.getByRole("button", { name: "Erneut versuchen" })).toBeVisible();
    await shoot(page, panel, "desktop-error");
  } finally {
    await mock.close().catch(() => {});
  }
});
