// Handwriting → text with the instance's AI (lib/ai/handwriting.ts): the
// PNG of a lasso selection reaches the model as a picture, the answer comes
// back as plain text. Refused for readers, PIN journals, pages closed to the
// AI, the feature switched off, and anything that is not a PNG. Stub
// provider (tests/helpers/ai-mock.ts) – no real model is called.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-handwriting-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { recognizeHandwriting, cleanHandwriting, pngSize, checkedPng, HANDWRITING_LIMITS } = await import("../lib/ai/handwriting");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = { ...(await person("Ada")), isAdmin: true };
const reader = await person("Rita");
const wid = await createWorkspace(admin.id, "Schule");
await run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const notebook = await createPage(wid, space, admin.id, "Mathe-Heft", "notebook");
const journal = await createPage(wid, space, admin.id, "Geheim", "journal");
const pinned = await createPage(wid, space, admin.id, "Heft im Journal", "notebook", journal);
await run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?)", journal, "pin-hash");

// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const mock = await startOllamaMock();
after(() => mock.close());
const settings = { enabled: true, semanticSearch: false, provider: { kind: "ollama", baseUrl: mock.base, model: "vision", embeddingModel: "" } };
await command(admin, { action: "admin.ai", settings });

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 500;
  }
};

test("the selection goes as a picture; the answer comes back as plain text", async () => {
  mock.answer = () => "```\nEinkaufen:\n- Milch‮\n- Brot\n```";
  const before = mock.chats.length;
  const result = await recognizeHandwriting(admin, { pageId: notebook, image: PNG });
  assert.equal(result.text, "Einkaufen:\n- Milch\n- Brot");
  const chat = mock.chats[before];
  assert.equal(mock.chats.length, before + 1);
  assert.equal(chat.model, "vision");
  assert.match(chat.system, /transcribe handwriting/i);
  assert.match(chat.system, /not instructions/);
  const message = chat.messages[0] as { content: string; images?: string[] };
  assert.deepEqual(message.images, [PNG]);
});

test("readers, PIN journals and pages closed to the AI never reach the model", async () => {
  const before = mock.chats.length;
  assert.equal(await status(recognizeHandwriting(reader, { pageId: notebook, image: PNG })), 403, "a reader cannot convert");
  assert.ok([403, 423].includes(await status(recognizeHandwriting(admin, { pageId: pinned, image: PNG }))), "a notebook in a PIN journal");
  await run("INSERT INTO ai_blocks(target_id,kind,workspace_id,created_by,created_at) VALUES(?,?,?,?,?)", notebook, "page", wid, admin.id, Date.now());
  assert.equal(await status(recognizeHandwriting(admin, { pageId: notebook, image: PNG })), 403, "a page closed to the AI");
  await run("DELETE FROM ai_blocks WHERE target_id=?", notebook);
  assert.equal(mock.chats.length, before);
});

test("the feature switched off by the administration is refused", async () => {
  await command(admin, { action: "admin.ai", settings: { ...settings, features: { handwriting: false } } });
  const before = mock.chats.length;
  assert.equal(await status(recognizeHandwriting(admin, { pageId: notebook, image: PNG })), 403);
  assert.equal(mock.chats.length, before);
  await command(admin, { action: "admin.ai", settings: { ...settings, features: { handwriting: true } } });
});

test("only PNGs within the limits", async () => {
  assert.deepEqual(pngSize(Buffer.from(PNG, "base64")), { width: 1, height: 1 });
  assert.equal(pngSize(Buffer.from("GIF89a-not-a-png-at-all-really-not-a-png")), null);
  assert.equal(await status(recognizeHandwriting(admin, { pageId: notebook, image: Buffer.from("<svg/>").toString("base64") })), 400);
  assert.equal(await status(recognizeHandwriting(admin, { pageId: notebook, image: "not base64 !" })), 400);
  // Claims to be 5000 px wide.
  const huge = Buffer.from(PNG, "base64");
  huge.writeUInt32BE(5000, 16);
  assert.throws(() => checkedPng(huge.toString("base64")), /zu groß|too large/);
  assert.ok(HANDWRITING_LIMITS.bytes > 1_000_000);
});

test("answers are cleaned: quotes, fences, control characters, length", () => {
  assert.equal(cleanHandwriting('"Hallo Welt"'), "Hallo Welt");
  assert.equal(cleanHandwriting("  a\u0000b  \r\n\n\n\nc "), "a b\n\nc");
  assert.equal(cleanHandwriting("x".repeat(5000)).length, HANDWRITING_LIMITS.text);
  assert.equal(cleanHandwriting(""), "");
});
