import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Large uploads (POST /api/upload, up to 10 GB): the body is streamed to
// disk (lib/multipart-stream.ts) instead of being read into memory, and the
// general 12 MB body limit of the API no longer applies to it. A 50 MB file
// goes up with an Idempotency-Key (hashed on the way, lib/idempotency.ts),
// comes back byte for byte (also by range), a retry is answered from the
// store, and a file above the person's limit is refused with 413.
test("a 50 MB upload streams to disk and comes back unchanged", async ({ browser }) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.setTimeout(120_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `large-upload:${uid}`, "Upload Admin", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 600000);
  const context = await browser.newContext();
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const request = context.request;
  const command = async (data: Record<string, unknown>) => {
    const response = await request.post(`${origin}/api/command`, { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const saved = (db.prepare("SELECT value FROM instance_settings WHERE key='maxUploadMb'").get() as { value: string } | undefined)?.value;
  try {
    await command({ action: "admin.settings", settings: { maxUploadMb: 10240 } });
    const workspace = (await command({ action: "workspace.create", name: `Große Dateien ${Date.now()}` })) as { id: string };
    const boot = await (await request.get(`${origin}/api/bootstrap?workspace=${workspace.id}`)).json();
    const page = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: "Video", kind: "document" })) as { id: string };

    const size = 50 * 1024 * 1024;
    const buffer = randomBytes(size);
    const upload = (key: string, data = buffer) =>
      request.post(`${origin}/api/upload`, {
        headers: { origin, "Idempotency-Key": key },
        // pageId before the file: a refusal comes before the file is read.
        multipart: { pageId: page.id, file: { name: "aufnahme.mp4", mimeType: "video/mp4", buffer: data } },
        timeout: 90_000,
      });
    const key = `large-${randomUUID()}`;
    const response = await upload(key);
    expect(response.status(), await response.text()).toBe(200);
    const file = (await response.json()) as { id: string; url: string; mime: string };
    // Not an MP4 by its content: stored as a plain download.
    expect(file.mime).toBe("application/octet-stream");
    const row = db.prepare("SELECT size FROM files WHERE id=?").get(file.id) as { size: number };
    expect(Number(row.size)).toBe(size);

    const whole = await request.get(`${origin}${file.url}`, { timeout: 60_000 });
    expect(whole.status()).toBe(200);
    expect(createHash("sha256").update(await whole.body()).digest("hex")).toBe(createHash("sha256").update(buffer).digest("hex"));
    const part = await request.get(`${origin}${file.url}`, { headers: { Range: `bytes=${size - 1000}-` } });
    expect(part.status()).toBe(206);
    expect((await part.body()).equals(buffer.subarray(size - 1000))).toBe(true);

    // The same request again: the stored answer, no second file.
    const retry = await upload(key);
    expect(retry.status()).toBe(200);
    expect(retry.headers()["idempotent-replayed"]).toBe("true");
    expect(((await retry.json()) as { id: string }).id).toBe(file.id);
    expect((db.prepare("SELECT COUNT(*) n FROM files WHERE page_id=?").get(page.id) as { n: number }).n).toBe(1);

    // Above the limit: 413, nothing stored, no temporary file left.
    await command({ action: "admin.settings", settings: { maxUploadMb: 20 } });
    const refused = await upload(`large-${randomUUID()}`);
    expect(refused.status()).toBe(413);
    expect(((await refused.json()) as { error: string }).error).toMatch(/20 MB/);
    expect((db.prepare("SELECT COUNT(*) n FROM files WHERE page_id=?").get(page.id) as { n: number }).n).toBe(1);
  } finally {
    await command({ action: "admin.settings", settings: { maxUploadMb: saved ? JSON.parse(saved) : 10 } }).catch(() => {});
    await context.close();
    db.close();
  }
});
