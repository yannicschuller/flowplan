import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Flashcards phase 4 (docs/specs/flashcards.md §9) against a stub
// OpenAI-compatible provider: "Lernkarten erstellen" on a selection in a
// document and "Mit KI erstellen" in the study view – suggestions, review
// (untick, edit, regenerate) and the cards added to the deck.
// STUDY_SCREENSHOTS=<dir> keeps pictures of the review (light and dark).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.STUDY_SCREENSHOTS || "";
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
      const user = ((body.messages || []) as { role: string; content: string }[]).filter((m) => m.role !== "system").map((m) => m.content).join("\n");
      mock.prompts.push(user);
      const again = user.includes("Mitochondrien") && mock.prompts.filter((p) => p.includes("Mitochondrien")).length > 1;
      const cards = user.includes("Mitochondrien")
        ? [
            { type: "basic", front: "Was erzeugen die Mitochondrien?", back: "ATP", source: "Organellen" },
            { type: "cloze", front: "Der {{c1::Zellkern}} enthält die DNA.", back: "", source: "Organellen" },
            { type: "choice", front: "Wo wird ATP erzeugt?", back: "in den Mitochondrien", choices: ["im Zellkern", "in den Ribosomen", "in der Membran"] },
            { type: "basic", front: "Ist die Zelle klein?", back: "Ja." },
            ...(again ? [{ type: "typed", front: "Baustoff der Proteine?", back: "Aminosäuren" }] : []),
          ]
        : [{ type: "basic", front: "hola", back: "hallo" }, { type: "basic", front: "perro", back: "Hund" }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ cards }) } }] })}\n\n`);
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
  await command({ action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: mock.base, model: "stub", embeddingModel: "" } } });
  await command({ action: "ai.settings", enabled: true });
  return { boot, command };
}
async function shot(page: Page, name: string, project: string) {
  if (!shots) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${shots}/fc3-${name}-${project === "mobile" ? 390 : 1440}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}
const cardsOf = async (page: Page, deck: string) => (await (await page.request.get(`/api/pages/${deck}`)).json()).rows as { cells: Record<string, unknown> }[];

test("cards from a selection: suggest, review, add", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the text menu shows on a mouse selection");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mock = await startMock();
  try {
    const { boot, command } = await setup(page, mock);
    const title = `Biologie ${Date.now()}`;
    const deck = (await command({ action: "page.create", spaceId: boot.spaces[0].id, title, kind: "database", databaseKind: "flashcards" })).id as string;
    const doc = await command({ action: "page.create", spaceId: boot.spaces[0].id, title: `Zelle ${Date.now()}`, kind: "document" });
    const { htmlState } = await import("../../lib/document-server");
    const generation = (await (await page.request.get(`/api/pages/${doc.id}`)).json()).generation;
    await command({ action: "document.sync", pageId: doc.id, generation, update: Buffer.from(htmlState("<h2>Organellen</h2><p>Die Mitochondrien erzeugen ATP. Der Zellkern enthält die DNA.</p>")).toString("base64") });
    await page.goto(`/#page=${doc.id}`);
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    await expect(editor).toContainText("Mitochondrien", { timeout: 60_000 });
    await editor.locator("p").first().click({ clickCount: 3 });
    await page.getByRole("menuitem", { name: "Lernkarten erstellen" }).click();
    const dialog = page.getByRole("dialog", { name: "Lernkarten mit KI erstellen" });
    await expect(dialog.getByRole("radio", { name: /Markierter Text/ })).toBeChecked();
    await dialog.getByLabel("Stapel").selectOption({ label: title });
    await expect(dialog.locator(".study-ai-estimate")).toContainText("Tokens", { timeout: 15_000 });
    await dialog.getByRole("button", { name: "Karten vorschlagen" }).click();
    await expect(dialog.locator(".study-ai-head")).toContainText("4 Karten vorgeschlagen", { timeout: 30_000 });
    // A cloze shows its gap, not Anki's braces.
    await expect(dialog.locator(".study-ai-gap")).toHaveText("Zellkern");
    expect(mock.prompts.at(-1)).toContain("<quelle>\nDie Mitochondrien erzeugen ATP.");
    // The yes/no question starts unticked and is marked.
    const yesNo = dialog.locator(".study-ai-list li").filter({ hasText: "Ist die Zelle klein?" });
    await expect(yesNo).toContainText("Ja/Nein-Frage");
    await expect(yesNo.getByRole("checkbox")).not.toBeChecked();
    // "Neu erzeugen" knows what was suggested and brings one more.
    await dialog.getByRole("button", { name: "Neu erzeugen" }).click();
    await expect(dialog.locator(".study-ai-head")).toContainText("5 Karten vorgeschlagen", { timeout: 30_000 });
    expect(mock.prompts.at(-1)).toContain("Was erzeugen die Mitochondrien?");
    await expect(dialog.locator(".study-ai-list li").filter({ hasText: "Baustoff der Proteine?" }).getByRole("checkbox")).toBeChecked();
    // Suggested before: now marked as similar and unticked.
    const first = dialog.locator(".study-ai-list li").filter({ hasText: "Was erzeugen die Mitochondrien?" });
    await expect(first).toContainText("ähnlich zu einer vorhandenen Karte");
    await first.getByRole("checkbox").check();
    for (const front of ["Der Zellkern enthält die DNA.", "Wo wird ATP erzeugt?"]) await dialog.locator(".study-ai-list li").filter({ hasText: front }).getByRole("checkbox").check();
    await first.getByRole("button", { name: "Bearbeiten" }).click();
    await first.getByLabel("Rückseite").fill("ATP (Adenosintriphosphat)");
    await first.getByRole("button", { name: "Fertig" }).click();
    await dialog.getByLabel("Tags für alle").fill("Kapitel 3");
    await shot(page, "ai-review", info.project.name);
    await dialog.getByRole("button", { name: "4 Karten hinzufügen" }).click();
    await expect(dialog.getByRole("status")).toContainText(`4 Karten zu „${title}“ hinzugefügt.`, { timeout: 30_000 });
    const rows = await cardsOf(page, deck);
    expect(rows.map((r) => r.cells.title).sort()).toEqual(["Baustoff der Proteine?", "Der {{c1::Zellkern}} enthält die DNA.", "Was erzeugen die Mitochondrien?", "Wo wird ATP erzeugt?"]);
    expect(rows.find((r) => r.cells.title === "Was erzeugen die Mitochondrien?")?.cells.back).toBe("ATP (Adenosintriphosphat)");
    expect(rows.every((r) => (r.cells.tags as string[]).includes("Kapitel 3"))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.request.post("/api/command", { headers: { origin }, data: { action: "admin.ai", settings: { enabled: false } } });
    await mock.close();
  }
});

