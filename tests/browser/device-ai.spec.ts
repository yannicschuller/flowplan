import { test, expect, type Page } from "@playwright/test";

// On-device AI (lib/ai/device.ts) through a stubbed window.FlowplanApp.ai –
// the contract of the iPhone/iPad app (and of window.FlowplanDesktop.ai):
// in the demo, without any AI on the server, the writing assistant and the
// page summary run on the "device" with the chip "Auf diesem Gerät",
// stream, can be stopped, and nothing goes to /api/ai. Where the device
// cannot, the entry points are hidden.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.DEVICE_AI_SCREENSHOTS || "";
test.setTimeout(120_000);

type Mode = "ok" | "slow" | "off";
async function stubBridge(page: Page, mode: Mode) {
  await page.addInitScript((mode: Mode) => {
    const calls: unknown[] = [];
    const cancelled = new Set<string>();
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const error = (code: string) => Object.assign(new Error(code), { code });
    (window as unknown as Record<string, unknown>).__deviceCalls = calls;
    (window as unknown as Record<string, unknown>).FlowplanApp = {
      platform: "ios",
      version: "test",
      ai: {
        version: 1,
        availability: async () => (mode === "off" ? { available: false, reason: "apple-intelligence-off" } : { available: true, languages: ["de", "en", "fr"] }),
        generate: async (request: { id: string; schema?: unknown; prompt: string }) => {
          calls.push({ op: "generate", id: request.id, schema: !!request.schema });
          await wait(150);
          if (request.schema)
            return {
              json: {
                summary: "Das Team plant die Woche auf diesem Gerät.",
                points: ["Bericht bis Freitag", "Termin mit Kunden"],
                tasks: [{ task: "Bericht schreiben", who: "Ben", due: "Freitag" }],
              },
            };
          return { text: "Ganz kurz." };
        },
        stream: async (request: { id: string }, onChunk: (text: string) => void) => {
          calls.push({ op: "stream", id: request.id });
          onChunk("Das ist");
          await wait(200);
          if (mode === "slow") {
            while (!cancelled.has(request.id)) await wait(50);
            throw error("cancelled");
          }
          onChunk("Das ist der verbesserte Text");
          await wait(200);
          onChunk("Das ist der verbesserte Text vom Gerät.");
          return { text: "Das ist der verbesserte Text vom Gerät." };
        },
        cancel: (id: string) => {
          calls.push({ op: "cancel", id });
          cancelled.add(id);
        },
      },
    };
  }, mode);
}

async function setup(page: Page, mode: Mode) {
  await stubBridge(page, mode);
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const id = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Wochenplan ${Date.now()}`, kind: "document" })).id as string;
  // Nothing of the page may go to the server's AI.
  const aiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/ai/") && request.method() === "POST") aiRequests.push(request.url());
  });
  await page.goto(`/#page=${id}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await editor.click();
  await page.keyboard.type("Das ist ein Text mit fehlern den wir verbesern wollen.");
  return { id, editor, aiRequests, boot };
}
const deviceCalls = (page: Page) => page.evaluate(() => (window as unknown as { __deviceCalls: { op: string; id: string; schema?: boolean }[] }).__deviceCalls);
async function selectParagraph(page: Page) {
  await page.locator(".ProseMirror p").first().click({ clickCount: 3 });
}
async function openPageMenu(page: Page) {
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
}

