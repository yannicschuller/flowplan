// The device-token routes of the mobile apps (app/api/mobile, Bearer fpd_…)
// during an instance move (lib/instance-read-only.ts): every change is
// refused with 423 while the source is frozen or has moved, reads and the
// widget data refresh keep working, and changes work again once unfrozen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-mobile-read-only-"));
process.env.FLOWPLAN_OCR = "0";
const { id, one, run } = await import("../lib/db");
const { bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { registerMobileDevice } = await import("../lib/mobile-devices");
const { MOVE_KEY } = await import("../lib/instance-read-only");
const capture = await import("../app/api/mobile/capture/[action]/route");
const widgets = await import("../app/api/mobile/widgets/[action]/route");
const intents = await import("../app/api/mobile/intents/[action]/route");
const notifications = await import("../app/api/mobile/notifications/route");
const mobile = await import("../app/api/mobile/[action]/route");

const uid = id(),
  session = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "phone", "phone@example.test");
await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", session, uid, "[]", Date.now() + 3600000);
const user = { id: uid, name: "phone", email: "phone@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
const { deviceToken } = await registerMobileDevice(user, session, { installationId: randomUUID(), platform: "ios" });
const wid = await createWorkspace(uid, "Phone");
await bootstrap(user, wid);
const authorization = `Bearer ${deviceToken}`;
const ctx = (action: string) => ({ params: Promise.resolve({ action }) });
const post = (path: string, body: unknown) =>
  new Request(`http://localhost/api/mobile/${path}`, { method: "POST", headers: { authorization, "accept-language": "en" }, body: JSON.stringify(body) });
const get = (path: string) => new Request(`http://localhost/api/mobile/${path}`, { headers: { authorization } });
const freeze = (state: Record<string, unknown> | null) =>
  state
    ? run("INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", MOVE_KEY, JSON.stringify(state))
    : run("DELETE FROM instance_settings WHERE key=?", MOVE_KEY);
const pageCount = async () => (await one<{ n: number }>("SELECT COUNT(*) AS n FROM pages"))!.n;

test("device-token changes are refused with 423 while the instance is frozen or has moved", async () => {
  for (const state of [{ readOnlyAt: Date.now() }, { readOnlyAt: Date.now(), movedTo: "https://new.example.test" }]) {
    await freeze(state);
    const pages = await pageCount();
    const refused = [
      await capture.POST(post("capture/save", { kind: "note", title: "Frozen note", text: "x" }), ctx("save")),
      await widgets.POST(post("widgets/action", { action: "mention.readAll" }), ctx("action")),
      await intents.POST(post("intents/focus", { workspaceId: wid, hide: true }), ctx("focus")),
      await notifications.POST(post("notifications", { action: "read", notificationId: "nope" })),
      await mobile.POST(post("unregister", {}), ctx("unregister")),
      await mobile.POST(post("live-activity", { kind: "focus", relayToken: null }), ctx("live-activity")),
    ];
    for (const response of refused) {
      assert.equal(response.status, 423, response.url);
      assert.match(((await response.json()) as { error: string }).error, /read-only|moved to|schreibgeschützt|umgezogen/);
    }
    assert.equal(await pageCount(), pages, "nothing was saved");
    // Reads and the widget data refresh (a read sent with a body) still work.
    assert.equal((await capture.GET(get("capture/targets"), ctx("targets"))).status, 200);
    assert.equal((await intents.GET(get("intents/workspaces"), ctx("workspaces"))).status, 200);
    assert.equal((await widgets.POST(post("widgets/data", { today: "2026-11-10", zone: "UTC", widgets: [{ kind: "calendar", config: {} }] }), ctx("data"))).status, 200);
  }
  // The device stays registered and works again once the move is called off.
  await freeze(null);
  assert.equal((await intents.POST(post("intents/focus", { workspaceId: wid, hide: true }), ctx("focus"))).status, 200);
  assert.equal((await widgets.POST(post("widgets/action", { action: "mention.readAll" }), ctx("action"))).status, 200);
});