test("“Mit KI erstellen” in the study view, from pasted text", async ({ page }, info) => {
  const mock = await startMock();
  try {
    const { boot, command } = await setup(page, mock);
    const title = `Spanisch ${info.project.name} ${Date.now()}`;
    const deck = (await command({ action: "page.create", spaceId: boot.spaces[0].id, title, kind: "database", databaseKind: "flashcards" })).id as string;
    await page.goto(`/#page=${deck}`);
    await page.getByRole("button", { name: "Mit KI erstellen" }).click();
    const dialog = page.getByRole("dialog", { name: "Lernkarten mit KI erstellen" });
    await expect(dialog.getByLabel("Stapel")).toHaveValue(deck);
    await dialog.getByRole("radio", { name: "Text einfügen" }).check();
    await dialog.getByLabel("Text", { exact: true }).fill("hola heißt hallo, perro heißt Hund.");
    await dialog.getByRole("button", { name: "Karten vorschlagen" }).click();
    await expect(dialog.locator(".study-ai-head")).toContainText("2 Karten vorgeschlagen", { timeout: 30_000 });
    await shot(page, "ai-review-text", info.project.name);
    await dialog.getByRole("button", { name: "2 Karten hinzufügen" }).click();
    await expect(dialog.getByRole("status")).toContainText("2 Karten", { timeout: 30_000 });
    await dialog.getByRole("button", { name: "Fertig" }).click();
    await expect(page.locator(".study-deck")).toContainText("2 Karten", { timeout: 30_000 });
    expect((await cardsOf(page, deck)).length).toBe(2);
  } finally {
    await page.request.post("/api/command", { headers: { origin }, data: { action: "admin.ai", settings: { enabled: false } } });
    await mock.close();
  }
});
