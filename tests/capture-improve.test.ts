// "Text verbessern" in quick capture (#172, lib/capture-improve.ts): title
// and text as one Markdown text for the writing assistant's "improve" and
// the answer split back; the existing endpoint (POST /api/ai/write) with the
// capture's target database as the page – refused where the AI may not read
// it, nothing saved – against a provider on this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-capture-improve-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.FLOWPLAN_ENCRYPTION_KEY;
delete process.env.FLOWPLAN_AI;
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { aiWriteResponse } = await import("../lib/ai/write");
const { captureImproveSource, parseCaptureImprove, captureImproveChanged, captureImprovable, CAPTURE_IMPROVE_LIMITS } = await import("../lib/capture-improve");
import type { Identity } from "../lib/types";

test("source: the title as heading over the text; either alone", () => {
  assert.equal(captureImproveSource({ title: "  Einkauf  morgen ", text: "milch, brot\r\n\r\n\r\n\r\nund käse  " }), "# Einkauf morgen\n\nmilch, brot\n\nund käse");
  assert.equal(captureImproveSource({ title: "Nur ein titel", text: "  " }), "# Nur ein titel");
  assert.equal(captureImproveSource({ title: "", text: "nur text" }), "nur text");
  assert.equal(captureImprovable({ title: " ", text: "\n" }), false);
  assert.equal(captureImprovable({ title: "x", text: "" }), true);
});

test("answer: the heading becomes the title, the rest the text", () => {
  const original = { title: "einkauf morgen", text: "milch brot und käse" };
  assert.deepEqual(parseCaptureImprove("# Einkauf morgen\n\nMilch, Brot und Käse.", original), { title: "Einkauf morgen", text: "Milch, Brot und Käse." });
  // Another heading level, emphasis, closing hashes, a code block around it.
  assert.deepEqual(parseCaptureImprove("```markdown\n## **Einkauf morgen** ##\nMilch, Brot und Käse.\n```", original), { title: "Einkauf morgen", text: "Milch, Brot und Käse." });
  // The heading dropped: the original title stays, all is text.
  assert.deepEqual(parseCaptureImprove("Milch, Brot und Käse.", original), { title: "einkauf morgen", text: "Milch, Brot und Käse." });
  // A title alone: the first line, with or without heading.
  assert.deepEqual(parseCaptureImprove("# Anruf bei Anna", { title: "anruf bei anna", text: "" }), { title: "Anruf bei Anna", text: "" });
  assert.deepEqual(parseCaptureImprove("Anruf bei Anna", { title: "anruf bei anna", text: "" }), { title: "Anruf bei Anna", text: "" });
  // Text alone: a heading in the answer stays text (there was no title).
  assert.deepEqual(parseCaptureImprove("# Notiz\nInhalt", { title: "", text: "notiz inhalt" }), { title: "", text: "# Notiz\nInhalt" });
  // While streaming: only the heading so far.
  assert.deepEqual(parseCaptureImprove("# Einkauf", original), { title: "Einkauf", text: "" });
  // Clipped to the form's limits.
  const long = parseCaptureImprove(`# ${"T".repeat(400)}\n\n${"x".repeat(25_000)}`, original);
  assert.equal(long.title.length, CAPTURE_IMPROVE_LIMITS.title);
  assert.equal(long.text.length, CAPTURE_IMPROVE_LIMITS.text);
  assert.equal(captureImproveChanged(original, { title: "einkauf  morgen", text: "milch brot und käse\n" }), false);
  assert.equal(captureImproveChanged(original, { title: "Einkauf morgen", text: "milch brot und käse" }), true);
});

// ---- The endpoint, with the capture's database as the page ----

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = { ...(await person("Ada")), isAdmin: true };
const ben = await person("Ben"),
  stranger = await person("Sam");
