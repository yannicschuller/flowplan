import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

// "KI fragen" as a side panel (#59, components/ai-ask.tsx) against a mock
// OpenAI-compatible provider that streams its answer slowly: no dialog and
// no backdrop, the page narrows beside the panel, the answer keeps streaming
// while the person writes in the document and opens other pages, a source
// opens in the main area with the panel still open, Escape closes and focus
// goes back, ⌃⌥A / ⌘⌥A opens again with the conversation kept, comments and
// the panel take turns, focus mode hides it. On phones: a bottom sheet that
// is minimised to a pill above the tab bar while the answer goes on.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.ASK_PANEL_SCREENSHOTS || "";
test.setTimeout(180_000);

const ANSWER = ["Der Betriebsausflug ", "findet am ", "12. Juni ", "in Hamburg ", "statt [1]. ", "Treffpunkt ", "ist der ", "Hauptbahnhof ", "um 9 Uhr [1]."];

type Mock = { base: string; delay: number; close: () => Promise<void> };
async function startMock(): Promise<Mock> {
  const mock: Mock = { base: "", delay: 1500, close: async () => {} };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Piece by piece, so the answer is still coming in while the test
      // writes and navigates.
      for (const piece of ANSWER) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, mock.delay));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  mock.close = () => new Promise((resolve) => server.close(() => resolve()));
  return mock;
}

// Stored HTML (the server builds the editing state from it) and the search
// index entry the question finds.
function write(id: string, title: string, html: string) {
  const d = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  d.exec("PRAGMA busy_timeout=5000;");
  d.prepare("UPDATE documents SET html=?,state=NULL,generation=? WHERE page_id=?").run(html, randomUUID(), id);
  d.prepare("DELETE FROM search_index WHERE page_id=? AND row_id=''").run(id);
  d.prepare("INSERT INTO search_index(page_id,row_id,title,body) VALUES(?,?,?,?)").run(id, "", title, html.replace(/<[^>]+>/g, " "));
  d.close();
}

async function setup(page: Page, tag: string) {
  const mock = await startMock();
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
  const trip = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: `Betriebsausflug ${tag}`, kind: "document" });
  write(trip.id, `Betriebsausflug ${tag}`, `<p>Der Betriebsausflug ${tag} findet am 12. Juni in Hamburg statt.</p><p>Treffpunkt ist der Hauptbahnhof um 9 Uhr.</p>`);
  const notes = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: `Notizen ${tag}`, kind: "document" });
  const other = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: `Wartung ${tag}`, kind: "document" });
  return { mock, boot, trip, notes, other };
}

