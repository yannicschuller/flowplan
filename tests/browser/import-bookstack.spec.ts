import { test, expect, type Browser } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

// The BookStack import (#329) in Settings → Import & Export against a mock
// BookStack on 127.0.0.1 (the test servers allow internal addresses,
// scripts/e2e-server.mjs): address and token, load the shelves and books,
// leave one book out, check the preview's counts, import – the shelf page
// opens. Desktop and phone;
// BOOKSTACK_SCREENSHOTS=<dir> keeps screenshots of each step, light and dark.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.BOOKSTACK_SCREENSHOTS || "";
const TOKEN_ID = "BrowserTokenId0123456789abcdefAB";
const TOKEN_SECRET = "BrowserTokenSecret0123456789abcd";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
test.setTimeout(120_000);

type Mock = { base: string; auth: string[]; close: () => Promise<void> };
async function startMock(tag: string): Promise<Mock> {
  const mock: Mock = { base: "", auth: [], close: async () => {} };
  const items: Record<string, Record<string, unknown>[]> = {
    shelves: [{ id: 1, name: `Handbuch ${tag}`, slug: "handbuch", description_html: "<p>Unser Wissen.</p>", tags: [], books: [{ id: 10 }] }],
    books: [
      { id: 10, name: `Betrieb ${tag}`, slug: "betrieb", description_html: "<p>Wie wir arbeiten.</p>", tags: [{ name: "Team", value: "IT" }] },
      { id: 11, name: `Extra ${tag}`, slug: "extra", description_html: "", tags: [] },
    ],
    chapters: [{ id: 100, book_id: 10, name: `Kapitel ${tag}`, slug: "kapitel", priority: 1, description_html: "", tags: [] }],
    pages: [
      { id: 1000, book_id: 10, chapter_id: 0, name: `Start ${tag}`, slug: "start", priority: 0, draft: false, markdown: "", tags: [], html: '<p class="callout info">Willkommen</p><p><img src="BASE/uploads/images/gallery/2026-01/bild.png"></p>' },
      { id: 1001, book_id: 10, chapter_id: 100, name: `Details ${tag}`, slug: "details", priority: 0, draft: false, markdown: "", tags: [], html: '<p>Zurück zum <a href="BASE/books/betrieb/page/start">Start</a>.</p>' },
      { id: 1100, book_id: 11, chapter_id: 0, name: `Nicht dabei ${tag}`, slug: "nicht", priority: 0, draft: false, markdown: "", tags: [], html: "<p>x</p>" },
    ],
    attachments: [{ id: 5000, name: "plan.txt", extension: "txt", uploaded_to: 1001, external: false, order: 0, content: Buffer.from("Plan").toString("base64") }],
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body).replaceAll("BASE", mock.base));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/uploads/images/")) {
      res.writeHead(200, { "content-type": "image/png" });
      return void res.end(PNG);
    }
    mock.auth.push(String(req.headers.authorization || ""));
    if (req.headers.authorization !== `Token ${TOKEN_ID}:${TOKEN_SECRET}`) return send(res, 401, { error: { message: "invalid" } });
    const m = /^\/api\/(shelves|books|chapters|pages|attachments)(?:\/(\d+))?$/.exec(url.pathname);
    if (!m) return send(res, 404, {});
    const list = items[m[1]];
    if (!m[2]) {
      const offset = Number(url.searchParams.get("offset") || 0);
      return send(res, 200, { data: list.slice(offset, offset + 500), total: list.length });
    }
    const item = list.find((i) => i.id === Number(m[2]));
    return item ? send(res, 200, item) : send(res, 404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.close = () => new Promise((resolve) => server.close(() => resolve()));
  return mock;
}

// A signed-in editor of the demo workspace (the demo guest may not import
// from another server).
async function person(browser: Browser, workspaceId: string, mobile: boolean) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `bookstack:${uid}`, "Bea", `${uid}@test.invalid`, Date.now());
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(workspaceId, uid, "editor");
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  db.close();
  const context = await browser.newContext({
    ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
    locale: "de-DE",
    extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" },
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] },
  });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return { context, page: await context.newPage() };
}