test("writing assistant runs on the device: streamed, with the chip, nothing to the server", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { editor, aiRequests } = await setup(page, "ok");
  await selectParagraph(page);
  await page.keyboard.press("Control+j");
  const writer = page.getByRole("dialog", { name: "KI-Schreibassistent" });
  await expect(writer).toBeVisible();
  await expect(writer.locator(".ai-footer.device")).toContainText("Apple Intelligence · nur auf diesem Gerät");
  await writer.getByRole("menuitem", { name: /Verbessern/ }).click();
  await expect(writer.locator(".ai-device-chip")).toHaveText("Auf diesem Gerät");
  await expect(writer.locator(".ai-preview")).toContainText("Das ist der verbesserte Text vom Gerät.");
  if (shots) {
    await page.screenshot({ path: `${shots}/chip-${info.project.name}-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: `${shots}/chip-${info.project.name}-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
  }
  await writer.getByRole("button", { name: "Ersetzen" }).click();
  await expect(editor).toContainText("Das ist der verbesserte Text vom Gerät.");
  await expect(editor).not.toContainText("verbesern");
  const calls = await deviceCalls(page);
  assert(calls.some((c) => c.op === "stream"));
  expect(aiRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("stopping cancels the request on the device", async ({ page }) => {
  const { aiRequests } = await setup(page, "slow");
  await selectParagraph(page);
  await page.keyboard.press("Control+j");
  const writer = page.getByRole("dialog", { name: "KI-Schreibassistent" });
  await writer.getByRole("menuitem", { name: /Kürzen/ }).click();
  await expect(writer.locator(".ai-preview")).toContainText("Das ist");
  await writer.getByRole("button", { name: "Stopp" }).click();
  await expect(writer.getByRole("button", { name: "Stopp" })).toHaveCount(0);
  await expect(writer.getByRole("button", { name: "Erneut" })).toBeVisible();
  await expect.poll(async () => (await deviceCalls(page)).map((c) => c.op)).toEqual(["stream", "cancel"]);
  const [stream, cancel] = await deviceCalls(page);
  expect(cancel.id).toBe(stream.id);
  // Stopped is not an error.
  await expect(writer.getByRole("alert")).toHaveCount(0);
  expect(aiRequests).toEqual([]);
});

test("the page summary with open tasks runs on the device (guided generation)", async ({ page }, info) => {
  const { aiRequests } = await setup(page, "ok");
  await openPageMenu(page);
  await page.getByRole("menuitem", { name: "Mit KI zusammenfassen" }).click();
  const panel = page.getByRole("complementary", { name: "KI-Zusammenfassung" });
  await expect(panel).toContainText("Das Team plant die Woche auf diesem Gerät.");
  await expect(panel.locator(".ai-device-chip")).toBeVisible();
  await expect(panel).toContainText("Bericht schreiben (Ben, Freitag)");
  await expect(panel.locator(".ai-footer.device")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/summary-${info.project.name}-light.png` });
  const calls = await deviceCalls(page);
  // One guided request (in development React starts the panel's effect
  // twice: the first request is cancelled).
  const guided = calls.filter((c) => c.op === "generate" && c.schema);
  const cancelled = calls.filter((c) => c.op === "cancel").map((c) => c.id);
  expect(guided.filter((c) => !cancelled.includes(c.id))).toHaveLength(1);
  expect(aiRequests).toEqual([]);
});

test("where the device cannot and the server has no AI, AI stays hidden; the settings say why", async ({ page }, info) => {
  const { aiRequests } = await setup(page, "off");
  await selectParagraph(page);
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("dialog", { name: "KI-Schreibassistent" })).toHaveCount(0);
  await openPageMenu(page);
  await expect(page.getByRole("menuitem", { name: "Exportieren" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Mit KI zusammenfassen" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect((await deviceCalls(page)).length).toBe(0);
  await page.goto("/#settings/ai");
  const group = page.locator("#ai-device");
  await expect(group).toContainText("Apple Intelligence auf diesem Gerät");
  await expect(group.locator("[data-device-ai]")).toHaveText("in den Einstellungen ausgeschaltet (Apple Intelligence & Siri)");
  await expect(group.getByLabel("KI auf dem Gerät verwenden")).toHaveValue("prefer");
  if (shots) await page.screenshot({ path: `${shots}/settings-off-${info.project.name}-light.png` });
  expect(aiRequests).toEqual([]);
});

test("the settings line where the device can", async ({ page }, info) => {
  await setup(page, "ok");
  await page.goto("/#settings/ai");
  const group = page.locator("#ai-device");
  await expect(group.locator("[data-device-ai]")).toHaveText("verfügbar");
  await expect(group).toContainText("Optional");
  if (shots) {
    await group.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/settings-${info.project.name}-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: `${shots}/settings-${info.project.name}-dark.png` });
  }
});

function assert(value: unknown): asserts value {
  expect(value).toBeTruthy();
}