const wid = await createWorkspace(admin.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const inbox = await createPage(wid, space, admin.id, "Eingang", "database");

const asked: { system: string; user: string }[] = [];
let reply = "# Einkauf morgen\\n\\nMilch, Brot und Käse.";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const messages = (JSON.parse(body || "{}").messages || []) as { role: string; content: string }[];
    asked.push({ system: messages.find((m) => m.role === "system")?.content || "", user: messages.find((m) => m.role === "user")?.content || "" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: {"choices":[{"delta":{"content":"${reply}"}}]}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const never = new AbortController().signal;
const original = { title: "einkauf morgen", text: "milch brot und käse" };
const improve = (user: Identity, body: Record<string, unknown> = {}) =>
  aiWriteResponse(user, { pageId: inbox, action: "improve", text: captureImproveSource(original), locale: "de", ...body }, never);

test("the writing assistant's improve for a capture: title and text in, both back, nothing saved", async () => {
  await assert.rejects(improve(ben), /ausgeschaltet/, "AI off: refused");
  await command(admin, { action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: base, model: "m1", embeddingModel: "" } } });
  const rowsBefore = (await all("SELECT id FROM rows WHERE page_id=?", inbox)).length;
  const response = await improve(ben);
  assert.equal(response.status, 200);
  assert.deepEqual(parseCaptureImprove(await response.text(), original), { title: "Einkauf morgen", text: "Milch, Brot und Käse." });
  assert.match(asked[0].system, /Correct spelling, grammar and punctuation/);
  assert.match(asked[0].user, /<text>\n# einkauf morgen\n\nmilch brot und käse\n<\/text>/);
  assert.equal((await all("SELECT id FROM rows WHERE page_id=?", inbox)).length, rowsBefore, "nothing captured by it");
  // A Chinese interface (zh) is a locale the endpoint takes.
  reply = "# 购物\\n\\n牛奶";
  assert.equal((await improve(ben, { locale: "zh" })).status, 200);
});

test("refused where the AI may not run: feature off, database locked for the AI, no access", async () => {
  asked.length = 0;
  await command(ben, { action: "ai.settings", features: { write: false } });
  await assert.rejects(improve(ben), /in deinen Einstellungen ausgeschaltet/);
  await command(ben, { action: "ai.settings", features: { write: true } });
  await command(ben, { action: "ai.rule", targetId: inbox, mode: "exclude" });
  await assert.rejects(improve(ben), /für die KI gesperrt/);
  await command(ben, { action: "ai.rule", targetId: inbox, mode: null });
  await assert.rejects(improve(stranger), (e: Error & { status?: number }) => e.status === 403 || e.status === 404);
  assert.equal(asked.length, 0, "nothing reached the provider");
});

// ---- The desktop capture window: one field with shorthand ----

const { improveCapture, captureImproveMode, cleanImproved } = await import("../lib/ai/capture-improve");
const { lostCaptureTokens } = await import("../lib/capture-improve");
const { writePrompt } = await import("../lib/ai/prompts");
const { deviceWritePrompt } = await import("../lib/ai/device-prompts");
const shorthand = "angebot schreiben morgen 15 Uhr #kunde @anna !hoch";
const today = "2026-11-08";

test("shorthand: the prompt tells the model to keep it; lost tokens are found", () => {
  const prompt = writePrompt({ action: "improve", text: shorthand, locale: "de", capture: true });
  assert.match(prompt.system!, /#tags, @people, a priority/);
  assert.match(prompt.system!, /exactly as written/);
  assert.match(prompt.messages[0].content, /<text>\nangebot schreiben morgen 15 Uhr #kunde @anna !hoch\n<\/text>/);
  assert.doesNotMatch(writePrompt({ action: "improve", text: shorthand, locale: "de" }).system!, /#tags, @people/, "only for captures");
  assert.match(deviceWritePrompt({ action: "improve", text: shorthand, locale: "de", capture: true }).instructions, /exactly as written/);
  // Kept (other words around it): nothing lost.
  assert.deepEqual(lostCaptureTokens(shorthand, "Angebot schreiben, morgen 15 Uhr #kunde @anna !hoch", { today, locale: "de" }), []);
  // Changed or dropped: each as typed; a date only when it names another day or time.
  assert.deepEqual(lostCaptureTokens(shorthand, "Angebot schreiben morgen um 15 Uhr #Kunde @Anna", { today, locale: "de" }), ["#kunde", "@anna", "!hoch"]);
  assert.deepEqual(lostCaptureTokens(shorthand, "Angebot schreiben morgen 16 Uhr #kunde @anna !hoch", { today, locale: "de" }), ["morgen 15 Uhr"]);
  assert.deepEqual(lostCaptureTokens(`${shorthand} https://example.com/a`, "Angebot morgen 15 Uhr #kunde @anna !hoch https://example.com/b", { today, locale: "de" }), [
    "https://example.com/a",
  ]);
  assert.deepEqual(lostCaptureTokens("treffen morgen", "Treffen übermorgen", { today, locale: "de" }), ["morgen"]);
  assert.equal(cleanImproved("```\n„Angebot schreiben #kunde“\n```"), "Angebot schreiben #kunde");
});

test("POST /api/ai/capture/improve: the improved text with the shorthand checked, nothing saved", async () => {
  asked.length = 0;
  assert.deepEqual(await captureImproveMode(ben), { server: true, device: true });
  const rowsBefore = (await all("SELECT id FROM rows WHERE page_id=?", inbox)).length;
  reply = "Angebot schreiben morgen 15 Uhr #kunde @anna !hoch.";
  assert.deepEqual(await improveCapture(ben, { pageId: inbox, text: shorthand, today, locale: "de" }), { text: "Angebot schreiben morgen 15 Uhr #kunde @anna !hoch.", lost: [] });
  assert.match(asked[0].system, /exactly as written/);
  // A model that "corrects" the shorthand: reported.
  reply = "Angebot schreiben morgen 15 Uhr #Kunde @Anna, hohe Priorität.";
  assert.deepEqual(((await improveCapture(ben, { pageId: inbox, text: shorthand, today, locale: "de" })) as { lost: string[] }).lost,["#kunde", "@anna", "!hoch"]);
  assert.equal((await all("SELECT id FROM rows WHERE page_id=?", inbox)).length, rowsBefore, "nothing captured by it");
  await assert.rejects(improveCapture(ben, { pageId: inbox, text: "  ", today }), /Text eingeben/);
  // Locked for the AI, no access, the Mac's model switched off.
  await command(ben, { action: "ai.rule", targetId: inbox, mode: "exclude" });
  await assert.rejects(improveCapture(ben, { pageId: inbox, text: shorthand, today }), /für die KI gesperrt/);
  await command(ben, { action: "ai.rule", targetId: inbox, mode: null });
  await assert.rejects(improveCapture(stranger, { pageId: inbox, text: shorthand, today }), (e: Error & { status?: number }) => e.status === 403 || e.status === 404);
  assert.equal(asked.length, 2);
  // The Mac's model: the prompt (with the rules), then its answer checked – no AI run here.
  const { device } = (await improveCapture(ben, { pageId: inbox, text: shorthand, today, device: true })) as { device: { instructions: string; prompt: string } };
  assert.match(device.instructions, /exactly as written/);
  assert.match(device.prompt, /#kunde @anna !hoch/);
  assert.deepEqual(await improveCapture(ben, { pageId: inbox, text: shorthand, today, answer: "Angebot schreiben morgen 15 Uhr #kunde !hoch" }), { text: "Angebot schreiben morgen 15 Uhr #kunde !hoch", lost: ["@anna"] });
  await command(ben, { action: "ai.rule", targetId: inbox, mode: "exclude" });
  await assert.rejects(improveCapture(ben, { pageId: inbox, text: shorthand, today, device: true }), /für die KI gesperrt/);
  await command(ben, { action: "ai.rule", targetId: inbox, mode: null });
  assert.equal(asked.length, 2);
  // AI off for the person: no button.
  await command(ben, { action: "ai.settings", features: { write: false } });
  assert.equal(await captureImproveMode(ben), null);
  await command(ben, { action: "ai.settings", features: { write: true } });
});
