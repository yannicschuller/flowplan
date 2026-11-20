import { test, expect, type Browser, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

// "Ton bei neuen Benachrichtigungen" (#401): a mention by someone else
// makes the open app play its sound once – only after the page was
// clicked or typed in (the browser's autoplay rule), and not at all with
// the setting "Aus". The Web Audio API is replaced by a counter: a sound is
// one output connected to the speakers.

const STUB = () => {
  const counts = { contexts: 0, plays: 0, tones: 0 };
  (window as unknown as { __sound: typeof counts }).__sound = counts;
  class Param {
    setValueAtTime() {}
    linearRampToValueAtTime() {}
    exponentialRampToValueAtTime() {}
  }
  class Node {
    constructor(private ctx: FakeContext) {}
    connect(target: unknown) {
      if (target === this.ctx.destination) counts.plays++;
      return target;
    }
    disconnect() {}
  }
  class FakeContext {
    // Like a browser: suspended until a gesture resumes it.
    state = "suspended";
    currentTime = 0;
    destination = {};
    constructor() {
      counts.contexts++;
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    createGain() {
      return Object.assign(new Node(this), { gain: new Param() });
    }
    createOscillator() {
      counts.tones++;
      return Object.assign(new Node(this), { type: "sine", frequency: new Param(), start() {}, stop() {} });
    }
  }
  Object.assign(window, { AudioContext: FakeContext, webkitAudioContext: FakeContext });
};

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

test("a new notification plays the sound once in the open app; with „Aus“ none", async ({ page, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  const tag = `${info.project.name}${Date.now()}`;
  // The demo account's workspace, with two people of their own: Lea
  // listens, Max mentions her (other specs never notify them).
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Ton ${tag}`, kind: "document" },
  });
  const pageId = (await created.json()).id as string;
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const person = (name: string) => {
    const uid = randomUUID(),
      token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `sound-test:${uid}`, name, `${uid}@example.test`, Date.now());
    db.prepare("INSERT INTO members VALUES(?,?,?)").run(boot.workspace.id, uid, "editor");
    db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 600_000);
    return { uid, token, name };
  };
  const lea = person(`Lea${tag}`),
    max = person(`Max${tag}`);
  db.close();

  const open = async (b: Browser, token: string) => {
    const context = await b.newContext({ viewport: page.viewportSize()!, locale: "de-DE", extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" } });
    await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    await context.addInitScript(() => {
      try {
        localStorage.setItem("flowplan-offline-offer", "never");
      } catch {}
    });
    await context.addInitScript(STUB);
    return context;
  };
  const authorContext = await open(browser, max.token);
  const mention = async (text: string) => {
    const response = await authorContext.request.post(`${origin}/api/command`, {
      headers: { origin },
      data: { action: "comment.create", pageId, body: `@${lea.name.toLowerCase()} ${text}` },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const listenerContext = await open(browser, lea.token);
  try {
    const listener = await listenerContext.newPage();
    listener.on("pageerror", (e) => errors.push(e.message));
    const counts = async (p: Page) => await p.evaluate(() => (window as unknown as { __sound: { contexts: number; plays: number; tones: number } }).__sound);
    // The app open, its live signal connected.
    const connected = listener.waitForRequest((r) => r.url().includes("/api/live"));
    await listener.goto(`${origin}/#page=${pageId}`);
    await expect(listener.getByLabel("Seitentitel", { exact: true })).toHaveValue(`Ton ${tag}`, { timeout: 20_000 });
    await connected;
    await listener.waitForTimeout(1000);

    // Before any click or key: the browser would not allow sound – none.
    await mention("vor dem ersten Klick");
    await listener.waitForTimeout(3000);
    expect((await counts(listener)).plays).toBe(0);

    // A key pressed in the page unlocks it; the next mention rings once.
    await listener.keyboard.press("Shift");
    expect((await counts(listener)).contexts).toBe(1);
    const looked = listener.waitForResponse((r) => r.url().endsWith("/api/notifications") && r.ok());
    await mention("schau mal");
    await looked;
    await expect.poll(async () => (await counts(listener)).plays, { timeout: 15_000 }).toBe(1);
    expect((await counts(listener)).tones).toBe(2);
    // … and only once: nothing more follows.
    await listener.waitForTimeout(3000);
    expect((await counts(listener)).plays).toBe(1);
    // Reading it (the count goes down) makes no sound.
    await listenerContext.request.post(`${origin}/api/command`, { headers: { origin }, data: { action: "notification.read" } });
    await listener.waitForTimeout(3000);
    expect((await counts(listener)).plays).toBe(1);

    // „Aus“ in the settings: no sound for the next mention.
    await listener.goto(`${origin}/#settings/notifications`);
    const card = listener.locator("#notification-sound");
    await expect(card).toContainText("Ton bei neuen Benachrichtigungen");
    await expect(card.getByRole("radio", { name: "Sanft" })).toBeChecked();
    const saved = listener.waitForResponse((r) => r.url().endsWith("/api/command") && r.request().postData()?.includes("profile.notificationSound") === true);
    await card.getByText("Aus", { exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(card.getByRole("radio", { name: "Aus" })).toBeChecked();
    await expect(card.getByRole("button", { name: "Anhören" })).toBeDisabled();
    const before = (await counts(listener)).plays;
    await mention("jetzt leise");
    // The notification is there (the inbox has it) …
    await expect
      .poll(async () => ((await (await listenerContext.request.get(`${origin}/api/notifications`)).json()) as { unread: number }).unread, { timeout: 10_000 })
      .toBe(1);
    await listener.waitForTimeout(4000);
    // … but no sound.
    expect((await counts(listener)).plays).toBe(before);

    // „Glocke“ chosen: heard at once (the click allows it), and „Anhören“ plays again.
    await card.getByText("Glocke", { exact: true }).click();
    await expect.poll(async () => (await counts(listener)).plays).toBe(before + 1);
    expect((await counts(listener)).tones - 2).toBe(3);
    await card.getByRole("button", { name: "Anhören" }).click();
    await expect.poll(async () => (await counts(listener)).plays).toBe(before + 2);
  } finally {
    await listenerContext.close();
    await authorContext.close();
  }
  expect(errors).toEqual([]);
});