test("Ask AI is a side panel: the page stays usable while the answer streams", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  test.skip(info.project.name === "mobile", "Desktop run; the phone layout is the next test");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tag = `${Date.now()}`;
  const { mock, trip, notes, other } = await setup(page, tag);
  try {
    await page.goto(`/#page=${notes.id}`);
    const editor = page.locator(".page-content .ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 60_000 });
    const sidebarAsk = page.locator(".main-nav").getByRole("button", { name: "KI fragen" });
    await sidebarAsk.click();

    const panel = page.getByRole("complementary", { name: "KI fragen" });
    await expect(panel).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    const field = panel.getByLabel("Deine Frage");
    await expect(field).toBeFocused();
    // The page narrows beside the panel instead of being covered.
    const main = (await page.locator("main.main").boundingBox())!;
    const box = (await panel.boundingBox())!;
    expect(main.x + main.width).toBeLessThanOrEqual(box.x + 1);
    expect(box.x + box.width).toBeGreaterThan(1440 - 2);

    await field.fill(`Wann ist der Betriebsausflug ${tag}?`);
    await field.press("Enter");
    const answer = panel.locator(".ai-ask-answer").last();
    await expect(answer).toHaveClass(/streaming/, { timeout: 45_000 });
    await expect(answer).toContainText("Der Betriebsausflug", { timeout: 45_000 });
    if (shots) await page.screenshot({ path: `${shots}/desktop-streaming.png` });

    // Writing in the document while the answer comes in.
    await editor.click();
    await page.keyboard.type("Notiz während die KI antwortet");
    await expect(editor).toContainText("Notiz während die KI antwortet");
    await expect(answer).toHaveClass(/streaming/);
    // Another page opens; the panel and its answer stay.
    await page.locator(".sidebar").getByText(`Wartung ${tag}`, { exact: true }).click();
    await expect(page.locator(".breadcrumb")).toContainText(`Wartung ${tag}`);
    await expect(panel).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/desktop-navigated.png` });
    await expect(answer).not.toHaveClass(/streaming/, { timeout: 30_000 });
    await expect(answer).toContainText("Hauptbahnhof um 9 Uhr");
    await expect(answer.getByRole("button", { name: "Kopieren" })).toBeVisible();

    // A source opens in the main area; the panel stays open.
    const source = panel.locator(".ai-ask-sources").getByRole("button", { name: new RegExp(`Betriebsausflug ${tag}`) });
    await source.click();
    await expect(page.locator(".breadcrumb")).toContainText(`Betriebsausflug ${tag}`);
    await expect(panel).toBeVisible();
    expect(page.url()).toContain(trip.id);

    // Escape inside the panel closes it; focus goes back to where it came from.
    await field.focus();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.locator(".app-shell")).not.toHaveClass(/ask-open/);
    // The keyboard shortcut opens it again, with the conversation kept.
    await page.keyboard.press("Control+Alt+KeyA");
    await expect(panel).toBeVisible();
    await expect(field).toBeFocused();
    await expect(panel.locator(".ai-ask-answer").last()).toContainText("Hauptbahnhof um 9 Uhr");
    // … and from inside the panel the shortcut closes it again (a separate
    // press: one within 250 ms counts as the same, lib/app-shortcuts.ts).
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+Alt+KeyA");
    await expect(panel).toBeHidden();
    await sidebarAsk.click();
    await expect(panel).toBeVisible();

    // Comments and the panel share the right edge: one closes the other.
    await page.keyboard.press("Control+Alt+KeyK");
    await expect(page.locator(".comments-panel")).toBeVisible();
    await expect(panel).toBeHidden();
    await sidebarAsk.click();
    await expect(panel).toBeVisible();
    await expect(page.locator(".comments-panel")).toHaveCount(0);

    // Resizing at the left edge (kept per browser).
    const handle = panel.getByRole("separator", { name: /Breite/ });
    await handle.focus();
    await page.keyboard.press("Shift+ArrowLeft");
    const wider = (await panel.boundingBox())!.width;
    expect(wider).toBeGreaterThan(box.width + 40);
    expect(Number(await page.evaluate(() => localStorage.getItem("flowplan-ask-width")))).toBeGreaterThan(box.width + 40);

    // Focus mode hides the panel; it comes back afterwards.
    await page.keyboard.press("Control+Alt+KeyZ");
    await expect(panel).toBeHidden();
    await page.keyboard.press("Control+Alt+KeyZ");
    await expect(panel).toBeVisible();

    // Presenting covers everything, the panel too.
    await page.keyboard.press("Control+Alt+KeyP");
    await expect(page.locator(".presentation")).toBeVisible();
    expect(await page.evaluate(() => !!document.elementFromPoint(1400, 400)?.closest(".presentation"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator(".presentation")).toHaveCount(0);
    await expect(panel).toBeVisible();

    // A reload keeps the conversation (this browser tab only).
    await page.reload();
    await expect(page.locator(".page-content .ProseMirror").first()).toBeVisible({ timeout: 60_000 });
    await page.locator(".main-nav").getByRole("button", { name: "KI fragen" }).click();
    await expect(panel.locator(".ai-ask-answer").last()).toContainText("Hauptbahnhof um 9 Uhr");
    // From the search: what was typed becomes the question, focus is in the panel.
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.type(`Wartung ${tag}`);
    await page.getByRole("dialog").getByRole("button", { name: "KI fragen" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(field).toHaveValue(`Wartung ${tag}`);
    await expect(field).toBeFocused();
    expect(errors).toEqual([]);
    void other;
  } finally {
    await mock.close();
  }
});

test("Ask AI on phones: a bottom sheet minimised to a pill while the answer goes on", async ({ page }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  test.skip(info.project.name !== "mobile", "Phone layout");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tag = `${Date.now()}`;
  const { mock, notes } = await setup(page, tag);
  try {
    await page.goto(`/#page=${notes.id}`);
    await expect(page.locator(".page-content .ProseMirror").first()).toBeVisible({ timeout: 60_000 });
    await page.locator(".mobile-tab-bar").getByRole("button", { name: /Navigation öffnen|Menü/ }).click();
    await page.locator(".main-nav").getByRole("button", { name: "KI fragen" }).click();
    const panel = page.getByRole("complementary", { name: "KI fragen" });
    await expect(panel).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // A sheet above the tab bar, which stays (once the keyboard is away).
    await panel.getByLabel("Deine Frage").blur();
    await expect(page.locator(".mobile-tab-bar")).toBeVisible();
    const bar = (await page.locator(".mobile-tab-bar").boundingBox())!;
    const sheet = (await panel.boundingBox())!;
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(bar.y + 1);
    expect(sheet.width).toBeGreaterThan(380);

    const field = panel.getByLabel("Deine Frage");
    await field.fill(`Wann ist der Betriebsausflug ${tag}?`);
    await panel.getByRole("button", { name: "Fragen", exact: true }).click();
    const answer = panel.locator(".ai-ask-answer").last();
    await expect(answer).toContainText("Der Betriebsausflug", { timeout: 45_000 });
    if (shots) await page.screenshot({ path: `${shots}/phone-streaming.png` });
    // Minimised: a pill says the answer is still coming in.
    await panel.getByRole("button", { name: "Verkleinern" }).click();
    await expect(panel).toBeHidden();
    const pill = page.getByRole("button", { name: /„KI fragen“ öffnen/ });
    await expect(pill).toBeVisible();
    await expect(pill).toContainText("KI antwortet");
    if (shots) await page.screenshot({ path: `${shots}/phone-minimised.png` });
    await expect(pill).toContainText("Antwort da", { timeout: 30_000 });
    await pill.click();
    await expect(panel).toBeVisible();
    await expect(answer).toContainText("Hauptbahnhof um 9 Uhr");
    // A source opens the page and makes room (the sheet becomes the pill).
    await panel.locator(".ai-ask-sources").getByRole("button", { name: new RegExp(`Betriebsausflug ${tag}`) }).click();
    await expect(page.locator(".breadcrumb")).toContainText(`Betriebsausflug ${tag}`);
    await expect(panel).toBeHidden();
    await expect(pill).toBeVisible();
    await pill.click();
    await panel.getByRole("button", { name: "„KI fragen“ schließen" }).click();
    await expect(panel).toBeHidden();
    await expect(pill).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await mock.close();
  }
});