test("import from BookStack: token, shelves and books, preview, import", async ({ page: demo, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  const mobile = info.project.name === "mobile";
  const tag = `${info.project.name}${Date.now()}`;
  await demo.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await demo.request.get("/api/bootstrap")).json();
  const { context, page } = await person(browser, boot.workspace.id, mobile);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mock = await startMock(tag);
  const shoot = async (name: string) => {
    if (!shots) return;
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${shots}/${info.project.name}-${name}-${scheme}.png`, animations: "disabled" });
    }
    await page.emulateMedia({ colorScheme: "light" });
  };
  try {
    await page.goto("/#settings/data");
    await page.getByLabel("Quelle des Imports").selectOption("bookstack");
    const load = page.getByRole("button", { name: "Regale und Bücher laden" });
    await expect(load).toBeDisabled();
    await page.getByLabel("Adresse von BookStack").fill(`${mock.base}/`);
    await page.getByLabel("Token-ID").fill(TOKEN_ID);
    await page.getByLabel("Token-Secret").fill(TOKEN_SECRET);
    await expect(page.getByLabel("Token-Secret")).toHaveAttribute("type", "password");
    await load.scrollIntoViewIfNeeded();
    await shoot("form");
    await load.click();

    const choice = page.getByRole("region", { name: "Regale und Bücher aus BookStack" });
    await expect(choice.getByRole("checkbox", { name: `Handbuch ${tag} Regal` })).toBeChecked();
    await expect(choice.getByRole("checkbox", { name: `Betrieb ${tag}` })).toBeChecked();
    await expect(choice.getByText("Bücher ohne Regal")).toBeVisible();
    const extra = choice.getByRole("checkbox", { name: `Extra ${tag}` });
    await extra.uncheck();
    await choice.scrollIntoViewIfNeeded();
    await shoot("choice");
    await choice.getByRole("button", { name: "Prüfen" }).click();

    const preview = page.getByRole("region", { name: "Vorschau des Imports" });
    await expect(preview).toBeVisible({ timeout: 30_000 });
    for (const line of ["1 Regale", "1 Bücher", "1 Kapitel", "2 Seiten", "1 Bilder", "1 Anhänge", "1 Tags"]) await expect(preview.getByText(line, { exact: true })).toBeVisible();
    await preview.scrollIntoViewIfNeeded();
    await shoot("preview");
    await preview.getByRole("button", { name: "Importieren" }).click();

    // The first imported page – the shelf – opens.
    await expect(page.getByText("Unser Wissen.")).toBeVisible({ timeout: 30_000 });
    const pages = (await (await page.request.get("/api/bootstrap")).json()).pages as { id: string; title: string; parent_id: string | null }[];
    const titled = (title: string) => pages.find((p) => p.title === title)!;
    expect(titled(`Betrieb ${tag}`).parent_id).toBe(titled(`Handbuch ${tag}`).id);
    expect(titled(`Kapitel ${tag}`).parent_id).toBe(titled(`Betrieb ${tag}`).id);
    expect(titled(`Details ${tag}`).parent_id).toBe(titled(`Kapitel ${tag}`).id);
    expect(pages.some((p) => p.title === `Extra ${tag}` || p.title === `Nicht dabei ${tag}`)).toBe(false);
    const details = await (await page.request.get(`/api/pages/${titled(`Details ${tag}`).id}`)).json();
    expect(details.html).toContain(`/#page=${titled(`Start ${tag}`).id}`);
    // Every request to BookStack carried the token.
    expect(mock.auth.length).toBeGreaterThan(5);
    expect(mock.auth.every((a) => a === `Token ${TOKEN_ID}:${TOKEN_SECRET}`)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await mock.close();
    await context.close();
  }
});
