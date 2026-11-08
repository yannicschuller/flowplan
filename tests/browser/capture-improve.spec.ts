import { test, expect, type Browser } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

// "Text verbessern" in quick capture (#172) against a mock OpenAI-compatible
// provider: the button (AI icon) only with AI on and online; title and text
// go to the writing assistant's improve (POST /api/ai/write), the answer is a
// preview with "Übernehmen" / "Original behalten", nothing is saved until
// "Erfassen". Desktop and phone (the capture is a bottom sheet there).

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.CAPTURE_IMPROVE_SCREENSHOTS || "";
test.setTimeout(120_000);

type Mock = { base: string; prompts: string[]; close: () => Promise<void> };
async function startMock(): Promise<Mock> {
  const mock: Mock = { base: "", prompts: [], close: async () => {} };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      mock.prompts.push(((body.messages || []) as { content: string }[]).map((m) => m.content).join("\n"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of ["# Einkauf für morgen\n\n", "Milch, Brot und Käse besorgen.\n", "Anna wegen des Termins anrufen."])
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  mock.close = () => new Promise((resolve) => server.close(() => resolve()));
  return mock;
}

// A signed-in instance administrator, member of the workspace.
async function person(browser: Browser, workspaceId: string, mobile: boolean) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `capture-improve:${uid}`, "Ada", `${uid}@test.invalid`, Date.now());
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(workspaceId, uid, "editor");
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 3600_000);
  db.close();
  const context = await browser.newContext({
    ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
    locale: "de-DE",
    extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" },
  });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return { context, page: await context.newPage() };
}

test("quick capture: improve text with AI – preview, use or keep the original, nothing saved by itself", async ({ page: demo, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  await demo.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await demo.request.get("/api/bootstrap")).json();
  const { context, page } = await person(browser, boot.workspace.id, mobile);
  page.on("pageerror", (e) => errors.push(e.message));
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const mock = await startMock();
  try {
    const tag = Date.now();
    const inbox = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Eingang ${tag}`, kind: "database" })).id as string;
    await command({ action: "capture.target", workspaceId: boot.workspace.id, pageId: inbox });
    const rows = () => {
      const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
      try {
        return (db.prepare("SELECT COUNT(*) AS n FROM rows WHERE page_id=?").get(inbox) as { n: number }).n;
      } finally {
        db.close();
      }
    };
    const before = rows();

    // AI off: no button.
    await command({ action: "admin.ai", settings: { enabled: false } });
    await page.goto("/#capture");
    const sheet = page.getByRole("dialog", { name: "Erfassen" });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("button", { name: "Text verbessern" })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Abbrechen" }).click();

    await command({ action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: mock.base, model: "mock", embeddingModel: "" } } });
    // A fresh load: the AI status comes with the bootstrap.
    await page.goto("about:blank");
    await page.goto("/#capture");
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    const improve = sheet.getByRole("button", { name: "Text verbessern" });
    await expect(improve).toBeVisible();
    await expect(improve).toBeDisabled();
    const title = sheet.getByRole("textbox", { name: "Titel" });
    const text = sheet.getByRole("textbox", { name: "Text" });
    await title.fill("einkauf morgen");
    await text.fill("milch brot käse besorgen\nanna anrufen wegen termin");
    await expect(improve).toBeEnabled();
    if (shots) await page.screenshot({ path: `${shots}/${info.project.name}-form.png` });

    // Offline: the button goes (capturing still works).
    await context.setOffline(true);
    await expect(improve).toHaveCount(0);
    await context.setOffline(false);
    await expect(improve).toBeVisible();

    const request = page.waitForRequest((r) => r.url().endsWith("/api/ai/write"));
    await improve.click();
    const body = (await request).postDataJSON();
    expect(body).toMatchObject({ action: "improve", text: "# einkauf morgen\n\nmilch brot käse besorgen\nanna anrufen wegen termin" });
    const preview = sheet.getByRole("region", { name: "KI-Vorschlag" });
    await expect(preview.locator(".quick-capture-preview-title")).toHaveText("Einkauf für morgen", { timeout: 30_000 });
    await expect(preview.locator(".quick-capture-preview-text")).toHaveText("Milch, Brot und Käse besorgen.\nAnna wegen des Termins anrufen.");
    const use = preview.getByRole("button", { name: "Übernehmen" });
    await expect(use).toBeFocused();
    expect(mock.prompts.at(-1)).toContain("milch brot käse besorgen");
    if (shots) await page.screenshot({ path: `${shots}/${info.project.name}-preview.png` });

    // Keep the original: the fields stay as they were.
    await preview.getByRole("button", { name: "Original behalten" }).click();
    await expect(preview).toHaveCount(0);
    await expect(title).toHaveValue("einkauf morgen");
    await expect(improve).toBeFocused();

    // Use it – with the keyboard.
    await page.keyboard.press("Enter");
    await expect(use).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(preview).toHaveCount(0);
    await expect(title).toHaveValue("Einkauf für morgen");
    await expect(text).toHaveValue("Milch, Brot und Käse besorgen.\nAnna wegen des Termins anrufen.");
    expect(rows(), "nothing saved before “Erfassen”").toBe(before);
    if (shots) await page.screenshot({ path: `${shots}/${info.project.name}-used.png` });
    // Now captured, with the improved text.
    await sheet.getByRole("button", { name: "Erfassen", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(rows).toBe(before + 1);
    expect(errors).toEqual([]);
  } finally {
    await mock.close();
    await context.close();
  }
});
